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

console.log("\n[A1] scopeCovers — сервис целиком (обратная совместимость, bare-service scope)");
check("'all' покрывает всё", scopeCovers("all", "sheets", "sheets_write_range"));
check("'sheets' покрывает sheets (bare-service, старые окна работают на ЛЮБОЙ метод)", scopeCovers("sheets", "sheets", "sheets_write_range"));
check("'sheets' покрывает и ДРУГОЙ метод sheets", scopeCovers("sheets", "sheets", "sheets_append_rows"));
check("'gmail,sheets,docs' покрывает sheets (csv)", scopeCovers("gmail,sheets,docs", "sheets", "sheets_write_range"));
check("'gmail,docs' НЕ покрывает sheets", !scopeCovers("gmail,docs", "sheets", "sheets_write_range"));
check("подстрока не матчит ('google-sheets' ≠ 'sheets')", !scopeCovers("google-sheets", "sheets", "sheets_write_range"));
check("пустой scope не покрывает ничего", !scopeCovers("", "sheets", "sheets_write_range"));

console.log("\n[A1b] scopeCovers — новые токены service:tool (ТЗ TZ_automation_key_method_catalog.md)");
check(
  "'sheets:sheets_write_range' покрывает ИМЕННО этот метод",
  scopeCovers("sheets:sheets_write_range", "sheets", "sheets_write_range"),
);
check(
  "'sheets:sheets_write_range' НЕ покрывает другой метод того же сервиса",
  !scopeCovers("sheets:sheets_write_range", "sheets", "sheets_append_rows"),
);
check(
  "общий префикс без разделителя не матчит другой метод ('gmail:gmail_send' ≠ tool 'gmail_send_all')",
  !scopeCovers("gmail:gmail_send", "gmail", "gmail_send_all"),
);
check(
  "csv-смесь bare-service + method-scope: 'docs,sheets:sheets_write_range' покрывает sheets_write_range",
  scopeCovers("docs,sheets:sheets_write_range", "sheets", "sheets_write_range"),
);
check(
  "та же смесь НЕ покрывает sheets_append_rows (sheets тут не bare, только method-scope)",
  !scopeCovers("docs,sheets:sheets_write_range", "sheets", "sheets_append_rows"),
);

console.log("\n[A2] makeCheckAutomationKey — фейковый store, управляемые часы, теперь принимает (key, tool)");
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
  rows.set(sha256Hex("METHOD-ONLY"), { scope: "sheets:sheets_write_range", expiresAt: NOW + 1000, revokedAt: null });

  const rGoodAll = await check_("GOOD-ALL", "sheets_write_range");
  check("scope=all → ok:true", rGoodAll.ok === true, JSON.stringify(rGoodAll));
  check("channel присутствует", typeof rGoodAll.channel === "string");

  const rGoodSheets = await check_("GOOD-SHEETS", "sheets_write_range");
  check("bare-service scope содержит sheets → ok:true для sheets_write_range", rGoodSheets.ok === true, JSON.stringify(rGoodSheets));
  const rGoodSheets2 = await check_("GOOD-SHEETS", "sheets_append_rows");
  check("тот же bare-service scope → ok:true и для ДРУГОГО метода sheets (обратная совместимость)", rGoodSheets2.ok === true, JSON.stringify(rGoodSheets2));

  const rWrong = await check_("WRONG-SCOPE", "sheets_write_range");
  check("scope не покрывает sheets → ok:false (не ошибка)", rWrong.ok === false, JSON.stringify(rWrong));

  const rExpired = await check_("EXPIRED", "sheets_write_range");
  check("истёкшее окно → ok:false", rExpired.ok === false);

  const rRevoked = await check_("REVOKED", "sheets_write_range");
  check("отозванное окно → ok:false", rRevoked.ok === false);

  const rUnknown = await check_("no-such-key-at-all", "sheets_write_range");
  check("неизвестный ключ → ok:false (не throw)", rUnknown.ok === false);

  const rEmpty = await check_("", "sheets_write_range");
  check("пустой ключ → ok:false", rEmpty.ok === false);

  // Ключевой новый тест (ТЗ, тестовый план п.4): ключ со scope на КОНКРЕТНЫЙ
  // метод пропускает вызов ИМЕННО этого метода и НЕ пропускает другой
  // гейтированный метод того же сервиса.
  const rMethodOk = await check_("METHOD-ONLY", "sheets_write_range");
  check("scope='sheets:sheets_write_range' → ok:true для sheets_write_range", rMethodOk.ok === true, JSON.stringify(rMethodOk));
  const rMethodOther = await check_("METHOD-ONLY", "sheets_append_rows");
  check("тот же scope → ok:false для ДРУГОГО метода того же сервиса (sheets_append_rows)", rMethodOther.ok === false, JSON.stringify(rMethodOther));
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

// [B5] requireConsent actually forwards `tool` to checkAutomationKey as the
// SECOND argument (ТЗ раздел 4) — proven end-to-end via a method-scoped
// checkAutomationKey that only says ok for THIS specific tool name.
{
  const calls = [];
  const { cli, counters } = await harness(async (key, tool) => {
    calls.push({ key, tool });
    return key === "METHOD-KEY" && tool === "sheets_write_range" ? { ok: true, channel: "window" } : { ok: false };
  });
  const resp = await cli.callTool({
    name: "sheets_write_range",
    arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["x"]] }], automation_key: "METHOD-KEY" },
  });
  check("checkAutomationKey was called with tool='sheets_write_range'", calls.some((c) => c.key === "METHOD-KEY" && c.tool === "sheets_write_range"), JSON.stringify(calls));
  check("mutation happened (method-scoped key matched this tool)", counters.valuesUpdate === 1, String(counters.valuesUpdate));
  check("response executed directly, not a plan", !text(resp).includes("### 📤 План"), text(resp).slice(0, 60));
}

// [B6] same method-scoped key called against a DIFFERENT tool name is
// exercised at the automation_key.ts layer already in [A2]; here we confirm
// the live tool path passes its OWN name (not some other tool's), i.e. a
// checkAutomationKey gated to "sheets_append_rows" does NOT unlock
// "sheets_write_range" through the live call.
{
  const { cli, counters } = await harness(async (key, tool) => (key === "OTHER-METHOD-KEY" && tool === "sheets_append_rows" ? { ok: true, channel: "window" } : { ok: false }));
  const resp = await cli.callTool({
    name: "sheets_write_range",
    arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["x"]] }], automation_key: "OTHER-METHOD-KEY" },
  });
  check("no mutation — key is scoped to a different tool", counters.valuesUpdate === 0);
  check("falls through to a plan preview", text(resp).includes("### 📤 План"), text(resp).slice(0, 60));
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
