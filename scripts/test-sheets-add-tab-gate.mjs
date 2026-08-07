#!/usr/bin/env node
/**
 * E2E-тест для sheets_add_tab (второй по порядку гейтованный мутирующий
 * метод sheets-mcp в all_methods.txt — «Создание», п.7, сразу после
 * sheets_create) — round-trip покрытие, которого раньше не было:
 * test-sheets-gate.mjs в этом репозитории покрывает только
 * write_range/clear_range.
 *
 * Отличие от sheets_create: у sheets_add_tab РЕАЛЬНЫЙ (не вырожденный)
 * binding — rehash перечитывает live-title спредшита И live-список вкладок
 * (addTabBindingSnapshot). Сценарий [4] ниже — прямое доказательство, что
 * rehash не тавтология sha256(payload) (тот же паттерн, что сценарий [2] в
 * штатном scripts/test-sheets-gate.mjs для sheets_write_range).
 *
 * Usage: node scripts/test-sheets-add-tab-gate.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSheetsTools } from "../dist/tools/sheets.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;
function extractManifestId(planText) {
  const m = /план `([a-f0-9-]+)`/.exec(planText);
  return m?.[1];
}

// ── fake Sheets world ────────────────────────────────────────────────────
function makeWorld() {
  return {
    nextSheetId: 100,
    titles: new Map([["S1", "My Sheet"]]),
    tabs: new Map([["S1", ["Sheet1"]]]),
    batchUpdateCalls: [],
    forceBatchUpdateError: null,
  };
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
          batchUpdate: async ({ spreadsheetId, requestBody }) => {
            world.batchUpdateCalls.push({ spreadsheetId, requestBody });
            if (world.forceBatchUpdateError) {
              const e = new Error(world.forceBatchUpdateError);
              e.code = 400;
              throw e;
            }
            const reqTitle = requestBody.requests[0].addSheet.properties.title;
            const sheetId = world.nextSheetId++;
            const list = world.tabs.get(spreadsheetId) ?? [];
            list.push(reqTitle);
            world.tabs.set(spreadsheetId, list);
            return { data: { replies: [{ addSheet: { properties: { sheetId, title: reqTitle } } }] } };
          },
          values: { get: async () => ({ data: { values: [] } }) },
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
    async appendConsentAudit(entry) { audits.push({ ...entry }); },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
  const consentCtx = { consentStore, consentCfg: { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10 }, auditStore: null };
  const server = new McpServer({ name: "sheets-add-tab-qa", version: "0" });
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, manifests, audits, world };
}

// ── [0]/[0b] заведомо неверные данные, ВНЕ подтверждения ────────────────────
console.log("\n[0] sheets_add_tab: план с пустым items[] — заведомо неверные данные");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const resp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [] } });
  const body = text(resp);
  console.log("  RAW:", JSON.stringify(body).slice(0, 250));
  check("сервер вернул ошибку, ничего не добавлено", resp.isError === true || /error/i.test(body), body.slice(0, 150));
  check("batchUpdate НЕ вызывался", world.batchUpdateCalls.length === 0);
}
console.log("\n[0b] sheets_add_tab: полностью пустой вызов");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const resp = await cli.callTool({ name: "sheets_add_tab", arguments: {} });
  const body = text(resp);
  console.log("  RAW:", JSON.stringify(body).slice(0, 250));
  check("сервер отказал", resp.isError === true || /error/i.test(body), body.slice(0, 150));
  check("batchUpdate НЕ вызывался", world.batchUpdateCalls.length === 0);
}

// ── [1] happy path: план → подтверждение → реальное добавление вкладки ──────
console.log("\n[1] sheets_add_tab: happy path — план → подтверждение → добавление, поля ответа проверены");
{
  const world = makeWorld();
  const { cli, audits } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [{ spreadsheetId: "S1", title: "__AUTOTEST__btn-tab-01" }] } });
  const planBody = text(planResp);
  console.log("  PLAN RAW:", planBody.slice(0, 400));
  check("план содержит заголовок 'План: Добавление вкладок'", planBody.includes("План: Добавление вкладок"));
  check("план упоминает live-название таблицы «My Sheet»", planBody.includes("My Sheet"));
  check("план упоминает имя новой вкладки", planBody.includes("__AUTOTEST__btn-tab-01"));
  check("НЕТ предупреждения о дубле (вкладки с таким именем ещё нет)", !planBody.includes("уже есть"));
  check("manifest id напечатан в тексте", /план `[a-f0-9-]+`/.test(planBody));
  check("ничего не добавлено на этапе плана", world.batchUpdateCalls.length === 0 && !world.tabs.get("S1").includes("__AUTOTEST__btn-tab-01"));
  const manifestId = extractManifestId(planBody);
  check("manifest id извлечён", !!manifestId, planBody.slice(0, 150));

  const execResp = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId, user_reply: "да, добавляй" } });
  const execBody = text(execResp);
  console.log("  EXEC RAW:", execBody.slice(0, 700));
  check("batchUpdate вызван ровно 1 раз", world.batchUpdateCalls.length === 1, String(world.batchUpdateCalls.length));
  check("summary показывает 1/1 с иконкой 📑", execBody.includes('"summary": "📑 Добавлено 1/1"'), execBody.slice(0, 100));

  let parsed;
  try { parsed = JSON.parse(execBody); } catch { parsed = null; }
  check("ответ — валидный JSON", parsed !== null, execBody.slice(0, 100));
  if (parsed) {
    const item = parsed.results?.[0];
    check("results[0].spreadsheetId присутствует", item?.spreadsheetId === "S1", JSON.stringify(item));
    check("results[0].sheetId присутствует (числовой id новой вкладки)", typeof item?.sheetId === "number", JSON.stringify(item));
    check("results[0].title совпадает с запрошенным", item?.title === "__AUTOTEST__btn-tab-01", JSON.stringify(item));
    check("results[0].spreadsheetTitle человекочитаемое имя таблицы приложено (buildMutationResult с g)", item?.spreadsheetTitle === "My Sheet", JSON.stringify(item));
    check("results[0].error отсутствует", !item?.error, JSON.stringify(item));
    check("verification-отчёт приложен с заголовком про вкладку", typeof parsed.verification === "string" && parsed.verification.includes("Независимая проверка добавления вкладки"));
    check("verification содержит ✅", parsed.verification.includes("✅"), parsed.verification);
  }
  check("аудит-запись помечена confirmed", audits.some((a) => a.outcome === "confirmed"));
  // точечное живое чтение — вкладка реально в мире
  check("точечное чтение: вкладка реально в живом списке вкладок S1", world.tabs.get("S1").includes("__AUTOTEST__btn-tab-01"), JSON.stringify(world.tabs.get("S1")));

  // повтор того же манифеста — не должен дать второй эффект
  const before = world.tabs.get("S1").length;
  const replay = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId, user_reply: "да, добавляй" } });
  const replayBody = text(replay);
  console.log("  REPLAY RAW:", replayBody.slice(0, 200));
  check("повтор манифеста отказан", replayBody.includes("не найден") || replayBody.includes("уже был исполнен"), replayBody.slice(0, 150));
  check("batchUpdate НЕ вызван повторно", world.batchUpdateCalls.length === 1, String(world.batchUpdateCalls.length));
  check("список вкладок не вырос повторно", world.tabs.get("S1").length === before, String(world.tabs.get("S1").length));
}

// ── [1b] план предупреждает о дубле имени вкладки ────────────────────────────
console.log("\n[1b] sheets_add_tab: план предупреждает, если вкладка с таким именем уже есть");
{
  const world = makeWorld(); // S1 уже имеет вкладку "Sheet1"
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [{ spreadsheetId: "S1", title: "Sheet1" }] } });
  const planBody = text(planResp);
  console.log("  PLAN RAW:", planBody);
  check("план ПРЕДУПРЕЖДАЕТ о дубле имени", planBody.includes("уже есть"), planBody.slice(0, 300));
}

// ── [2] ошибка API на исполнении ──────────────────────────────────────────────
console.log("\n[2] sheets_add_tab: batchUpdate кидает ошибку — заведомо провальный сценарий");
{
  const world = makeWorld();
  world.forceBatchUpdateError = "Invalid requests[0].addSheet: A sheet with this name already exists.";
  const { cli, audits } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [{ spreadsheetId: "S1", title: "__AUTOTEST__btn-tab-err" }] } });
  const manifestId = extractManifestId(text(planResp));
  const execResp = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  console.log("  EXEC RAW (forced error):", execBody.slice(0, 500));
  check("summary отражает провал (0/1, иконка ⚠️)", execBody.includes('"summary": "⚠️ Добавлено 0/1 (1 с ошибкой)"'), execBody.slice(0, 100));
  let parsed;
  try { parsed = JSON.parse(execBody); } catch { parsed = null; }
  check("results[0].error содержит текст ошибки Google", parsed?.results?.[0]?.error?.includes("already exists"), JSON.stringify(parsed?.results));
  check("вкладка НЕ появилась в мире", !world.tabs.get("S1").includes("__AUTOTEST__btn-tab-err"));
  check("аудит: outcome=failed (честно, okN=0)", audits.some((a) => a.outcome === "failed"), JSON.stringify(audits.map((a) => a.outcome)));
}

// ── [3] ветка ОТКЛОНИТЬ ───────────────────────────────────────────────────────
console.log("\n[3] sheets_add_tab: ветка отклонить — user_reply='нет' → 🛑, ничего не добавлено");
{
  const world = makeWorld();
  const { cli, audits } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [{ spreadsheetId: "S1", title: "__AUTOTEST__btn-tab-reject" }] } });
  const manifestId = extractManifestId(text(planResp));
  const noResp = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId, user_reply: "нет, не надо" } });
  const noBody = text(noResp);
  console.log("  REJECT RAW:", noBody);
  check("отказ помечен 🛑 'Отменено пользователем'", noBody.includes("🛑") && noBody.includes("Отменено пользователем"), noBody.slice(0, 150));
  check("ничего не добавлено", world.batchUpdateCalls.length === 0 && !world.tabs.get("S1").includes("__AUTOTEST__btn-tab-reject"));
  check("аудит: invalidated/negation", audits.some((a) => a.outcome === "invalidated" && a.refusalReason === "negation"));

  const retry = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId, user_reply: "да, теперь добавляй" } });
  check("повтор 'да' после отказа — снова 🛑", text(retry).includes("🛑"), text(retry).slice(0, 150));
  check("по-прежнему ничего не добавлено", world.batchUpdateCalls.length === 0);
}

// ── [4] РЕАЛЬНЫЙ binding: кто-то добавил вкладку с тем же именем между планом и исполнением ──
console.log("\n[4] sheets_add_tab: дрейф состояния между планом и исполнением (кто-то уже добавил вкладку) → 🛑, НЕ добавлено дважды (доказывает rehash реальный, не sha256(payload))");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [{ spreadsheetId: "S1", title: "__AUTOTEST__btn-tab-drift" }] } });
  const manifestId = extractManifestId(text(planResp));

  // Симулируем конкурентное изменение: кто-то ДРУГОЙ уже добавил вкладку с этим именем
  // напрямую в мир (не через наш batchUpdate), между планом и исполнением.
  world.tabs.get("S1").push("__AUTOTEST__btn-tab-drift");

  const execResp = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  console.log("  EXEC RAW (after concurrent drift):", execBody.slice(0, 300));
  check("отказано 🛑 'состояние изменилось'", execBody.includes("🛑") && execBody.includes("изменилось"), execBody.slice(0, 200));
  check("НЕ было второго вызова batchUpdate из нашего плана", world.batchUpdateCalls.length === 0, String(world.batchUpdateCalls.length));
  check("вкладка в мире ровно ОДНА (не задвоилась)", world.tabs.get("S1").filter((t) => t === "__AUTOTEST__btn-tab-drift").length === 1, JSON.stringify(world.tabs.get("S1")));
}

// ── [5] только manifest_id без user_reply ─────────────────────────────────────
console.log("\n[5] sheets_add_tab: только manifest_id без user_reply");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_add_tab", arguments: { items: [{ spreadsheetId: "S1", title: "X" }] } });
  const manifestId = extractManifestId(text(planResp));
  const resp = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: manifestId } });
  const body = text(resp);
  console.log("  RAW:", body.slice(0, 150));
  check("отказ 'нужны оба параметра'", body.includes("нужны оба") || body.includes("Нужны оба параметра"), body.slice(0, 150));
  check("ничего не добавлено", world.batchUpdateCalls.length === 0);
}

// ── [6] несуществующий manifest_id ────────────────────────────────────────────
console.log("\n[6] sheets_add_tab: несуществующий manifest_id + user_reply='да'");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const resp = await cli.callTool({ name: "sheets_add_tab", arguments: { manifest_id: "00000000-0000-0000-0000-000000000000", user_reply: "да" } });
  const body = text(resp);
  console.log("  RAW:", body.slice(0, 150));
  check("отказ 'план не найден или истёк'", body.includes("не найден") || body.includes("истёк"), body.slice(0, 150));
  check("ничего не добавлено", world.batchUpdateCalls.length === 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
