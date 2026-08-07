#!/usr/bin/env node
/**
 * E2E-тест для sheets_create (гейтованный мутирующий метод sheets-mcp,
 * первый по порядку all_methods.txt) — round-trip покрытие, которого раньше
 * не было: test-sheets-gate.mjs в этом репозитории покрывает только
 * write_range/clear_range.
 *
 * Покрывает:
 *  - happy path: план → подтверждение → реальная мутация → post-verify
 *  - заведомо неверные данные (пустой spreadsheets[], ошибка Google API)
 *  - ветка "отклонить" (negation)
 *  - повтор уже отработанного манифеста (идемпотентность/one-shot)
 *
 * Стиль и harness скопированы с scripts/test-sheets-gate.mjs (тот же паттерн
 * in-memory fake Google API + fake ConsentStore), специфично для
 * sheets_create.
 *
 * Usage: node scripts/test-sheets-create-gate.mjs
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

// ── fake Sheets/Drive world ─────────────────────────────────────────────────
function makeWorld() {
  return {
    nextId: 1,
    spreadsheets: new Map(), // id -> { title, url }
    createCalls: [],
    forceCreateError: null, // string | null — если задано, spreadsheets.create кидает
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
          create: async ({ requestBody }) => {
            world.createCalls.push(requestBody);
            if (world.forceCreateError) {
              const e = new Error(world.forceCreateError);
              e.code = 403;
              throw e;
            }
            const id = `SS${world.nextId++}`;
            const title = requestBody.properties?.title ?? "";
            const url = `https://docs.google.com/spreadsheets/d/${id}/edit`;
            world.spreadsheets.set(id, { title, url });
            return { data: { spreadsheetId: id, spreadsheetUrl: url, properties: { title } } };
          },
          get: async ({ spreadsheetId, fields }) => {
            const s = world.spreadsheets.get(spreadsheetId);
            if (fields === "properties.title") {
              return { data: { properties: { title: s?.title ?? null } } };
            }
            return { data: { properties: { title: s?.title ?? null } } };
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
  const server = new McpServer({ name: "sheets-create-qa", version: "0" });
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, manifests, audits, world };
}

// ── [0] заведомо неверные данные, ВНЕ подтверждения: пустой spreadsheets[] ──
console.log("\n[0] sheets_create: план с пустым spreadsheets[] — заведомо неверные данные, вне подтверждения");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const resp = await cli.callTool({ name: "sheets_create", arguments: { spreadsheets: [] } });
  const body = text(resp);
  console.log("  RAW:", JSON.stringify(body).slice(0, 300));
  check("сервер вернул ошибку (isError), ничего не создано", resp.isError === true || /error/i.test(body), body.slice(0, 200));
  check("create НЕ вызывался", world.createCalls.length === 0);
}

// ── [0b] заведомо неверные данные: спрашиваем sheets_create без account/spreadsheets вовсе (пустой вызов) ──
console.log("\n[0b] sheets_create: полностью пустой вызов (ни items, ни manifest_id/user_reply)");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const resp = await cli.callTool({ name: "sheets_create", arguments: {} });
  const body = text(resp);
  console.log("  RAW:", JSON.stringify(body).slice(0, 300));
  check("сервер отказал (ошибка о пустом spreadsheets)", resp.isError === true || /error/i.test(body), body.slice(0, 200));
  check("create НЕ вызывался", world.createCalls.length === 0);
}

// ── [1] happy path: план → подтверждение → реальное создание → post-verify ──
console.log("\n[1] sheets_create: happy path — план → подтверждение → создание, поля ответа проверены");
{
  const world = makeWorld();
  const { cli, audits } = await harness(world);
  const planResp = await cli.callTool({
    name: "sheets_create",
    arguments: { spreadsheets: [{ title: "__AUTOTEST__btn-sheets-01", sheetTitles: ["Sheet1", "Data"] }] },
  });
  const planBody = text(planResp);
  console.log("  PLAN RAW:", planBody.slice(0, 500));
  check("план содержит заголовок 'План: Создание таблиц'", planBody.includes("План: Создание таблиц"));
  check("план упоминает точное имя таблицы", planBody.includes("__AUTOTEST__btn-sheets-01"));
  check("план упоминает вкладки", planBody.includes("Sheet1") && planBody.includes("Data"));
  check("manifest id напечатан в тексте (видим клиенту)", /план `[a-f0-9-]+`/.test(planBody), planBody.slice(-200));
  check("ничего не создано на этапе плана", world.createCalls.length === 0);
  const manifestId = extractManifestId(planBody);
  check("manifest id извлечён", !!manifestId, planBody.slice(0, 200));

  const execResp = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: manifestId, user_reply: "да, создавай" } });
  const execBody = text(execResp);
  console.log("  EXEC RAW:", execBody.slice(0, 800));
  check("create вызван ровно 1 раз", world.createCalls.length === 1, String(world.createCalls.length));
  check("summary показывает 1/1 с иконкой 📄", execBody.includes('"summary": "📄 Создано 1/1"'), execBody.slice(0, 100));

  let parsed;
  try {
    parsed = JSON.parse(execBody);
  } catch (e) {
    parsed = null;
  }
  check("ответ — валидный JSON (не сырой текст с мусором)", parsed !== null, execBody.slice(0, 100));
  if (parsed) {
    const item = parsed.results?.[0];
    check("results[0].spreadsheetId присутствует и непустой", !!item?.spreadsheetId, JSON.stringify(item));
    check("results[0].title совпадает с запрошенным", item?.title === "__AUTOTEST__btn-sheets-01", JSON.stringify(item));
    check("results[0].spreadsheetUrl присутствует (ссылка на реальную таблицу — артефакт для живой проверки)", typeof item?.spreadsheetUrl === "string" && item.spreadsheetUrl.startsWith("https://"), JSON.stringify(item));
    check("results[0].error отсутствует", !item?.error, JSON.stringify(item));
    check("verification-отчёт приложен", typeof parsed.verification === "string" && parsed.verification.includes("Независимая проверка создания"));
    check("verification содержит ✅ (post-verify подтвердил живое существование)", parsed.verification.includes("✅"), parsed.verification);
  }
  check("аудит-запись помечена confirmed", audits.some((a) => a.outcome === "confirmed"));
  // ТОЧЕЧНОЕ живое чтение объекта (не список) — созданная таблица реально существует в мире
  const live = world.spreadsheets.get(parsed?.results?.[0]?.spreadsheetId);
  check("точечное чтение: таблица реально существует в живом хранилище с тем же title", live?.title === "__AUTOTEST__btn-sheets-01", JSON.stringify(live));

  // ── доп. проверка: повтор того же manifestId НЕ даёт второго эффекта ──
  const replay = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: manifestId, user_reply: "да, создавай" } });
  const replayBody = text(replay);
  console.log("  REPLAY RAW:", replayBody.slice(0, 300));
  check("повтор манифеста отказан ('уже исполнен/истёк')", replayBody.includes("уже был исполнен") || replayBody.includes("не найден"), replayBody.slice(0, 200));
  check("create НЕ вызван повторно (счётчик остался 1)", world.createCalls.length === 1, String(world.createCalls.length));
  check("в мире по-прежнему ровно 1 таблица", world.spreadsheets.size === 1, String(world.spreadsheets.size));
}

// ── [2] заведомо неверные данные на исполнении: Google API возвращает ошибку ──
console.log("\n[2] sheets_create: Google API кидает ошибку при create() — заведомо провальный сценарий");
{
  const world = makeWorld();
  world.forceCreateError = "Quota exceeded for quota metric 'Write requests'";
  const { cli, audits } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_create", arguments: { spreadsheets: [{ title: "__AUTOTEST__btn-sheets-err" }] } });
  const manifestId = extractManifestId(text(planResp));
  const execResp = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  console.log("  EXEC RAW (forced error):", execBody.slice(0, 500));
  check("summary отражает провал (0/1, иконка ⚠️, есть 'с ошибкой')", execBody.includes('"summary": "⚠️ Создано 0/1 (1 с ошибкой)"'), execBody.slice(0, 100));
  let parsed;
  try { parsed = JSON.parse(execBody); } catch { parsed = null; }
  check("results[0].error содержит текст ошибки Google", parsed?.results?.[0]?.error?.includes("Quota exceeded"), JSON.stringify(parsed?.results));
  check("results[0].spreadsheetId пуст (ничего не создано)", parsed?.results?.[0]?.spreadsheetId === "", JSON.stringify(parsed?.results));
  check("ничего не появилось в мире", world.spreadsheets.size === 0);
  // buildMutationResult: outcome = okN > 0 ? "confirmed" : "failed" — здесь okN=0 (единственный item провалился),
  // поэтому правильный (честный) исход аудита — "failed", не "confirmed".
  check("аудит-запись: outcome=failed (okN=0, честно, не замаскировано под confirmed)", audits.some((a) => a.outcome === "failed" && a.postVerify?.includes("Создано 0/1")), JSON.stringify(audits.map((a) => ({ o: a.outcome, pv: a.postVerify }))));
}

// ── [3] ветка ОТКЛОНИТЬ: user_reply = "нет" ──────────────────────────────────
console.log("\n[3] sheets_create: ветка отклонить — user_reply='нет, не надо' → 🛑, ничего не создано");
{
  const world = makeWorld();
  const { cli, audits } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_create", arguments: { spreadsheets: [{ title: "__AUTOTEST__btn-sheets-reject" }] } });
  const planBody = text(planResp);
  const manifestId = extractManifestId(planBody);
  check("план построен, manifest id есть", !!manifestId, planBody.slice(0, 150));

  const noResp = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: manifestId, user_reply: "нет, не надо" } });
  const noBody = text(noResp);
  console.log("  REJECT RAW:", noBody);
  check("отказ помечен 🛑", noBody.includes("🛑"), noBody.slice(0, 100));
  check("текст объясняет 'Отменено пользователем'", noBody.includes("Отменено пользователем"), noBody.slice(0, 200));
  check("ничего не создано", world.createCalls.length === 0 && world.spreadsheets.size === 0);
  check("аудит: outcome=invalidated, reason=negation", audits.some((a) => a.outcome === "invalidated" && a.refusalReason === "negation"), JSON.stringify(audits));

  // Доп.: повтор того же (уже инвалидированного) манифеста другим ответом "да" — не должен исполниться.
  const retry = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: manifestId, user_reply: "да, создавай уже" } });
  const retryBody = text(retry);
  console.log("  RETRY-AFTER-REJECT RAW:", retryBody.slice(0, 200));
  check("повторная попытка 'да' на инвалидированном манифесте — снова отказ", retryBody.includes("🛑"), retryBody.slice(0, 150));
  check("по-прежнему ничего не создано", world.createCalls.length === 0 && world.spreadsheets.size === 0);
}

// ── [4] заведомо неверные данные: manifest_id указан, а user_reply — нет (половина пары) ──
console.log("\n[4] sheets_create: только manifest_id без user_reply — 'нужны оба параметра'");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "sheets_create", arguments: { spreadsheets: [{ title: "X" }] } });
  const manifestId = extractManifestId(text(planResp));
  const resp = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: manifestId } });
  const body = text(resp);
  console.log("  RAW:", body.slice(0, 200));
  check("отказ 'нужны оба параметра'", body.includes("Нужны оба параметра") || body.includes("нужны оба"), body.slice(0, 150));
  check("ничего не создано", world.createCalls.length === 0);
}

// ── [5] заведомо неверные данные: чужой (несуществующий) manifest_id ─────────
console.log("\n[5] sheets_create: несуществующий manifest_id + user_reply='да' — план не найден");
{
  const world = makeWorld();
  const { cli } = await harness(world);
  const resp = await cli.callTool({ name: "sheets_create", arguments: { manifest_id: "00000000-0000-0000-0000-000000000000", user_reply: "да" } });
  const body = text(resp);
  console.log("  RAW:", body.slice(0, 200));
  check("отказ 'план не найден или истёк'", body.includes("не найден") || body.includes("истёк"), body.slice(0, 150));
  check("ничего не создано", world.createCalls.length === 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
