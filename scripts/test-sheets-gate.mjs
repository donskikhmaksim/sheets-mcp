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
  // Counts calls to spreadsheets.get that asked ONLY for properties.title —
  // i.e. liveSpreadsheetTitle / cachedSpreadsheetTitle, not the tab-list or
  // format-snapshot variants that pass a different `fields` value. Used to
  // assert the per-request title cache actually avoids refetching for a
  // batch that shares one spreadsheetId (mcp-development-standard human-
  // readable-output fix: "получить title одним вызовом и закэшировать").
  const titleOnlyGetCalls = { count: 0 };
  return { ranges, titles, tabs, titleOnlyGetCalls };
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
            if (fields === "properties.title") world.titleOnlyGetCalls.count++;
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
            // sheets_write_range batches >1 item targeting the SAME
            // spreadsheetId into one values.batchUpdate call (see
            // src/tools/sheets.ts's byId grouping) — needed for the [1b]
            // title-cache test below, which writes 2 ranges on one sheet.
            batchUpdate: async ({ spreadsheetId, requestBody }) => {
              const m = world.ranges.get(spreadsheetId) ?? new Map();
              const responses = (requestBody.data ?? []).map(({ range, values }) => {
                m.set(range, values);
                return { updatedRange: range, updatedCells: values.flat().length };
              });
              world.ranges.set(spreadsheetId, m);
              return { data: { responses } };
            },
          },
        },
      },
      drive: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    baseGmailQuery: () => "",
  };
}

async function harness(world, cfgOverrides = {}) {
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
    // Опциональный метод контракта consent.ts — из него sync-wait достаёт
    // пруф post-verify чужого исполнения для отчёта `already_executed`.
    async getExecutionAudit(manifestId, server) {
      const a = [...audits]
        .reverse()
        .find((x) => x.manifestId === manifestId && x.server === server && (x.outcome === "confirmed" || x.outcome === "failed"));
      return a ? { id: a.id, outcome: a.outcome, postVerifyResult: a.postVerify ?? null, error: a.error ?? null, actor: a.actor ?? null } : null;
    },
  };
  const consentCtx = { consentStore, consentCfg: { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10, ...cfgOverrides }, auditStore: null };
  const server = new McpServer({ name: "sheets-gate-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  registerTriageTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, manifests, world, consentStore, audits };
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
  check("execute succeeds — summary shows 1/1, no error", execBody.includes('"summary": "✏️ Записано 1/1"'), execBody.slice(0, 60));
  check("world IS mutated", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "new value");
  check("post-verify report attached with ✅", execBody.includes("Независимая проверка записи") && execBody.includes("✅"));
  check("human-readable output: result item carries the spreadsheet's title, not just its raw id", execBody.includes('"spreadsheetTitle": "My Sheet"'), execBody.slice(0, 400));
}

// ── [1b] title cache: a batch sharing one spreadsheetId fetches the title once, not per item ─
console.log("\n[1b] sheets_write_range: 2 items, same spreadsheetId → title fetched at most once (per-request cache)");
{
  const world = makeSheetWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({
    name: "sheets_write_range",
    arguments: {
      items: [
        { spreadsheetId: "S1", range: "Sheet1!A1", values: [["a"]] },
        { spreadsheetId: "S1", range: "Sheet1!B1", values: [["b"]] },
      ],
    },
  });
  const manifestId = extractManifestId(text(planResp));
  const beforeExecuteCalls = world.titleOnlyGetCalls.count;
  const execResp = await cli.callTool({ name: "sheets_write_range", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("execute succeeds — summary shows 2/2", execBody.includes('"summary": "✏️ Записано 2/2"'), execBody.slice(0, 60));
  check(
    "title fetched exactly once during execute for 2 items sharing one spreadsheetId (not 0, not 2)",
    world.titleOnlyGetCalls.count - beforeExecuteCalls === 1,
    `titleOnlyGetCalls went from ${beforeExecuteCalls} to ${world.titleOnlyGetCalls.count}`,
  );
  check("both result items carry the same cached spreadsheetTitle", (execBody.match(/"spreadsheetTitle": "My Sheet"/g) ?? []).length === 2, execBody.slice(0, 600));
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

// ── triage.ts fixture: row-addressed fake, tracks EVERY write call ──────────
// (accept-review finding, 2026-08-04: `ensureHeader()` used to fire a
// `values.update` from inside `plan()` — a write during the PLAN phase, before
// consent. Fixed in src/tools/triage.ts: header write moved to happen only
// after `decision.kind === "confirmed"`. These tests are the regression guard:
// they assert the write-call counter is exactly 0 after the plan-phase call,
// for BOTH gated triage tools.)

const TRIAGE_HEADER = ["ID", "Date", "Account", "From", "Subject", "Claude Suggested", "Maksim Said", "Why Not Closed", "Status"];

function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}
function parseA1(ref) {
  const m = /^([A-Z]+)(\d+)?$/.exec(ref);
  return { col: colLetterToIndex(m[1]), row: m[2] ? parseInt(m[2], 10) - 1 : null };
}
function parseRange(full) {
  const rest = full.slice(full.indexOf("!") + 1);
  const [a, b] = rest.split(":");
  const start = parseA1(a);
  const end = b ? parseA1(b) : start;
  return { start, end };
}

function makeTriageWorld() {
  return { rows: [], writeOps: [] }; // rows[0] = header once written; writeOps logs every mutating call
}

function buildTriageClients(world) {
  return {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      sheets: {
        spreadsheets: {
          values: {
            get: async ({ range }) => {
              const { start, end } = parseRange(range);
              const rowStart = start.row ?? 0;
              const rowEnd = end.row ?? Math.max(world.rows.length - 1, -1);
              const slice = world.rows
                .slice(rowStart, rowEnd + 1)
                .map((r) => (r ?? []).slice(start.col, end.col + 1));
              // Real Sheets API omits trailing rows that were never written.
              while (slice.length && slice[slice.length - 1].every((c) => c === undefined)) slice.pop();
              return { data: { values: slice.length ? slice.map((r) => r.map((c) => c ?? "")) : [] } };
            },
            update: async ({ range, requestBody }) => {
              const { start } = parseRange(range);
              requestBody.values.forEach((rowVals, i) => {
                const r = start.row + i;
                world.rows[r] = world.rows[r] ?? [];
                rowVals.forEach((v, j) => { world.rows[r][start.col + j] = v; });
              });
              world.writeOps.push({ op: "update", range });
              return { data: { updatedRange: range } };
            },
            append: async ({ range, requestBody }) => {
              requestBody.values.forEach((rowVals) => world.rows.push([...rowVals]));
              world.writeOps.push({ op: "append", range });
              return { data: { updates: { updatedRange: range } } };
            },
            batchUpdate: async ({ requestBody }) => {
              for (const item of requestBody.data) {
                const { start } = parseRange(item.range);
                world.rows[start.row] = world.rows[start.row] ?? [];
                item.values[0].forEach((v, j) => { world.rows[start.row][start.col + j] = v; });
                world.writeOps.push({ op: "batchUpdate", range: item.range });
              }
              return { data: {} };
            },
          },
        },
      },
      drive: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    baseGmailQuery: () => "",
  };
}

async function triageHarness(world) {
  const clients = buildTriageClients(world);
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
    async appendConsentAudit(entry) { audits.push({ ...entry }); },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
  const consentCtx = { consentStore, consentCfg: { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 }, auditStore: null };
  const server = new McpServer({ name: "triage-gate-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerTriageTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, world };
}

// ── [4] triage_log_add: plan() is strictly read-only, header write deferred ─
console.log("\n[4] triage_log_add: plan phase does ZERO writes (accept-review regression — ensureHeader must not fire in plan())");
{
  const world = makeTriageWorld(); // fresh spreadsheet, no header yet — the exact case the review flagged
  const { cli, world: w } = await triageHarness(world);

  const planResp = await cli.callTool({
    name: "triage_log_add",
    arguments: { rows: [{ from: "a@b.com", subject: "Test subject", claudeSuggested: "archive" }] },
  });
  const planBody = text(planResp);
  check("plan built a preview", planBody.includes("План: Добавление в Triage Log"), planBody.slice(0, 200));
  check("plan phase performed ZERO write calls (no ensureHeader update, no append)", w.writeOps.length === 0, JSON.stringify(w.writeOps));
  check("sheet still has no header after plan()", w.rows.length === 0, JSON.stringify(w.rows));
  const manifestId = extractManifestId(planBody);
  check("manifest id extracted", !!manifestId, planBody.slice(0, 200));

  const execResp = await cli.callTool({ name: "triage_log_add", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("execute succeeds with ✅", execBody.includes("✅"), execBody.slice(0, 120));
  check("header written on execute, AFTER confirm", w.rows[0]?.[0] === "ID", JSON.stringify(w.rows[0]));
  check("row appended on execute", w.rows[1]?.[3] === "a@b.com", JSON.stringify(w.rows[1]));
  check("writes happened only on/after execute", w.writeOps.length > 0 && w.writeOps.some((o) => o.op === "update") && w.writeOps.some((o) => o.op === "append"));
}

// ── [5] triage_log_update: plan() is strictly read-only ──────────────────────
console.log("\n[5] triage_log_update: plan phase does ZERO writes");
{
  const world = makeTriageWorld();
  world.rows = [
    TRIAGE_HEADER,
    ["1", "2026-08-04", "work", "a@b.com", "Test subject", "archive", "", "", "pending"],
  ];
  const { cli, world: w } = await triageHarness(world);

  const planResp = await cli.callTool({ name: "triage_log_update", arguments: { id: 1, status: "done" } });
  const planBody = text(planResp);
  check("plan built a preview", planBody.includes("План: Обновление Triage Log"), planBody.slice(0, 200));
  check("plan phase performed ZERO write calls", w.writeOps.length === 0, JSON.stringify(w.writeOps));
  const manifestId = extractManifestId(planBody);

  // `id` is a required (non-optional) schema field on this tool — even on the
  // execute call it must be passed, though the tool itself reads the actual
  // payload back from the manifest, not from these arguments.
  const execResp = await cli.callTool({ name: "triage_log_update", arguments: { id: 1, manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("execute succeeds with ✅", execBody.includes("✅"), execBody.slice(0, 120));
  check("status actually updated in the sheet", w.rows[1]?.[8] === "done", JSON.stringify(w.rows[1]));
  check("writes happened only on/after execute", w.writeOps.length > 0);
}

// ── [6] чужой канал исполнил план в окне sync-wait → отчёт, а не отказ ──────
console.log("\n[6] sheets_write_range: подтверждено и исполнено «извне» в середине окна → ОДИН вызов тула, мутация НЕ дублируется, метка execution-report");
{
  const world = makeSheetWorld();
  // Реальные (маленькие) миллисекунды: sleep внутри consent.ts у sheets —
  // настоящий setTimeout, инъекции часов тут нет. Момент «исполнено извне»
  // ловится СЧЁТЧИКОМ опросов, а не временем, поэтому результат
  // детерминирован независимо от скорости машины.
  const { cli, consentStore } = await harness(world, { syncWaitMs: 500, syncPollMs: 10 });
  let polls = 0;
  const origGetManifest = consentStore.getManifest.bind(consentStore);
  consentStore.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) {
      // Симулируем `POST /pending-consents/decide`: он САМ исполняет мутацию
      // через tryAutoExecute + per-tool execute (здесь — прямая запись в
      // world, тем же способом, что и настоящий values.update), консьюмит
      // манифест и пишет аудит-строку с пруфом post-verify.
      world.ranges.get("S1").set("Sheet1!A1", [["written by hub"]]);
      await consentStore.consumeManifest(id, "sheets", "[веб-хаб: подтверждено]");
      await consentStore.appendConsentAudit({
        id: "audit-hub-1", ts: Date.now(), server: "sheets", tool: "sheets_write_range",
        accountLabel: "work", manifestId: id, objectHash: null,
        userReply: "[веб-хаб: подтверждено]", checks: { source: "web_hub" },
        outcome: "confirmed", actor: "web",
      });
      await consentStore.updateConsentAuditOutcome("audit-hub-1", {
        outcome: "confirmed",
        postVerify: "### 🧾 Независимая проверка записи\n\n- ✅ «My Sheet» Sheet1!A1 — 1 ячейка на месте",
      });
    }
    return origGetManifest(id, server);
  };

  const resp = await cli.callTool({
    name: "sheets_write_range",
    arguments: { items: [{ spreadsheetId: "S1", range: "Sheet1!A1", values: [["written by hub"]] }] },
  });
  const body = text(resp);
  check("тул НЕ вернул собственный отчёт об исполнении (не «Записано 1/1»)", !body.includes("Записано 1/1"), body.slice(0, 100));
  check("_meta.kind = 'execution-report' (НЕ 'refusal')", resp._meta?.kind === "execution-report", JSON.stringify(resp._meta));
  check("отчёт НЕ помечен 🛑 (это не отказ)", !body.includes("🛑"), body.slice(0, 120));
  check("ФАКТИЧЕСКИЙ результат (пруф post-verify исполнившего канала) донесён до модели", body.includes("Независимая проверка записи"), body.slice(-300));
  check("модели прямо сказано не повторять вызов", body.includes("повторять вызов"), body.slice(-400));
  check("значение в мире записано ровно тем, что сделал хаб (тул не переписал повторно)", world.ranges.get("S1").get("Sheet1!A1")[0][0] === "written by hub");
  check("подтверждение поймано опросом (>= 2 итерации)", polls >= 2, `polls=${polls}`);

  // Регресс: настоящий ОТКАЗ обязан остаться отказом с меткой "refusal".
  const refusedResp = await cli.callTool({ name: "sheets_write_range", arguments: { manifest_id: "нет-такого", user_reply: "да" } });
  check("настоящий отказ по-прежнему помечен _meta.kind='refusal'", refusedResp._meta?.kind === "refusal", JSON.stringify(refusedResp._meta));
  check("настоящий отказ по-прежнему несёт 🛑", text(refusedResp).includes("🛑"), text(refusedResp).slice(0, 80));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
