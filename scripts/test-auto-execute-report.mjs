#!/usr/bin/env node
/**
 * Offline end-to-end (mutation/adversarial) тест на баг task #131 (2026-08-06,
 * найден живьём на drive-mcp — идентичный побайтово код, значит баг был и
 * здесь): после нажатия "✅ Подтвердить" в Telegram сервер исполняет манифест
 * НАПРЯМУЮ, без модели в цикле (autoExecute.ts, http.ts's
 * `runAutoExecutePoller`). Старый путь брал `content[0].text` (для любого
 * объекта — сырой `JSON.stringify`, util.ts's `ok()`) и слал ЭТО в Telegram
 * через `reportAutoExecutionResult` — Максим видел буквальный
 * `{ "summary": "...", "results": [...] }`, а поле `verification`
 * (tools/sheets.ts's `renderVerifyReport`) несёт строку, адресованную МОДЕЛИ,
 * не человеку (`_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО …]_`) —
 * без модели в цикле эта инструкция утекала в чат дословно.
 *
 * Этот файл проверяет ВЕСЬ путь данных до фактического payload Telegram API:
 * structuredContent (util.ts's ok()) → report.ts's renderAutoExecuteReport →
 * tg_approval.ts's reportAutoExecutionResult → реальный HTTP-запрос
 * editMessageText, перехваченный undici's MockAgent (тот же HTTP-клиент,
 * что использует сам модуль в проде — ничего реального в сеть не уходит).
 *
 * Импортирует из `dist/` (не `../src/*.ts` напрямую): в отличие от
 * `test-tg-approval.mjs`/`test-auto-execute.mjs` (которые грузят `tg_approval.ts`/
 * `consent.ts` напрямую через Node's native TS-стриппинг — работает только
 * потому, что у тех модулей нет ЛОКАЛЬНЫХ runtime-импортов, только `import
 * type`), `report.ts` реально импортирует `util.ts` и `tg_approval.ts` в
 * рантайме — Node's native TS-стриппинг НЕ переписывает `./util.js` →
 * `./util.ts` при резолве модулей (в отличие от `tsx`/бандлеров), поэтому
 * прямой запуск через голый `node` падает с `ERR_MODULE_NOT_FOUND`. `npm
 * test` гоняет `npm run build` перед этим скриптом (см. package.json) — та же
 * причина, по которой `test-sheets-gate.mjs` и соседи импортируют из `dist/`.
 *
 * Запуск: npm run build && node scripts/test-auto-execute-report.mjs
 */
import { MockAgent, setGlobalDispatcher } from "undici";
import { reportAutoExecutionResult, stripAgentDirectives } from "../dist/tg_approval.js";
import { renderAutoExecuteReport } from "../dist/report.js";
import { ok } from "../dist/util.js";

const BOT_TOKEN = "TESTTOKEN";
let tgCalls = [];

function resetTelegramMocks() {
  tgCalls = [];
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const pool = agent.get("https://api.telegram.org");
  return {
    mock(method, respond) {
      pool
        .intercept({ path: `/bot${BOT_TOKEN}/${method}`, method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body);
          tgCalls.push({ method, body });
          return respond(body);
        })
        .persist();
    },
  };
}

function tgCfg(overrides = {}) {
  return {
    enabled: true,
    botToken: BOT_TOKEN,
    ownerChatId: "555",
    webhookSecret: "wh-secret-xyz",
    publicBaseUrl: "https://example.test",
    server: "sheets",
    toolsAllowlist: null,
    ttlMs: 3_600_000,
    webhookOwner: false,
    ownBot: false,
    ...overrides,
  };
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// ═══ [1] the exact production shape: sheets_write_range's real execute-phase
// CallToolResult (structuredContent with a verification block carrying the
// agent-directive line, byte-for-byte the real renderVerifyReport output) →
// full pipeline → Telegram payload must be human-readable, no JSON, no
// directive. ═══
console.log("\n[1] full pipeline: real ok() structuredContent with an agent-directive verification → clean Telegram text");
{
  const { mock } = resetTelegramMocks();
  mock("editMessageText", () => ({ statusCode: 200, data: { ok: true, result: {} }, headers: { "content-type": "application/json" } }));

  const result = ok({
    summary: "✏️ Записано 1/1",
    results: [{ spreadsheetId: "S1", range: "Sheet1!A1", updatedRange: "Sheet1!A1", updatedCells: 1, spreadsheetTitle: "Мой файл" }],
    verification:
      "### 🧾 Независимая проверка записи\n" +
      "_6 авг., 20:00 America/Los_Angeles · запрошено ⇄ живое содержимое Google Sheets_\n\n" +
      "- ✅ **«Sheet1!A1»** — записано, живое содержимое совпадает\n\n" +
      "**Итог: ✅ 1 подтверждено, ⚠️ 0 не проверено, ❌ 0 расхождение.**\n" +
      "_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО — это серверная проверка, не заменяй пересказом]_",
  });

  // Exactly what autoExecute.ts's ExecuteFn implementations return (see
  // tools/sheets.ts's registerAutoExecutor("sheets_write_range", { execute: ... })).
  const reportText = renderAutoExecuteReport(result);
  check("renderAutoExecuteReport output is not raw JSON", !reportText.trim().startsWith("{"), reportText.slice(0, 60));
  check("renderAutoExecuteReport output has no leftover agent directive", !/\[\s*агенту\s*:/i.test(reportText), reportText);

  // Exactly what http.ts's runAutoExecutePoller does with it.
  await reportAutoExecutionResult(tgCfg(), "555", 4242, reportText);

  const call = tgCalls.find((c) => c.method === "editMessageText");
  check("editMessageText was actually called", !!call);
  const payloadText = call?.body?.text ?? "";
  check("Telegram payload is not raw JSON (no '{' / '\"summary\"')", !payloadText.includes("{") && !payloadText.includes("&quot;summary&quot;") && !payloadText.includes('"summary"'), payloadText);
  check("Telegram payload does NOT contain the agent directive", !/агенту/i.test(payloadText), payloadText);
  check("Telegram payload IS human-readable (carries the object name)", payloadText.includes("Мой файл"), payloadText);
  check("Telegram payload keeps the real proof tally", payloadText.includes("Итог:") && payloadText.includes("подтверждено"), payloadText);
  check("buttons were cleared in the same call", Array.isArray(call?.body?.reply_markup?.inline_keyboard) && call.body.reply_markup.inline_keyboard.length === 0);
}

// ═══ [2] mutation test: an ATTACKER-shaped reportText (raw JSON string,
// exactly what the OLD buggy extractText() used to hand reportAutoExecutionResult)
// must STILL be sanitized by reportAutoExecutionResult's own last-mile guard —
// this is the regression test for the fix at the tg_approval.ts layer itself,
// independent of whether report.ts's own sanitizing is bypassed by some future
// caller. ═══
console.log("\n[2] mutation test: reportAutoExecutionResult sanitizes even a raw-JSON-with-directive text handed to it directly (defense-in-depth, bypassing report.ts entirely)");
{
  const { mock } = resetTelegramMocks();
  mock("editMessageText", () => ({ statusCode: 200, data: { ok: true, result: {} }, headers: { "content-type": "application/json" } }));

  // This is literally what the OLD `extractText()` (JSON.stringify(result, null, 2))
  // used to produce and hand to reportAutoExecutionResult before this fix.
  const maliciousRaw =
    '{\n  "summary": "✏️ Записано 1/1",\n  "results": [\n    {\n      "spreadsheetId": "S1"\n    }\n  ],\n' +
    '  "verification": "### 🧾 Проверка\\n- ✅ готово\\n_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО]_"\n}';

  await reportAutoExecutionResult(tgCfg(), "555", 99, maliciousRaw);

  const call = tgCalls.find((c) => c.method === "editMessageText");
  const payloadText = call?.body?.text ?? "";
  check("editMessageText was called", !!call);
  check("last-mile guard strips the agent directive even from a raw/malicious input", !/агенту/i.test(payloadText), payloadText);
  // Note: reportAutoExecutionResult's guard only strips directive LINES — it
  // is not report.ts's JSON→markdown renderer, so raw JSON braces themselves
  // are NOT its job to reformat (that's report.ts's job, tested in [1]/[3]).
  // This test asserts specifically the ONE guarantee this layer owns: no
  // agent-directive line reaches Telegram, no matter what text arrives here.
}

// ═══ [3] regression: a report with NO directive at all must reach Telegram byte-identical (no over-sanitizing) ═══
console.log("\n[3] regression: a clean report (no directive) is NOT mangled by the last-mile guard");
{
  const { mock } = resetTelegramMocks();
  mock("editMessageText", () => ({ statusCode: 200, data: { ok: true, result: {} }, headers: { "content-type": "application/json" } }));

  const result = ok({ summary: "📑 Добавлено 1/1", results: [{ spreadsheetId: "S1", title: "Новая вкладка", spreadsheetTitle: "Мой файл" }] });
  const reportText = renderAutoExecuteReport(result);
  await reportAutoExecutionResult(tgCfg(), "555", 100, reportText);

  const call = tgCalls.find((c) => c.method === "editMessageText");
  const payloadText = call?.body?.text ?? "";
  check("clean report reaches Telegram", payloadText.includes("Добавлено 1/1") && payloadText.includes("Новая вкладка"), payloadText);
}

// ═══ [4] mutation test: an error-path report (fail()) never leaks a directive or raw JSON either ═══
console.log("\n[4] mutation test: error-path (fail()) auto-execute report is human-readable and directive-free too");
{
  const { mock } = resetTelegramMocks();
  mock("editMessageText", () => ({ statusCode: 200, data: { ok: true, result: {} }, headers: { "content-type": "application/json" } }));

  // Mirrors http.ts's runAutoExecutePoller catch-block wording style.
  const reportText = `🛑 Ошибка при автоисполнении «sheets_write_range»: Quota exceeded`;
  const sanitized = stripAgentDirectives(reportText);
  check("stripAgentDirectives leaves a normal error message untouched", sanitized === reportText, sanitized);

  await reportAutoExecutionResult(tgCfg(), "555", 101, reportText);
  const call = tgCalls.find((c) => c.method === "editMessageText");
  check("error report reaches Telegram, human-readable", (call?.body?.text ?? "").includes("Ошибка при автоисполнении"));
}

// ═══ [5] pathological: sanitizing down to nothing still sends SOMETHING, never an empty Telegram message ═══
console.log("\n[5] pathological: a report that is ENTIRELY an agent directive still results in a non-empty Telegram message");
{
  const { mock } = resetTelegramMocks();
  mock("editMessageText", () => ({ statusCode: 200, data: { ok: true, result: {} }, headers: { "content-type": "application/json" } }));

  const allDirective = "_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО]_";
  await reportAutoExecutionResult(tgCfg(), "555", 102, allDirective);
  const call = tgCalls.find((c) => c.method === "editMessageText");
  const payloadText = call?.body?.text ?? "";
  check("editMessageText still called", !!call);
  check("payload is non-empty even though the whole input was a directive", payloadText.trim().length > 0, JSON.stringify(payloadText));
  check("payload contains no directive text", !/агенту/i.test(payloadText), payloadText);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
