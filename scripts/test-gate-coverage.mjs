#!/usr/bin/env node
/**
 * Reflexive gate-coverage test (ported from gmail-mcp's
 * scripts/test-gate-coverage.mjs — mcp-development-standard
 * `references/development-pipeline.md`, T2 checklist item 4).
 *
 * Does NOT hand-pick which tools to exercise. It lists the tools from the
 * REAL registered MCP registry (`client.listTools()`, i.e. what a model
 * actually sees) and, for every tool classified as a write (no
 * `readOnlyHint: true` — the exact rule the task specifies), checks it
 * against an explicit allowlist:
 *
 *  - every entry in `GATED_TOOLS` gets a real BEHAVIOURAL check: calling it
 *    WITHOUT manifest_id/user_reply must not reach ANY mutating fake API
 *    call, and the response must look like a plan, not a success header;
 *  - everything else that is a write MUST be named in
 *    `UNGATED_WRITE_ALLOWLIST` below, with a one-line reason.
 *
 * Per Maksim's standing decision (2026-08-04, "гейт у ВСЕХ write, без
 * исключений") this repo's UNGATED_WRITE_ALLOWLIST is EMPTY — every write
 * tool in sheets-mcp/triage.ts is gated. A new write tool landing here
 * without going through requireConsent breaks CI instead of shipping
 * silently ungated.
 *
 * Usage: node scripts/test-gate-coverage.mjs
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

// Empty by design — Maksim's decision: gate ALL write tools, no exceptions
// (unlike gmail-mcp's 2-entry allowlist for genuinely-protective/read-ish
// tools; sheets-mcp/triage.ts has no such candidates).
const UNGATED_WRITE_ALLOWLIST = {};

/** Every gated write tool, with args that reach its plan phase, which
 * counter must stay at 0 after a plan-only call, and the expected
 * destructiveHint (irreversible — clear_range/find_replace/raw_batch_update —
 * vs additive/reversible — everything else). */
const GATED_TOOLS = {
  sheets_write_range: {
    args: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["x"]] }] },
    counterKey: "valuesUpdate",
    destructive: true,
  },
  sheets_append_rows: {
    args: { items: [{ spreadsheetId: "S1", range: "Sheet1", values: [["x"]] }] },
    counterKey: "valuesAppend",
    destructive: false,
  },
  sheets_clear_range: {
    args: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1:B2" }] },
    counterKey: "valuesClear",
    destructive: true,
  },
  sheets_create: {
    args: { spreadsheets: [{ title: "New sheet" }] },
    counterKey: "spreadsheetsCreate",
    destructive: false,
  },
  sheets_add_tab: {
    args: { items: [{ spreadsheetId: "S1", title: "New tab" }] },
    counterKey: "batchUpdate",
    destructive: false,
  },
  sheets_find_replace: {
    args: { spreadsheetId: "S1", find: "foo", replace: "bar" },
    counterKey: "batchUpdate",
    destructive: true,
  },
  sheets_format_range: {
    args: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", bold: true }] },
    counterKey: "batchUpdate",
    destructive: false,
  },
  sheets_raw_batch_update: {
    args: { spreadsheetId: "S1", requests: [{ addSheet: { properties: { title: "X" } } }] },
    counterKey: "batchUpdate",
    destructive: true,
  },
  triage_log_add: {
    args: { rows: [{ from: "a@x.com", subject: "S", claudeSuggested: "archive" }] },
    counterKey: "valuesAppend",
    destructive: false,
  },
  triage_log_update: {
    args: { id: 1, status: "done" },
    counterKey: "batchUpdate",
    destructive: false,
  },
};

// ── fakes ─────────────────────────────────────────────────────────────────

function makeConsentStore() {
  const manifests = new Map();
  return {
    manifests,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest() {
      return null; // this test never confirms — only the plan phase is exercised
    },
    async invalidateManifest() {},
    async appendConsentAudit() {},
    async updateConsentAuditOutcome() {},
  };
}
const CONSENT_CFG = { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10 };

function makeCounters() {
  return { valuesUpdate: 0, valuesAppend: 0, valuesClear: 0, spreadsheetsCreate: 0, batchUpdate: 0 };
}

function buildClients(counters) {
  // Triage log's target ("Triage Log" tab) needs consistent rows for
  // update-plan's identity lookup (row ID 1) — values.get always returns a
  // header + one data row when the range mentions "Triage Log" or "A:I".
  const triageRows = [
    ["ID", "Date", "Account", "From", "Subject", "Claude Suggested", "Maksim Said", "Why Not Closed", "Status"],
    ["1", "2026-08-04", "work", "a@x.com", "Existing subject", "archive", "", "", "pending"],
  ];
  return {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      sheets: {
        spreadsheets: {
          get: async ({ ranges }) => {
            if (ranges?.some((r) => String(r).includes("Triage Log"))) {
              return { data: { sheets: [{ properties: { sheetId: 0, title: "Triage Log" } }] } };
            }
            return {
              data: {
                properties: { title: "Existing spreadsheet" },
                sheets: [{ properties: { sheetId: 0, title: "Sheet1" }, data: [{ startRow: 0, startColumn: 0, rowData: [] }] }],
              },
            };
          },
          create: async ({ requestBody }) => {
            counters.spreadsheetsCreate++;
            return { data: { spreadsheetId: "NEW" + counters.spreadsheetsCreate, properties: { title: requestBody?.properties?.title }, spreadsheetUrl: "https://example.com" } };
          },
          batchUpdate: async () => {
            counters.batchUpdate++;
            return { data: { replies: [{ addSheet: { properties: { sheetId: 1, title: "New tab" } } }, { findReplace: { occurrencesChanged: 0 } }] } };
          },
          values: {
            get: async ({ range }) => {
              if (String(range).includes("Triage Log")) return { data: { values: triageRows } };
              return { data: { values: [] } };
            },
            update: async ({ range }) => {
              counters.valuesUpdate++;
              return { data: { updatedRange: range, updatedCells: 1 } };
            },
            batchUpdate: async () => {
              counters.valuesUpdate++;
              return { data: { responses: [{ updatedRange: "Sheet1!A1", updatedCells: 1 }] } };
            },
            append: async ({ range }) => {
              counters.valuesAppend++;
              return { data: { updates: { updatedRange: range } } };
            },
            clear: async ({ range }) => {
              counters.valuesClear++;
              return { data: { clearedRange: range } };
            },
          },
        },
      },
      drive: {
        files: { list: async () => ({ data: { files: [] } }) },
      },
    }),
    baseGmailQuery: () => "",
  };
}

async function harness() {
  const counters = makeCounters();
  const clients = buildClients(counters);
  const consentStore = makeConsentStore();
  const consentCtx = { consentStore, consentCfg: CONSENT_CFG, auditStore: null };
  const server = new McpServer({ name: "gate-coverage", version: "0" });
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  registerTriageTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, counters };
}

// ═══ enumerate the REAL registry, classify, and cross-check ═════════════════

console.log("\n[1] enumerate registered tools from the real MCP registry (client.listTools())");
const { cli, counters } = await harness();
const tools = (await cli.listTools()).tools;
check("registry is non-empty (sanity)", tools.length > 10, String(tools.length));

const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true);
const reads = tools.filter((t) => t.annotations?.readOnlyHint === true);
console.log(`   ${tools.length} tool(s) total: ${reads.length} read-only, ${writes.length} write`);

console.log("\n[2] every write tool is EITHER in GATED_TOOLS OR in the explicit (empty) allowlist");
const unexpected = [];
for (const t of writes) {
  const gated = t.name in GATED_TOOLS;
  const allowlisted = t.name in UNGATED_WRITE_ALLOWLIST;
  check(`${t.name} — gated or allowlisted`, gated || allowlisted, `neither (new ungated write tool!)`);
  if (!gated && !allowlisted) unexpected.push(t.name);
}
check("no unexpected ungated write tools slipped in", unexpected.length === 0, unexpected.join(", "));
check("no write tool is missing from GATED_TOOLS (count sanity)", writes.length === Object.keys(GATED_TOOLS).length, `writes=${writes.length} GATED_TOOLS=${Object.keys(GATED_TOOLS).length}`);

console.log("\n[3] every GATED_TOOLS entry is actually registered as a write (schema sanity)");
for (const [name, spec] of Object.entries(GATED_TOOLS)) {
  const t = tools.find((x) => x.name === name);
  check(`${name} is registered`, !!t, "not found in registry");
  check(`${name} is classified as write (no readOnlyHint)`, t && t.annotations?.readOnlyHint !== true, JSON.stringify(t?.annotations));
  check(`${name} carries destructiveHint: ${spec.destructive}`, t?.annotations?.destructiveHint === spec.destructive, JSON.stringify(t?.annotations));
  const props = t?.inputSchema?.properties ?? {};
  check(`${name} schema exposes manifest_id`, "manifest_id" in props, JSON.stringify(Object.keys(props)));
  check(`${name} schema exposes user_reply`, "user_reply" in props, JSON.stringify(Object.keys(props)));
}

console.log("\n[4] behavioural proof: calling each gated tool WITHOUT manifest_id/user_reply never mutates");
for (const [name, spec] of Object.entries(GATED_TOOLS)) {
  const before = counters[spec.counterKey];
  const resp = await cli.callTool({ name, arguments: spec.args });
  const body = text(resp);
  check(`${name} plan call: mutation counter (${spec.counterKey}) unchanged`, counters[spec.counterKey] === before, String(counters[spec.counterKey]));
  check(`${name} plan call: response is a plan, not a success/failure header`, body.includes("### 📤 План"), body.slice(0, 60));
  check(`${name} plan call: no ✅/✏️/❌ success-style header`, !/^[✅✏️❌]/.test(body), body.slice(0, 10));
}

console.log("\n[5] read tools genuinely carry readOnlyHint (spot-check, not exhaustive)");
for (const name of ["sheets_list", "sheets_get_info", "sheets_read_range", "sheets_find", "sheets_get_formatting", "sheets_consent_audit", "triage_log_get_pending", "list_accounts"]) {
  const t = tools.find((x) => x.name === name);
  check(`${name} readOnlyHint: true`, t?.annotations?.readOnlyHint === true, JSON.stringify(t?.annotations));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
