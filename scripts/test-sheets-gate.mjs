#!/usr/bin/env node
/**
 * End-to-end gate behaviour on real sheets-mcp tools (ported pattern from
 * gmail-mcp's scripts/test-a3-gate.mjs / test-t1-gate.mjs, condensed to the
 * representative scenarios mcp-development-standard T2 asks for: 2-3 full
 * plan→confirm→mutate→post-verify round trips, PLUS the binding-drift proof
 * that rehash is real (not `sha256(payload)` in disguise — gate.md §3.3(2)).
 *
 * Uses an in-memory fake Google Sheets API with a MUTABLE cell store, so
 * "someone edited the range between plan and execute" can be simulated by
 * mutating the fake store directly between two tool calls.
 *
 * Usage: node scripts/test-sheets-gate.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSheetsTools } from "../dist/tools/sheets.js";
import { registerTriageTools } from "../dist/tools/triage.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

// ── fake Sheets API with a real mutable backing store ───────────────────────

function makeSheetWorld() {
  // spreadsheetId -> range-string -> 2D values
  const ranges = new Map([["S1", new Map([["Sheet1!A1", [["old"]]]])]]);
  const titles = new Map([["S1", "My Sheet"]]);
  const tabs = new Map([["S1", ["Sheet1"]]]);
  return { ranges, titles, tabs };
}

function buildClients(world) {
  return {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      sheets: {
        spreadsheets: {
          get: async ({ spreadsheetId, fields }) => {
            if (fields?.includes("sheets.properties.title")) {
              return { data: { sheets: (world.tabs.get(spreadsheetId) ?? []).map((t) => ({ properties: { title: t } })) } };
            }
            return { data: { properties: { title: world.titles.get(spreadsheetId) ?? null } } };
          },
          batchUpdate: async () => ({ data: { replies: [{ addSheet: { properties: { sheetId: 1, title: "New tab" } } }] } }),
          values: {
            get: async ({ spreadsheetId, range }) => ({ data: { values: world.ranges.get(spreadsheetId)?.get(range) ?? [] } }),
            update: async ({ spreadsheetId, range, requestBody }) => {
              const m = world.ranges.get(spreadsheetId) ?? new Map();
              m.set(range, requestBody.values);
              world.ranges.set(spreadsheetId, m);
              return { data: { updatedRange: range, updatedCells: requestBody.values.flat().length } };
            },
            clear: async ({ spreadsheetId, range }) => {
              const m = world.ranges.get(spreadsheetId) ?? new Map();
              m.set(range, []);
              world.ranges.set(spreadsheetId, m);
              return { data: { clearedRange: range } };
            },
          },
        },
      },
      drive: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    baseGmailQuery: () => "",
  };
}

async function harness(world) {
  const clients = buildClients(world);
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
      if (Date.now() >= r.expiresAt) return null;
      r.status = "DONE";
      r.userReply = userReply;
      return { ...r };
    },
    async invalidateManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (r && r.server === server && r.status === "AWAITING_CONSENT") {
        r.status = "INVALIDATED";
        r.userReply = userReply;
      }
    },
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
  const consentCtx = { consentStore, consentCfg: { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 }, auditStore: null };
  const server = new McpServer({ name: "sheets-gate-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  registerTriageTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, manifests, world };
}

function extractManifestId(planText) {
  const m = /план `([a-f0-9-]+)`/.exec(planText);
  return m?.[1];
}

// ── [1] happy path: sheets_write_range plan → confirm → mutation → ✅ ───────
console.log("\n[1] sheets_write_range: full plan→confirm round trip, mutation lands, post-verify ✅");
{
  const world = makeSheetWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_write_range", arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["new value"]] }] } });
  const planBody = text(planResp);
  check("plan mentions old content will be overwritten", planBody.includes("будут перезаписаны"), planBody.slice(0, 200));
  check("world NOT mutated yet", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "old");
  const manifestId = extractManifestId(planBody);
  check("manifest id extracted from preview", !!manifestId, planBody.slice(0, 200));

  const execResp = await cli.callTool({ name: "sheets_write_range", arguments: { manifest_id: manifestId, user_reply: "да, пиши" } });
  const execBody = text(execResp);
  check("execute succeeds — summary shows 1/1, no error", execBody.includes('"summary": "✏️ Written 1/1"'), execBody.slice(0, 60));
  check("world IS mutated", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "new value");
  check("post-verify report attached with ✅", execBody.includes("Независимая проверка записи") && execBody.includes("✅"));
}

// ── [2] binding drift: someone edits the range between plan and execute ─────
console.log("\n[2] sheets_write_range: range edited between plan and execute → 🛑, NOT mutated (real rehash, not sha256(payload))");
{
  const world = makeSheetWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_write_range", arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["new value"]] }] } });
  const manifestId = extractManifestId(text(planResp));

  // Simulate a concurrent edit landing between plan and execute.
  world.ranges.get("S1").set("Sheet1!A1", [["someone else's edit"]]);

  const execResp = await cli.callTool({ name: "sheets_write_range", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("refused with 🛑", execBody.includes("🛑"), execBody.slice(0, 60));
  check("refusal names state change", execBody.includes("изменилось"), execBody.slice(0, 200));
  check("the concurrent edit is UNTOUCHED (write never happened)", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "someone else's edit");
}

// ── [3] negation invalidates: sheets_clear_range ─────────────────────────────
console.log("\n[3] sheets_clear_range: user says 'нет' → 🛑 отменено, range untouched, manifest re-use fails");
{
  const world = makeSheetWorld();
  world.ranges.get("S1").set("Sheet1!A1", [["precious data"]]);
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_clear_range", arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1" }] } });
  const planBody = text(planResp);
  check("plan warns what will be erased", planBody.includes("precious data"), planBody.slice(0, 200));
  const manifestId = extractManifestId(planBody);

  const noResp = await cli.callTool({ name: "sheets_clear_range", arguments: { manifest_id: manifestId, user_reply: "нет, стоп" } });
  check("negation → 🛑 Отменено", text(noResp).includes("Отменено"), text(noResp).slice(0, 80));
  check("data untouched after negation", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "precious data");

  const retryResp = await cli.callTool({ name: "sheets_clear_range", arguments: { manifest_id: manifestId, user_reply: "да" } });
  check("re-using an invalidated manifest still fails", text(retryResp).includes("🛑"), text(retryResp).slice(0, 60));
  check("data STILL untouched", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "precious data");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
