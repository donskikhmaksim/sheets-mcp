#!/usr/bin/env node
/**
 * automation_key — ТЗ `docs/TZ_automation_key_consent_gate.md`.
 *
 * Two layers:
 *  [A] `src/automation_key.ts` in isolation — `scopeCovers` +
 *      `makeCheckAutomationKey` against a fake `tg_automation_windows` lookup
 *      (no Postgres, no gmail-mcp — pure DI, same style as test-consent.mjs).
 *  [B] a REAL registered tool (`sheets_write_range`) actually accepts
 *      `automation_key` in its zod schema and passes it through to
 *      `requireConsent` — a mocked `checkAutomationKey` in the consent
 *      context proves the bypass at the TOOL level, not just inside
 *      consent.ts's own unit test (тестовый план п.7).
 *
 * Usage: node scripts/test-automation-key.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSheetsTools } from "../dist/tools/sheets.js";
import { registerAccountTools } from "../dist/accounts.js";
import { scopeCovers, makeCheckAutomationKey, sha256Hex, AUTOMATION_SERVICE } from "../dist/automation_key.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

// ═══ [A] automation_key.ts в изоляции ════════════════════════════════════════

console.log("\n[A0] AUTOMATION_SERVICE — канонично 'sheets'");
check("AUTOMATION_SERVICE === 'sheets'", AUTOMATION_SERVICE === "sheets");

console.log("\n[A1] scopeCovers");
check("'all' покрывает всё", scopeCovers("all", "sheets"));
check("'sheets' покрывает sheets", scopeCovers("sheets", "sheets"));
check("'gmail,sheets,docs' покрывает sheets (csv)", scopeCovers("gmail,sheets,docs", "sheets"));
check("'gmail,docs' НЕ покрывает sheets", !scopeCovers("gmail,docs", "sheets"));
check("подстрока не матчит ('google-sheets' ≠ 'sheets')", !scopeCovers("google-sheets", "sheets"));
check("пустой scope не покрывает ничего", !scopeCovers("", "sheets"));

console.log("\n[A2] makeCheckAutomationKey — фейковый store, управляемые часы");
{
  const NOW = 1_700_000_000_000;
  const now = () => NOW;
  const rows = new Map(); // tokenHash -> row
  const store = { async getAutomationWindowByTokenHash(h) { return rows.get(h) ?? null; } };
  const check_ = makeCheckAutomationKey(store, now);

  rows.set(sha256Hex("GOOD-ALL"), { scope: "all", expiresAt: NOW + 1000, revokedAt: null });
  rows.set(sha256Hex("GOOD-SHEETS"), { scope: "gmail,sheets", expiresAt: NOW + 1000, revokedAt: null });
  rows.set(sha256Hex("WRONG-SCOPE"), { scope: "gmail,docs", expiresAt: NOW + 1000, revokedAt: null });
  rows.set(sha256Hex("EXPIRED"), { scope: "all", expiresAt: NOW - 1, revokedAt: null });
  rows.set(sha256Hex("REVOKED"), { scope: "all", expiresAt: NOW + 1000, revokedAt: NOW - 1 });

  const rGoodAll = await check_("GOOD-ALL");
  check("scope=all → ok:true", rGoodAll.ok === true, JSON.stringify(rGoodAll));
  check("channel присутствует", typeof rGoodAll.channel === "string");

  const rGoodSheets = await check_("GOOD-SHEETS");
  check("scope содержит sheets → ok:true", rGoodSheets.ok === true, JSON.stringify(rGoodSheets));

  const rWrong = await check_("WRONG-SCOPE");
  check("scope не покрывает sheets → ok:false (не ошибка)", rWrong.ok === false, JSON.stringify(rWrong));

  const rExpired = await check_("EXPIRED");
  check("истёкшее окно → ok:false", rExpired.ok === false);

  const rRevoked = await check_("REVOKED");
  check("отозванное окно → ok:false", rRevoked.ok === false);

  const rUnknown = await check_("no-such-key-at-all");
  check("неизвестный ключ → ok:false (не throw)", rUnknown.ok === false);

  const rEmpty = await check_("");
  check("пустой ключ → ok:false", rEmpty.ok === false);
}

// ═══ [B] живой инструмент: sheets_write_range принимает automation_key ══════

console.log("\n[B] sheets_write_range: automation_key реально принимается схемой и доходит до requireConsent");

function buildClients(counters) {
  return {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      sheets: {
        spreadsheets: {
          get: async () => ({
            data: {
              properties: { title: "My Sheet" },
              sheets: [{ properties: { sheetId: 0, title: "Sheet1" }, data: [{ startRow: 0, startColumn: 0, rowData: [] }] }],
            },
          }),
          values: {
            get: async () => ({ data: { values: [] } }),
            update: async ({ range }) => {
              counters.valuesUpdate++;
              return { data: { updatedRange: range, updatedCells: 1 } };
            },
            batchUpdate: async () => {
              counters.valuesUpdate++;
              return { data: { responses: [{ updatedRange: "Sheet1!A1", updatedCells: 1 }] } };
            },
          },
        },
      },
      drive: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    baseGmailQuery: () => "",
  };
}

async function harness(checkAutomationKey) {
  const counters = { valuesUpdate: 0 };
  const clients = buildClients(counters);
  const manifests = new Map();
  const audits = [];
  const consentStore = {
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
      r.status = "DONE";
      r.userReply = userReply;
      return { ...r };
    },
    async invalidateManifest() {},
    async appendConsentAudit(entry) { audits.push({ ...entry }); },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
  const consentCtx = {
    consentStore,
    consentCfg: { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10 },
    auditStore: null,
    checkAutomationKey,
  };
  const server = new McpServer({ name: "automation-key-tool-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, counters, manifests, audits };
}

// [B1] schema exposes automation_key on a real gated tool
{
  const { cli } = await harness(async () => ({ ok: false }));
  const tools = (await cli.listTools()).tools;
  const t = tools.find((x) => x.name === "sheets_write_range");
  check("sheets_write_range schema exposes automation_key", "automation_key" in (t?.inputSchema?.properties ?? {}), JSON.stringify(Object.keys(t?.inputSchema?.properties ?? {})));
}

// [B2] valid automation_key on the LIVE tool call → mutation happens with a
// SINGLE call, no manifest_id/user_reply round-trip at all.
{
  const { cli, counters, manifests, audits } = await harness(async (key) => (key === "LIVE-GOOD" ? { ok: true, channel: "window" } : { ok: false }));
  const resp = await cli.callTool({
    name: "sheets_write_range",
    arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["x"]] }], automation_key: "LIVE-GOOD" },
  });
  check("mutation actually happened (valuesUpdate incremented)", counters.valuesUpdate === 1, String(counters.valuesUpdate));
  check("response is NOT a plan (executed directly)", !text(resp).includes("### 📤 План"), text(resp).slice(0, 60));
  check("no manifest was ever created", manifests.size === 0);
  check("audit carries actor=automation for this tool", audits.some((a) => a.actor === "automation" && a.tool === "sheets_write_range"));
}

// [B3] invalid automation_key on the LIVE tool call → falls through to the
// normal plan phase (no mutation, response is a plan preview).
{
  const { cli, counters } = await harness(async () => ({ ok: false }));
  const resp = await cli.callTool({
    name: "sheets_write_range",
    arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["x"]] }], automation_key: "GARBAGE" },
  });
  check("no mutation on invalid key", counters.valuesUpdate === 0);
  check("falls through to a plan preview, not an error", text(resp).includes("### 📤 План"), text(resp).slice(0, 60));
}

// [B4] no automation_key at all (regular human call) → unchanged behaviour,
// even with checkAutomationKey wired up.
{
  const { cli, counters } = await harness(async () => ({ ok: true, channel: "window" }));
  const resp = await cli.callTool({
    name: "sheets_write_range",
    arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["x"]] }] },
  });
  check("no automation_key → still a plan (DI presence alone changes nothing)", text(resp).includes("### 📤 План"));
  check("no mutation", counters.valuesUpdate === 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
