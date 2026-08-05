#!/usr/bin/env node
/**
 * Offline unit-тест опционального Telegram-approval слоя (`src/tg_approval.ts`
 * — ПОРТИРОВАН ПОБАЙТОВО из gmail-mcp per mcp-development-standard). Никакого
 * реального Telegram и никакой БД — Telegram Bot API замокан через undici's
 * MockAgent (тот же HTTP-клиент, что использует сам модуль в проде), store —
 * in-memory Map с тем же атомарным контрактом, что store.ts's tg_approvals.
 *
 * ОТЛИЧИЕ ОТ gmail-mcp/scripts/test-tg-approval.mjs (задокументированный
 * пробел, не забытая работа): в gmail-mcp `src/consent.ts` уже несёт
 * `tg?: TgApprovalGate` на `RequireConsentParams` и ветку
 * `if (p.tg?.enabledFor(tool))` внутри `requireConsent()`, поэтому тот файл
 * гоняет сценарии ЧЕРЕЗ `requireConsent({ ..., tg: gate })`. В sheets-mcp
 * `src/consent.ts` этой поддержки НЕТ (расхождение между репо — см.
 * `src/server.ts`'s "KNOWN GAP" комментарий у `tgApprovalGate`), и трогать
 * consent.ts здесь не разрешено (mcp-development-standard: любая архитектурная
 * правка гейта требует отдельного обсуждения/одобрения). Поэтому этот файл
 * тестирует `tg_approval.ts` НАПРЯМУЮ, через его собственные экспорты
 * (`createTgApprovalGate`, `handleWebhook`, `registerWebhook`,
 * `secretTokenMatches`) — модуль полностью функционален и покрыт, только не
 * через requireConsent(). Как только consent.ts получит `tg`-ветку, эти же
 * сценарии стоит обернуть в requireConsent(), как в gmail-mcp.
 *
 * Запуск (Node ≥ 22.6 грузит .ts напрямую, tsx/build не нужны):
 *   node scripts/test-tg-approval.mjs
 */
import { MockAgent, setGlobalDispatcher } from "undici";
import {
  createTgApprovalGate,
  handleWebhook,
  registerWebhook,
  secretTokenMatches,
} from "../src/tg_approval.ts";

// ── управляемые часы ─────────────────────────────────────────────────────
const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;

const BOT_TOKEN = "TESTTOKEN";
let tgCalls = []; // { method, body } — для проверки "сколько раз/что вызвано"

/**
 * Свежий MockAgent на каждый вызов (а не общий на весь файл) — иначе
 * персистентные перехватчики из ОДНОГО раздела теста заслоняли бы перехватчики
 * следующего раздела на том же пути (sendMessage у обоих), потому что
 * `undici` матчит перехватчики в порядке регистрации, и `persist()` не даёт
 * более раннему исчезнуть.
 */
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

// ── in-memory TgApprovalStore — тот же атомарный контракт, что store.ts ────
function makeTgStore() {
  const approvals = new Map();
  return {
    approvals,
    async createTgApproval(input) {
      approvals.set(input.manifestId, { ...input, status: "PENDING", decidedAt: null });
    },
    async getTgApproval(manifestId, server) {
      const r = approvals.get(manifestId);
      if (!r || r.server !== server) return null;
      return { ...r };
    },
    async consumeTgDecision(manifestId, server, status) {
      const r = approvals.get(manifestId);
      if (!r || r.server !== server || r.status !== "PENDING") return null; // атомарный one-shot
      if (clock.t >= r.expiresAt) return null; // TTL-guard — зеркалит store.ts's `expires_at > $now`
      r.status = status;
      r.decidedAt = clock.t;
      return { ...r };
    },
    // Server-agnostic сиблинг — реальный путь `handleWebhook` для «один бот на
    // несколько серверов» (store.ts's `consumeTgDecisionAnyServer`): НЕ
    // фильтрует по server, потому что manifest_id — PRIMARY KEY (глобально
    // уникален), а вебхук физически не знает заранее, какому серверу
    // принадлежит нажатая кнопка.
    async consumeTgDecisionAnyServer(manifestId, status) {
      const r = approvals.get(manifestId);
      if (!r || r.status !== "PENDING") return null; // атомарный one-shot, БЕЗ фильтра по server
      if (clock.t >= r.expiresAt) return null; // TTL-guard
      r.status = status;
      r.decidedAt = clock.t;
      return { ...r };
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
    webhookOwner: false, // sheets-mcp is NEVER the owner in production (gmail-mcp is)
    ...overrides,
  };
}

const PLAN_META = { tool: "sheets_write_range", accountLabel: "default", expiresAt: now() + 3_600_000 };

// ── харнесс ──────────────────────────────────────────────────────────────
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// ═══ [1] enabledFor(): выключено по умолчанию / allowlist ═══
console.log("\n[1] enabledFor(): enabled=false → всегда false; allowlist фильтрует по имени тула");
{
  const off = createTgApprovalGate(tgCfg({ enabled: false }), makeTgStore(), now);
  check("enabled=false → enabledFor() всегда false", !off.enabledFor("sheets_write_range"));

  const noAllowlist = createTgApprovalGate(tgCfg({ toolsAllowlist: null }), makeTgStore(), now);
  check("enabled=true, allowlist=null → любой тул true", noAllowlist.enabledFor("sheets_clear_range"));

  const withAllowlist = createTgApprovalGate(
    tgCfg({ toolsAllowlist: new Set(["sheets_clear_range"]) }),
    makeTgStore(),
    now,
  );
  check("allowlist содержит tool → true", withAllowlist.enabledFor("sheets_clear_range"));
  check("allowlist НЕ содержит tool → false", !withAllowlist.enabledFor("sheets_write_range"));
}

// ═══ [2] fail-closed: sendMessage упал на фазе плана ═══
console.log("\n[2] fail-closed: sendMessage упал → notifyPlan возвращает ok:false, tg_approvals не создан");
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: false, description: "Bad Request: chat not found" }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg(), tgStore, now);

  const res = await gate.notifyPlan("m-fail", "### 📤 План\n\n- запись", PLAN_META);
  check("notifyPlan вернул ok:false", res.ok === false, JSON.stringify(res));
  check("error объясняет причину", /chat not found/i.test(res.error ?? ""));
  check("tg_approvals ничего не создал (send упал раньше store.createTgApproval)", tgStore.approvals.size === 0);
  check("sendMessage реально вызывался", tgCalls.some((c) => c.method === "sendMessage"));
}

// ═══ [3] happy path: sendMessage ок → PENDING-строка с message_id и inline-кнопками ═══
console.log("\n[3] notifyPlan happy path: sendMessage ок → tg_approvals PENDING, кнопки Подтвердить/Отклонить");
let planCtx; // переиспользуем в [4]/[5]/[6]/[7]
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: true, result: { message_id: 4242 } }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg(), tgStore, now);
  const manifestId = "m-happy";

  const res = await gate.notifyPlan(manifestId, "### 📤 План: Запись в диапазон(ы) — 1", PLAN_META);
  check("notifyPlan вернул ok:true", res.ok === true, JSON.stringify(res));

  const call = tgCalls.find((c) => c.method === "sendMessage");
  check("sendMessage содержит inline-кнопки Подтвердить/Отклонить", !!call, "no sendMessage call");
  const kb = call?.body?.reply_markup?.inline_keyboard?.[0] ?? [];
  check("кнопка ✅ Подтвердить с callback_data a:<id>", kb.some((b) => b.callback_data === `a:${manifestId}` && /Подтвердить/.test(b.text)));
  check("кнопка 🛑 Отклонить с callback_data r:<id>", kb.some((b) => b.callback_data === `r:${manifestId}` && /Отклонить/.test(b.text)));

  const row = tgStore.approvals.get(manifestId);
  check("tg_approvals содержит PENDING-строку с этим manifestId", !!row && row.status === "PENDING");
  check("message_id из ответа Telegram сохранён", row.messageId === 4242);
  check(
    "expiresAt = min(now+ttlMs, meta.expiresAt) — не превышает CONSENT-манифест",
    row.expiresAt === Math.min(now() + tgCfg().ttlMs, PLAN_META.expiresAt),
  );
  planCtx = { manifestId, tgStore, gate };
}

// ═══ [4] checkApproval сразу после плана → "pending" ═══
console.log("\n[4] checkApproval сразу после notifyPlan → pending (кнопку ещё не нажали)");
{
  const { manifestId, gate } = planCtx;
  check("checkApproval='pending'", (await gate.checkApproval(manifestId)) === "pending");
}

// ═══ [5] APPROVED через webhook-путь (consumeTgDecisionAnyServer) → checkApproval='approved' ═══
console.log("\n[5] нажата ✅ в Telegram (симулируем через webhook) → checkApproval='approved'");
{
  const { manifestId, tgStore, gate } = planCtx;
  const update = {
    callback_query: {
      id: "cbq-approve",
      from: { id: Number(tgCfg().ownerChatId) },
      data: `a:${manifestId}`,
      message: { message_id: 4242, chat: { id: tgCfg().ownerChatId } },
    },
  };
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  await handleWebhook(tgCfg(), tgStore, update);
  check("checkApproval='approved'", (await gate.checkApproval(manifestId)) === "approved");
  check("editMessageReplyMarkup вызван — кнопки сняты", tgCalls.some((c) => c.method === "editMessageReplyMarkup"));
  check(
    "answerCallbackQuery отвечает «Подтверждено»",
    tgCalls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "Подтверждено"),
  );
}

// ═══ [6] REJECTED через webhook-путь → checkApproval='rejected' ═══
console.log("\n[6] нажата 🛑 в Telegram → checkApproval='rejected'");
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: true, result: { message_id: 7 } }, headers: { "content-type": "application/json" } }));
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(tgCfg(), tgStore, now);
  const manifestId = "m-reject";
  await gate.notifyPlan(manifestId, "### 📤 План", PLAN_META);

  await handleWebhook(tgCfg(), tgStore, {
    callback_query: {
      id: "cbq-reject",
      from: { id: Number(tgCfg().ownerChatId) },
      data: `r:${manifestId}`,
      message: { message_id: 7, chat: { id: tgCfg().ownerChatId } },
    },
  });
  check("checkApproval='rejected'", (await gate.checkApproval(manifestId)) === "rejected");
}

// ═══ [7] TTL approval-запроса истёк → checkApproval='none' ═══
console.log("\n[7] TTL approval-запроса истёк (кнопку не нажали вовремя) → checkApproval='none'");
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: true, result: { message_id: 9 } }, headers: { "content-type": "application/json" } }));

  const tgStore = makeTgStore();
  const shortCfg = tgCfg({ ttlMs: 1_000 });
  const gate = createTgApprovalGate(shortCfg, tgStore, now);
  const manifestId = "m-ttl";
  await gate.notifyPlan(manifestId, "### 📤 План", { ...PLAN_META, expiresAt: now() + 3_600_000 });

  check("approval ещё pending сразу после плана", (await gate.checkApproval(manifestId)) === "pending");
  clock.t += 2_000; // прошёл approval TTL (1с)
  check("checkApproval='none' после истечения TTL — эквивалентно «никогда не запрашивали»", (await gate.checkApproval(manifestId)) === "none");
  clock.t = 1_700_000_000_000; // откатываем общие часы для следующих секций
}

// ═══ [7b] webhook TTL-guard: кнопка нажата ПОСЛЕ истечения approval-TTL ═══
console.log("\n[7b] кнопка нажата после истечения approval-TTL → решение НЕ записывается (остаётся PENDING)");
{
  const { mock } = resetTelegramMocks();
  mock("sendMessage", () => ({ statusCode: 200, data: { ok: true, result: { message_id: 11 } }, headers: { "content-type": "application/json" } }));
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const shortCfg = tgCfg({ ttlMs: 1_000 });
  const tgStore = makeTgStore();
  const gate = createTgApprovalGate(shortCfg, tgStore, now);
  const manifestId = "m-ttl-guard";
  await gate.notifyPlan(manifestId, "### 📤 План", { ...PLAN_META, expiresAt: now() + 3_600_000 });
  const rowBefore = tgStore.approvals.get(manifestId);
  check("approval-строка создана, PENDING", !!rowBefore && rowBefore.status === "PENDING");

  clock.t += 2_000; // approval-TTL (1с) истёк, но consent-манифест (в этом тесте не моделируется) ещё был бы жив

  const update = {
    callback_query: {
      id: "cbq-7b",
      from: { id: Number(shortCfg.ownerChatId) },
      data: `a:${manifestId}`,
      message: { message_id: 11, chat: { id: shortCfg.ownerChatId } },
    },
  };
  await handleWebhook(shortCfg, tgStore, update);

  const rowAfter = tgStore.approvals.get(manifestId);
  check(
    "webhook НЕ перевёл строку в APPROVED — осталась PENDING (TTL-guard в consumeTgDecisionAnyServer)",
    rowAfter.status === "PENDING",
    JSON.stringify(rowAfter),
  );
  check("decidedAt не проставлен", rowAfter.decidedAt === null);
  check(
    "editMessageReplyMarkup НЕ вызван — consumed=null, кнопки снимать нечего",
    tgCalls.filter((c) => c.method === "editMessageReplyMarkup").length === 0,
  );
  check(
    "answerCallbackQuery всё же вызван (спиннер гасится «уже обработано»)",
    tgCalls.filter((c) => c.method === "answerCallbackQuery").length === 1,
  );
  clock.t = 1_700_000_000_000;
}

// ═══ [8] webhook: неверный secret_token → отказ ═══
console.log("\n[8] webhook secret_token: неверный → secretTokenMatches=false");
{
  check("верный секрет матчится", secretTokenMatches("wh-secret-xyz", "wh-secret-xyz"));
  check("неверный секрет НЕ матчится", !secretTokenMatches("wrong", "wh-secret-xyz"));
  check("пустой предоставленный секрет НЕ матчится", !secretTokenMatches("", "wh-secret-xyz"));
  check("пустой ожидаемый секрет (фича не настроена) НЕ матчится ни с чем", !secretTokenMatches("anything", ""));
}

// ═══ [9] webhook: чужой from.id → игнор, store не тронут ═══
console.log("\n[9] webhook: callback от НЕ владельца → игнорируется, approval не меняется");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg();
  const tgStore = makeTgStore();
  await tgStore.createTgApproval({ manifestId: "m-owner-check", server: "sheets", chatId: cfg.ownerChatId, messageId: 1, createdAt: now(), expiresAt: now() + 3_600_000 });

  const update = {
    callback_query: {
      id: "cbq-1",
      from: { id: 999999 }, // НЕ ownerChatId (555)
      data: "a:m-owner-check",
      message: { message_id: 1, chat: { id: cfg.ownerChatId } },
    },
  };
  await handleWebhook(cfg, tgStore, update);

  const row = tgStore.approvals.get("m-owner-check");
  check("approval остался PENDING — чужой from.id не смог его решить", row.status === "PENDING");
  check("Telegram НЕ вызывался (ни answer, ни editMarkup) для чужого from.id", tgCalls.length === 0);
}

// ═══ [10] webhook: replay того же callback → второй раз не проходит ═══
console.log("\n[10] webhook: повторный (replay) callback того же решения — второй раз no-op");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg();
  const tgStore = makeTgStore();
  await tgStore.createTgApproval({ manifestId: "m-replay", server: "sheets", chatId: cfg.ownerChatId, messageId: 2, createdAt: now(), expiresAt: now() + 3_600_000 });

  const update = {
    callback_query: {
      id: "cbq-2",
      from: { id: Number(cfg.ownerChatId) },
      data: "a:m-replay",
      message: { message_id: 2, chat: { id: cfg.ownerChatId } },
    },
  };

  await handleWebhook(cfg, tgStore, update); // первый раз — реальное решение
  check("после первого вызова — APPROVED", tgStore.approvals.get("m-replay").status === "APPROVED");
  check("editMessageReplyMarkup вызван один раз (кнопки сняты)", tgCalls.filter((c) => c.method === "editMessageReplyMarkup").length === 1);

  const answersAfterFirst = tgCalls.filter((c) => c.method === "answerCallbackQuery").length;

  await handleWebhook(cfg, tgStore, update); // replay того же update
  check("статус НЕ изменился повторным вызовом (остался APPROVED)", tgStore.approvals.get("m-replay").status === "APPROVED");
  check("editMessageReplyMarkup НЕ вызван повторно (consumed=null на втором разе)", tgCalls.filter((c) => c.method === "editMessageReplyMarkup").length === 1);
  check("answerCallbackQuery всё же вызван второй раз (гасим часики), но решение не поменял", tgCalls.filter((c) => c.method === "answerCallbackQuery").length === answersAfterFirst + 1);

  // Попытка "перевернуть" решение replay'ем противоположной кнопки — тоже no-op.
  const flipUpdate = { ...update, callback_query: { ...update.callback_query, id: "cbq-3", data: "r:m-replay" } };
  await handleWebhook(cfg, tgStore, flipUpdate);
  check("REJECT-реплей после APPROVED не может перевернуть решение", tgStore.approvals.get("m-replay").status === "APPROVED");
}

// ═══ [11] webhook: игнорирует всё, что не callback_query ═══
console.log("\n[11] webhook: обновление без callback_query — игнорируется без ошибки");
{
  resetTelegramMocks();
  const cfg = tgCfg();
  const tgStore = makeTgStore();
  await handleWebhook(cfg, tgStore, { update_id: 1, message: { text: "hi" } });
  check("никакого обращения к Telegram", tgCalls.length === 0);
}

// ═══ [12] несколько серверов делят один бот: вебхук консюмит манифест ЧУЖОГО сервера ═══
// Регрессионный тест на сам фикс: cfg этого процесса — "sheets" (если бы
// sheets-mcp когда-нибудь стал владельцем вебхука), а approval-строка в БД
// принадлежит "calendar" (создана ДРУГИМ сервером через тот же общий
// бот-токен). Со старым фильтром `AND server = cfg.server` в
// `consumeTgDecision` это был бы 0-rows silent miss — approval "calendar"
// навсегда застревал бы в PENDING. После фикса (`consumeTgDecisionAnyServer`,
// БЕЗ фильтра по server) вебхук обязан консюмить его корректно именно потому,
// что manifest_id — глобально уникальный PRIMARY KEY, а не потому, что
// сервера совпали.
console.log("\n[12] вебхук на sheets консюмит approval манифеста, принадлежащего server=calendar");
{
  const { mock } = resetTelegramMocks();
  mock("answerCallbackQuery", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));
  mock("editMessageReplyMarkup", () => ({ statusCode: 200, data: { ok: true }, headers: { "content-type": "application/json" } }));

  const cfg = tgCfg({ server: "sheets" });
  const tgStore = makeTgStore();
  await tgStore.createTgApproval({
    manifestId: "m-cross-server",
    server: "calendar", // ЧУЖОЙ сервер, не cfg.server
    chatId: cfg.ownerChatId,
    messageId: 55,
    createdAt: now(),
    expiresAt: now() + 3_600_000,
  });

  // Контрольная проверка регрессии: старый server-scoped `consumeTgDecision`
  // с cfg.server="sheets" против строки server="calendar" — 0 rows, silent miss.
  const oldPathMiss = await tgStore.consumeTgDecision("m-cross-server", cfg.server, "APPROVED");
  check(
    "контроль: старый server-scoped путь ДЕЙСТВИТЕЛЬНО падал бы тут (0 rows) — подтверждает, что баг был реальным",
    oldPathMiss === null,
  );
  check("approval всё ещё PENDING после неудачной старой попытки", tgStore.approvals.get("m-cross-server").status === "PENDING");

  const update = {
    callback_query: {
      id: "cbq-cross-server",
      from: { id: Number(cfg.ownerChatId) },
      data: `a:m-cross-server`,
      message: { message_id: 55, chat: { id: cfg.ownerChatId } },
    },
  };
  await handleWebhook(cfg, tgStore, update);

  const row = tgStore.approvals.get("m-cross-server");
  check(
    "новый server-agnostic путь: вебхук на sheets консюмит APPROVED для манифеста server=calendar",
    row.status === "APPROVED",
    JSON.stringify(row),
  );
  check("decidedAt проставлен", row.decidedAt === clock.t);
}

// ═══ [13] registerWebhook: guard TG_WEBHOOK_OWNER ═══
// sheets-mcp никогда не является владельцем вебхука в проде (gmail-mcp — да).
// Без TG_WEBHOOK_OWNER=true (дефолт) registerWebhook обязан быть no-op —
// иначе sheets-mcp молча перезапишет чужой (gmail-mcp's) вебхук просто
// потому, что у него тоже включён TG_APPROVAL_ENABLED.
console.log("\n[13] registerWebhook: TG_WEBHOOK_OWNER не установлен/false → setWebhook НЕ вызывается");
{
  const { mock } = resetTelegramMocks();
  // Если бы registerWebhook всё-таки дошёл до сети, setWebhook ответил бы ok —
  // тест обязан провалиться на отсутствии самого вызова, а не на его результате.
  mock("setWebhook", () => ({ statusCode: 200, data: { ok: true, result: true }, headers: { "content-type": "application/json" } }));

  // (a) enabled=true, webhookOwner не задан (false по умолчанию через tgCfg()).
  await registerWebhook(tgCfg({ enabled: true }));
  check("webhookOwner отсутствует/false → setWebhook НЕ вызван", tgCalls.filter((c) => c.method === "setWebhook").length === 0);

  // (b) enabled=true, webhookOwner ЯВНО false.
  await registerWebhook(tgCfg({ enabled: true, webhookOwner: false }));
  check("webhookOwner=false явно → setWebhook по-прежнему НЕ вызван", tgCalls.filter((c) => c.method === "setWebhook").length === 0);

  // (c) контрольная проверка: с webhookOwner=true (и enabled=true) вызов ДОЛЖЕН пройти —
  // подтверждает, что guard не сломал сам happy-path, а именно гейтит его.
  // (Не отражает прод-конфигурацию sheets-mcp — только доказывает, что guard
  // именно УСЛОВНЫЙ, а не сломанный навсегда.)
  await registerWebhook(tgCfg({ enabled: true, webhookOwner: true }));
  check("webhookOwner=true → setWebhook ВЫЗВАН ровно один раз", tgCalls.filter((c) => c.method === "setWebhook").length === 1);
}

// ── итог ─────────────────────────────────────────────────────────────────
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
