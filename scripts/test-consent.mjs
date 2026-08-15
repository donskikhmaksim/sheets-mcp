#!/usr/bin/env node
/**
 * Offline unit-тест ядра consent-гейта (`src/consent.ts`). Чистая логика:
 * фейковый in-memory ConsentStore, инъекция часов — ни БД, ни сети.
 *
 * Ported byte-for-byte from gmail-mcp/scripts/test-consent.mjs (consent.ts is
 * the same generic module, copied verbatim — mcp-development-standard
 * `references/development-pipeline.md` T2). Only the tool names in the test
 * scenarios (sheets_write_range/sheets_clear_range in place of
 * gmail_send/gmail_forward) and `cfg` (server="sheets",
 * minConsentGapMs=2000 — the gate.md §3.3(5) generic default, NOT gmail's
 * mail-specific 10000/5000 override) differ; consent.ts's logic under test
 * is tool-agnostic.
 *
 * Запуск (Node ≥ 22.18 грузит .ts напрямую, tsx/build не нужны):
 *   node scripts/test-consent.mjs
 *
 * Покрывает все 6 проверок gate.md §3.3 по отдельности + фазу плана.
 */
import {
  requireConsent,
  classifyReply,
  canonicalJson,
  sha256,
} from "../src/consent.ts";

// ── фейковое хранилище + управляемые часы ───────────────────────────────────

const clock = { t: 1_700_000_000_000 }; // фиксированный старт (epoch ms)
const now = () => clock.t;

function makeStore() {
  const manifests = new Map();
  const audits = [];
  return {
    manifests,
    audits,
    async createManifest(input) {
      manifests.set(input.id, {
        ...input,
        status: "AWAITING_CONSENT",
        consumedAt: null,
        userReply: null,
      });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      if (!r || r.server !== server) return null;
      return { ...r };
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server) return null;
      if (r.status !== "AWAITING_CONSENT") return null;
      if (clock.t >= r.expiresAt) return null; // TTL — как `expires_at > NOW()` в БД
      r.status = "DONE";
      r.consumedAt = clock.t;
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
    // Опциональный метод контракта (consent.ts) — им sync-wait достаёт
    // ФАКТИЧЕСКИЙ результат чужого исполнения (пруф post-verify), чтобы
    // отчёт `already_executed` не был голым «исполнено где-то там».
    async getExecutionAudit(manifestId, server) {
      const a = [...audits]
        .reverse()
        .find(
          (x) =>
            x.manifestId === manifestId &&
            x.server === server &&
            (x.outcome === "confirmed" || x.outcome === "failed"),
        );
      return a
        ? { id: a.id, outcome: a.outcome, postVerifyResult: a.postVerify ?? null, error: a.error ?? null, actor: a.actor ?? null }
        : null;
    },
  };
}

/** Симуляция того, что делает веб-хаб (`POST /pending-consents/decide`):
 * атомарно консьюмит манифест, пишет аудит-строку исполнения и дописывает в
 * неё пруф post-verify — ровно как `tryAutoExecute` + per-tool `execute`. */
async function simulateWebHubExecute(store, id, { postVerify = null, error = null } = {}) {
  await store.consumeManifest(id, "sheets", "[веб-хаб: подтверждено]");
  const auditId = "audit-" + id.slice(0, 8);
  await store.appendConsentAudit({
    id: auditId,
    ts: 1,
    server: "sheets",
    tool: "sheets_write_range",
    accountLabel: "work",
    manifestId: id,
    objectHash: null,
    userReply: "[веб-хаб: подтверждено]",
    checks: { source: "web_hub" },
    outcome: error ? "failed" : "confirmed",
    actor: "web",
  });
  await store.updateConsentAuditOutcome(auditId, { postVerify, error, outcome: error ? "failed" : "confirmed" });
  return auditId;
}

const cfg = {
  server: "sheets",
  consentTtlMs: 3_600_000, // 1 ч
  minConsentGapMs: 2_000, // дефолт gate.md §3.3(5) — не почтовый override (Q3)
  sendBatchMax: 10,
  now,
};

// payload и билдеры плана
const PAYLOAD = { account: "work", items: [{ spreadsheetId: "SHEET1", range: "Sheet1!A1", values: [["x"]] }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({
  payload: PAYLOAD,
  objectHash: OBJHASH,
  preview: "### 📤 План: Запись в диапазон(ы) — 1\n\n- **«SHEET1»** Sheet1!A1",
  batchSize: 1,
});
// СИМУЛЯЦИЯ «мир не изменился»: в тесте нет реального объекта для перечитывания,
// поэтому rehash отдаёт тот же хеш → binding проходит. В боевом A3 rehash ОБЯЗАН
// перечитать живое состояние по id и захешировать ЕГО (не аргумент) — см.
// контракт ConsentAddressing/rehash в consent.ts. Тест 9 моделирует ИЗМЕНЕНИЕ мира.
const rehash = (payload) => sha256(payload);

// ── харнесс проверок ────────────────────────────────────────────────────────

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// helper: построить план и вернуть {store, manifestId}
async function buildPlan(overrides = {}) {
  const store = makeStore();
  const dec = await requireConsent({
    tool: "sheets_write_range",
    accountLabel: "work",
    plan,
    rehash,
    store,
    cfg,
    ...overrides,
  });
  return { store, dec };
}

// ── 0. хелперы canonicalJson / sha256 ───────────────────────────────────────
console.log("\n[0] canonicalJson / sha256 детерминизм");
check(
  "порядок ключей не влияет на canonicalJson",
  canonicalJson({ b: 1, a: { d: 4, c: 3 } }) === canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
);
check("sha256 стабилен для эквивалентных объектов", sha256({ x: 1, y: 2 }) === sha256({ y: 2, x: 1 }));
check("sha256 различает разные payload", sha256({ x: 1 }) !== sha256({ x: 2 }));

// ── 1. фаза плана ───────────────────────────────────────────────────────────
console.log("\n[1] фаза плана: planned, манифест создан, ничего не consumed");
{
  const { store, dec } = await buildPlan();
  check("kind=planned", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("манифест создан", store.manifests.size === 1);
  check("статус AWAITING_CONSENT", [...store.manifests.values()][0].status === "AWAITING_CONSENT");
  check("превью несёт id плана", dec.kind === "planned" && dec.preview.includes(dec.manifestId));
  check("превью просит показать дословно и ждать", dec.preview.includes("дождись его ответа"));
  check("превью помечает истечение в PT", dec.preview.includes("PT"));
  check("в фазе плана аудит-мутация не пишется", store.audits.length === 0);
}

// ── 2. только один из пары → refused «нужны оба» ────────────────────────────
console.log("\n[2] половина пары (только manifest_id или только user_reply) → 🛑");
{
  const store = makeStore();
  const d1 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: "x", plan, rehash, store, cfg });
  check("только id → refused", d1.kind === "refused" && d1.result.includes("Нужны оба"), d1.result?.slice(0, 60));
  const d2 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", userReply: "да", plan, rehash, store, cfg });
  check("только reply → refused", d2.kind === "refused" && d2.result.includes("Нужны оба"));
  check("манифест НЕ создан", store.manifests.size === 0);
  check("🛑 в заголовке отказа", d1.result.includes("🛑"));
}

// ── 3. батч > капа → 🛑 без манифеста ───────────────────────────────────────
console.log("\n[3] батч больше SEND_BATCH_MAX → 🛑, манифест не создан");
{
  const store = makeStore();
  const bigPlan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "p", batchSize: 11 });
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan: bigPlan, rehash, store, cfg });
  check("kind=refused", dec.kind === "refused");
  check("сообщение про разбивку", dec.result.includes("Разбей") || dec.result.includes("больше предела"), dec.result?.slice(0, 80));
  check("манифест НЕ создан", store.manifests.size === 0);
}

// ── 4. happy path: план → (пауза > gap) → «да» → confirmed ──────────────────
console.log("\n[4] полный путь: план → подтверждение «да» → confirmed, payload из манифеста");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000; // прошло 6 с — анти-дуплет пройден
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да, отправляй", plan, rehash, store, cfg });
  check("kind=confirmed", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 80));
  check("payload взят ИЗ манифеста", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
  check("возвращён auditId", dec.kind === "confirmed" && typeof dec.auditId === "string");
  check("манифест теперь DONE", store.manifests.get(id).status === "DONE");
  check("аудит-строка confirmed записана", store.audits.some((a) => a.outcome === "confirmed"));
  check("user_reply в аудите дословно", store.audits.at(-1).userReply === "да, отправляй");
  check("аудит несёт результаты 6 проверок", store.audits.at(-1).checks.oneShot === "ok" && store.audits.at(-1).checks.binding === "ok");
}

// ── 5. анти-дуплет: план+execute в одном ходе → 🛑, манифест ЖИВ ─────────────
console.log("\n[5] план+execute в одном ходе (gap<5с) → 🛑, манифест остаётся живым");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  // никакой паузы: то же значение часов
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("kind=refused", dec.kind === "refused");
  check("сообщение про «слишком быстро»", dec.result.includes("Слишком быстро"), dec.result?.slice(0, 60));
  check("манифест НЕ consumed, всё ещё AWAITING", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 6. служебные строки → 🛑, манифест жив ──────────────────────────────────
console.log("\n[6] служебные user_reply (SEND 1 / JSON / uuid / id / имя инструмента) → 🛑");
for (const svc of ['SEND 1', '{"ok":true}', '550e8400-e29b-41d4-a716-446655440000', "MANIFEST_ID_SELF", "TOOL_SELF"]) {
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const reply = svc === "MANIFEST_ID_SELF" ? id : svc === "TOOL_SELF" ? "sheets_write_range" : svc;
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: reply, plan, rehash, store, cfg });
  check(`«${svc}» → refused (не ответ человека)`, dec.kind === "refused" && dec.result.includes("не ответ человека"), dec.result?.slice(0, 50));
  check(`«${svc}» — манифест жив`, store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 7. отрицание → инвалидация; «нет, не отправляй» НЕ читается как «да» ─────
console.log("\n[7] отрицание инвалидирует манифест; «нет, не отправляй» ≠ утверждение");
{
  check("classifyReply(«нет, не отправляй») = negation", classifyReply("нет, не отправляй", { manifestId: "x", tool: "sheets_write_range" }) === "negation");
  check("classifyReply(«да, отправляй») = affirmation", classifyReply("да, отправляй", { manifestId: "x", tool: "sheets_write_range" }) === "affirmation");
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "нет, не отправляй", plan, rehash, store, cfg });
  check("kind=refused (отменено)", dec.kind === "refused" && dec.result.includes("Отменено"));
  check("манифест INVALIDATED", store.manifests.get(id).status === "INVALIDATED");
  check("аудит помечен invalidated", store.audits.at(-1).outcome === "invalidated");
  // повторное исполнение инвалидированного → отказ
  clock.t += 1_000;
  const dec2 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("инвалидированный не исполняется", dec2.kind === "refused");
}

// ── 8. неопределённый ответ → 🛑, манифест жив ──────────────────────────────
console.log("\n[8] ни да ни нет → 🛑, манифест жив");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "наверное как-нибудь потом", plan, rehash, store, cfg });
  check("kind=refused (не понял)", dec.kind === "refused" && dec.result.includes("Не понял"), dec.result?.slice(0, 50));
  check("манифест жив", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 9. binding: состояние изменилось → 🛑, манифест не consumed ──────────────
console.log("\n[9] binding: rehash не совпал → 🛑, манифест не исполнен");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const changedRehash = () => sha256({ changed: true }); // «получатель уехал»
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash: changedRehash, store, cfg });
  check("kind=refused (состояние изменилось)", dec.kind === "refused" && dec.result.includes("изменилось"));
  check("манифест НЕ consumed", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 10. одноразовость: второй execute → 🛑 ──────────────────────────────────
console.log("\n[10] одноразовость: повтор manifest_id после успеха → 🛑");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const first = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("первый — confirmed", first.kind === "confirmed");
  clock.t += 1_000;
  const second = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("повтор — refused", second.kind === "refused");
}

// ── 11. TTL: исполнение после истечения → 🛑 ────────────────────────────────
console.log("\n[11] TTL: исполнение после expiresAt → 🛑");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += cfg.consentTtlMs + 1_000; // за пределом TTL
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("kind=refused (истёк)", dec.kind === "refused");
  check("манифест не DONE", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 12. сверка tool/account манифеста ───────────────────────────────────────
console.log("\n[12] чужой tool/account к манифесту → 🛑");
{
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const dWrongTool = await requireConsent({ tool: "sheets_clear_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("другой tool → refused", dWrongTool.kind === "refused" && dWrongTool.result.includes("не найден"));
  const dWrongAcct = await requireConsent({ tool: "sheets_write_range", accountLabel: "personal", manifestId: id, userReply: "да", plan, rehash, store, cfg });
  check("другой account → refused", dWrongAcct.kind === "refused");
  check("манифест не тронут", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ── 13. classifyReply — батарея ─────────────────────────────────────────────
console.log("\n[13] classifyReply — словари RU+EN");
{
  const ctx = { manifestId: "mid", tool: "sheets_write_range" };
  const aff = ["да", "ок", "окей", "давай", "подтверждаю", "отправляй", "го", "+", "yes", "confirm", "send it", "go ahead"];
  const neg = ["нет", "стоп", "отмена", "погоди", "не надо", "no", "cancel", "stop", "don't", "do not"];
  const unk = ["наверное", "хм", "что там по срокам"];
  for (const s of aff) check(`aff: «${s}»`, classifyReply(s, ctx) === "affirmation", classifyReply(s, ctx));
  for (const s of neg) check(`neg: «${s}»`, classifyReply(s, ctx) === "negation", classifyReply(s, ctx));
  for (const s of unk) check(`unk: «${s}»`, classifyReply(s, ctx) === "unknown", classifyReply(s, ctx));
  check("пустая строка → unknown", classifyReply("   ", ctx) === "unknown");
}

// ── 14. регрессии приёмки: negation-конструкция vs ложная инвалидация ───────
console.log("\n[14] дыры приёмки №1/№2: «not sure» ≠ да; «отправляй, не тяни» ≠ отрицание");
{
  const ctx = { manifestId: "mid", tool: "sheets_write_range" };

  // №1 — дыра безопасности: «not X» больше НЕ читается как affirmation.
  for (const s of ["not sure", "not ok", "not really"]) {
    check(`«${s}» НЕ affirmation`, classifyReply(s, ctx) !== "affirmation", classifyReply(s, ctx));
  }
  // «not sure»/«not ok» — конструкция «частица+affirmation» → отрицание.
  check("«not sure» = negation", classifyReply("not sure", ctx) === "negation");
  check("«not ok» = negation", classifyReply("not ok", ctx) === "negation");
  // «not really» — частица без утвердительной головы → unknown (не да и не инвалидация).
  check("«not really» = unknown", classifyReply("not really", ctx) === "unknown");

  // «не <affirmation>» → отрицание.
  check("«не отправляй» = negation", classifyReply("не отправляй", ctx) === "negation");
  check("«не надо» = negation", classifyReply("не надо", ctx) === "negation");

  // №2 — ложная инвалидация: «не» перед НЕ-головой = согласие, а не отрицание.
  check("«отправляй, не тяни» = affirmation", classifyReply("отправляй, не тяни", ctx) === "affirmation");
  // «чего ждёшь, не томи» — согласие без явного aff-слова → хотя бы НЕ отрицание.
  check("«чего ждёшь, не томи» ≠ negation", classifyReply("чего ждёшь, не томи", ctx) !== "negation");
  // одиночная частица «не» сама по себе — НЕ отрицание.
  check("одиночное «не» = unknown", classifyReply("не", ctx) === "unknown");
}

// ── 15. интеграция: «not sure» не мутирует; «не тяни» не роняет манифест ─────
console.log("\n[15] интеграция: «not sure» → НЕ confirmed; «отправляй, не тяни» → confirmed, манифест жив до этого");
{
  // №1 боевой сценарий: раньше «not sure» → confirmed (мутация исполнялась). Теперь — refused.
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "not sure", plan, rehash, store, cfg });
  check("«not sure» → НЕ confirmed", dec.kind !== "confirmed", dec.kind);
  check("«not sure» → refused", dec.kind === "refused");
  check("«not sure» манифест НЕ DONE", store.manifests.get(id).status !== "DONE");

  // №2 боевой сценарий: согласие с частицей «не» → confirmed, НЕ инвалидация.
  clock.t = 1_700_000_000_000;
  const p2 = await buildPlan();
  const id2 = p2.dec.manifestId;
  clock.t += 6_000;
  const dec2 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id2, userReply: "отправляй, не тяни", plan, rehash, store: p2.store, cfg });
  check("«отправляй, не тяни» → confirmed", dec2.kind === "confirmed", dec2.kind);
  check("«отправляй, не тяни» манифест DONE, не INVALIDATED", p2.store.manifests.get(id2).status === "DONE");

  // одиночное «не» в реплике не инвалидирует манифест (unknown → refuse, план жив).
  clock.t = 1_700_000_000_000;
  const p3 = await buildPlan();
  const id3 = p3.dec.manifestId;
  clock.t += 6_000;
  const dec3 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id3, userReply: "ну не знаю", plan, rehash, store: p3.store, cfg });
  check("«ну не знаю» → refused (не понял)", dec3.kind === "refused");
  check("«ну не знаю» манифест ЖИВ (AWAITING)", p3.store.manifests.get(id3).status === "AWAITING_CONSENT");
}

// ── 16. automation_key: checkAutomationKey не задан → побайтовый регресс ────
console.log("\n[16] automationKey присутствует, но checkAutomationKey НЕ передан (undefined) → обычный путь");
{
  const store = makeStore();
  // automationKey задан, DI не подключён — ветка должна быть выключена целиком,
  // requireConsent идёт обычным путём (фаза плана, т.к. нет id/reply).
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", automationKey: "some-key", plan, rehash, store, cfg });
  check("kind=planned (automation-ветка не сработала без DI)", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
}

// ── 17. automation_key валиден → исполнение с первого вызова ────────────────
console.log("\n[17] валидный automation_key (мок DI ok:true) → confirmed с первого вызова, без manifest_id/user_reply");
{
  const store = makeStore();
  const okCheck = async (key) => (key === "GOOD" ? { ok: true, channel: "window" } : { ok: false });
  const dec = await requireConsent({
    tool: "sheets_write_range",
    accountLabel: "work",
    automationKey: "GOOD",
    checkAutomationKey: okCheck,
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=confirmed с первого вызова", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 80));
  check("payload из плана", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
  check("manifestId пустой — манифест не создавался", dec.kind === "confirmed" && dec.manifestId === "");
  check("манифест в store реально НЕ создан", store.manifests.size === 0);
  check("аудит несёт actor=automation", store.audits.at(-1).actor === "automation");
  check("аудит несёт checks.automationKey = метка канала", store.audits.at(-1).checks.automationKey === "window");
  check("аудит outcome=confirmed", store.audits.at(-1).outcome === "confirmed");
}

// ── 18. automation_key невалиден → тихий fallthrough (НЕ ошибка) ────────────
console.log("\n[18] невалидный automation_key (мок DI ok:false) → тихий fallthrough на обычный план, не ошибка");
{
  const store = makeStore();
  const badCheck = async () => ({ ok: false });
  const dec = await requireConsent({
    tool: "sheets_write_range",
    accountLabel: "work",
    automationKey: "BAD",
    checkAutomationKey: badCheck,
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=planned (fallthrough, не отказ/ошибка)", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("превью не упоминает automation_key вообще", !dec.preview.includes("automation"));
  check("манифест создан обычным путём", store.manifests.size === 1);
}

// ── 19. automation-путь: rehash разошёлся → отказ, не тихое исполнение ──────
console.log("\n[19] automation-путь: binding (rehash) не совпал → refused, ничего не исполнено");
{
  const store = makeStore();
  const okCheck = async () => ({ ok: true, channel: "window" });
  const changedRehash = () => sha256({ changed: true });
  const dec = await requireConsent({
    tool: "sheets_write_range",
    accountLabel: "work",
    automationKey: "GOOD",
    checkAutomationKey: okCheck,
    plan,
    rehash: changedRehash,
    store,
    cfg,
  });
  check("kind=refused (состояние изменилось)", dec.kind === "refused" && dec.result.includes("изменилось"), dec.result?.slice(0, 60));
  check("манифест НЕ создан (не осталось артефакта)", store.manifests.size === 0);
  check("аудит НЕ несёт outcome=confirmed для этого вызова", !store.audits.some((a) => a.outcome === "confirmed"));
}

// ── 20. automation-путь: превышение sendBatchMax → тот же отказ, что обычно ─
console.log("\n[20] automation-путь: батч > SEND_BATCH_MAX → 🛑, тот же текст, что на обычном пути");
{
  const store = makeStore();
  const okCheck = async () => ({ ok: true, channel: "window" });
  const bigPlan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "p", batchSize: 11 });
  const dec = await requireConsent({
    tool: "sheets_write_range",
    accountLabel: "work",
    automationKey: "GOOD",
    checkAutomationKey: okCheck,
    plan: bigPlan,
    rehash,
    store,
    cfg,
  });
  check("kind=refused (батч)", dec.kind === "refused");
  check("тот же текст, что у обычного batch-cap отказа", dec.result.includes("Разбей") || dec.result.includes("больше предела"), dec.result?.slice(0, 80));
  check("манифест НЕ создан", store.manifests.size === 0);
}

// ── 21. automation-путь: пустой automationKey === обычный путь ──────────────
console.log("\n[21] automationKey = '' (пустая строка) → ветка не активируется, даже если DI подключён");
{
  const store = makeStore();
  const okCheck = async () => ({ ok: true, channel: "window" });
  const dec = await requireConsent({
    tool: "sheets_write_range",
    accountLabel: "work",
    automationKey: "",
    checkAutomationKey: okCheck,
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=planned (пустой ключ не считается присланным)", dec.kind === "planned");
}

// ── 22-27. Гибридное короткое ожидание (TZ_consent_web_hub.md §1) ───────────
// ВАЖНО про время: `sleep()` внутри consent.ts использует РЕАЛЬНЫЙ
// `setTimeout` (не инъекцию часов — та нужна только для сравнений
// `now() < deadline`, не для самой паузы). Поэтому ниже используются
// МАЛЕНЬКИЕ реальные миллисекунды (десятки, не 25000/1000 продовых
// дефолтов) — тесты остаются быстрыми, а обнаружение «человек подтвердил на
// N-й итерации» реализовано через СЧЁТЧИК вызовов мока (не через реальное
// время), так что результат детерминирован независимо от скорости машины.
const syncCfg = { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, syncWaitMs: 300, syncPollMs: 20 };

console.log("\n[22] Часть 1 тест 1: syncWaitMs=0 → побайтовая совместимость (обычное planned, без опроса)");
{
  const store = makeStore();
  let getManifestCalls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (...args) => { getManifestCalls++; return origGetManifest(...args); };
  const cfgOff = { ...syncCfg, syncWaitMs: 0, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgOff });
  check("kind=planned", dec.kind === "planned");
  check("ни одного опроса стора (syncWaitMs=0 ⇒ ветка не существует)", getManifestCalls === 0, getManifestCalls);
}

console.log("\n[23] Часть 1 тест 2: подтверждено (ТГ-approval) в окне ожидания → confirmed с ПЕРВОГО вызова, без превью");
{
  const store = makeStore();
  let checkApprovalCalls = 0;
  const tg = {
    enabledFor: () => true,
    notifyPlan: async () => ({ ok: true }),
    checkApproval: async () => {
      checkApprovalCalls++;
      return checkApprovalCalls < 2 ? "pending" : "approved"; // подтверждено на 2-й итерации опроса
    },
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync, tg });
  check("kind=confirmed с первого вызова", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 100));
  check("payload корректен (мутация реально произойдёт с этими данными)", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
  check("auditId присвоен", dec.kind === "confirmed" && typeof dec.auditId === "string");
  check("манифест реально DONE (одноразовость соблюдена)", [...store.manifests.values()][0].status === "DONE");
  check("проверено больше одной итерации (реально ждали)", checkApprovalCalls >= 2, checkApprovalCalls);
  check("аудит: actor=tg_auto, outcome=confirmed", store.audits.at(-1).actor === "tg_auto" && store.audits.at(-1).outcome === "confirmed");
}

console.log("\n[24] Часть 1 тест 3: отклонено (ТГ) в окне ожидания → refused, мутации нет");
{
  const store = makeStore();
  let checkApprovalCalls = 0;
  const tg = {
    enabledFor: () => true,
    notifyPlan: async () => ({ ok: true }),
    checkApproval: async () => {
      checkApprovalCalls++;
      return checkApprovalCalls < 2 ? "pending" : "rejected";
    },
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync, tg });
  check("kind=refused", dec.kind === "refused", JSON.stringify(dec).slice(0, 100));
  check("манифест INVALIDATED (не DONE — мутации не было)", [...store.manifests.values()][0].status === "INVALIDATED");
}

console.log("\n[25] Часть 1 тест 4: никто ничего не сделал за окно → ОБЫЧНОЕ planned; регресс — второй вызов работает");
{
  const store = makeStore();
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  check("kind=planned (окно исчерпано)", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("манифест всё ещё AWAITING_CONSENT", [...store.manifests.values()][0].status === "AWAITING_CONSENT");
  const id = dec.manifestId;
  // регресс: обычный второй вызов с manifest_id+user_reply по-прежнему работает.
  await new Promise((r) => setTimeout(r, 10));
  const dec2 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "да", plan, rehash, store, cfg: { ...cfgSync, minConsentGapMs: 0 } });
  check("второй вызов (обычный путь) → confirmed", dec2.kind === "confirmed", JSON.stringify(dec2).slice(0, 80));
}

console.log("\n[26] Часть 1 тест 5: binding-чек срабатывает и на sync-пути → refused, манифест НЕ consumed");
{
  const store = makeStore();
  let checkApprovalCalls = 0;
  const tg = {
    enabledFor: () => true,
    notifyPlan: async () => ({ ok: true }),
    checkApproval: async () => {
      checkApprovalCalls++;
      return checkApprovalCalls < 2 ? "pending" : "approved";
    },
  };
  const changedRehash = () => sha256({ changed: true }); // «мир уехал» за время ожидания
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash: changedRehash, store, cfg: cfgSync, tg });
  check("kind=refused (состояние изменилось)", dec.kind === "refused" && dec.result.includes("изменилось"), dec.result?.slice(0, 60));
  check("манифест НЕ consumed (остался AWAITING_CONSENT)", [...store.manifests.values()][0].status === "AWAITING_CONSENT");
}

console.log("\n[27] Часть 1 тест 6: automation_key + sync одновременно → исполняет СРАЗУ, ни одной итерации опроса");
{
  const store = makeStore();
  let getManifestCalls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (...args) => { getManifestCalls++; return origGetManifest(...args); };
  const okCheck = async () => ({ ok: true, channel: "window" });
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({
    tool: "sheets_write_range", accountLabel: "work", automationKey: "GOOD", checkAutomationKey: okCheck,
    plan, rehash, store, cfg: cfgSync,
  });
  check("kind=confirmed (automation_key, до фазы плана/ожидания)", dec.kind === "confirmed");
  check("ни одной итерации опроса стора (automation-ветка возвращает ДО sync-wait)", getManifestCalls === 0, getManifestCalls);
  check("манифест вообще не создавался", store.manifests.size === 0);
}

console.log("\n[28] чужой канал (веб-хаб) исполнил план в окне ожидания → kind=already_executed: НЕ отказ, НЕ повторное исполнение, с пруфом");
{
  const store = makeStore();
  // Симулируем `POST /pending-consents/decide`, случившийся ПОКА этот вызов
  // ждёт: манифест становится DONE ЧУЖИМИ руками (мутация уже сделана там),
  // и вместе с ним появляется аудит-строка исполнения с пруфом post-verify.
  let polls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) {
      await simulateWebHubExecute(store, id, {
        postVerify: "### 🧾 Независимая проверка записи\n\n- ✅ Лист1!A1:B2 — 4 ячейки на месте",
      });
    }
    return origGetManifest(id, server);
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  // Защита от двойного исполнения (главное, что нельзя сломать): payload
  // наружу не отдаётся — тул физически не может исполнить мутацию второй раз.
  check("kind=already_executed (не refused и не confirmed)", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("payload НЕ отдан наружу (двойного исполнения не будет)", dec.payload === undefined);
  check("текст — отчёт об исполнении, не отказ (нет 🛑)", !dec.report.includes("🛑") && dec.report.includes("ВЫПОЛНЕНА"), dec.report.slice(0, 160));
  check("ФАКТИЧЕСКИЙ результат (пруф post-verify) донесён до модели", dec.report.includes("Независимая проверка записи") && dec.report.includes("4 ячейки"), dec.report.slice(-260));
  check("auditId исполнившего канала возвращён", typeof dec.auditId === "string" && dec.auditId.startsWith("audit-"), String(dec.auditId));
  check("манифест DONE (исполнил веб-хаб, не requireConsent)", [...store.manifests.values()][0].status === "DONE");
}

console.log("\n[29] чужой DONE, но пруфа достать неоткуда (стор без getExecutionAudit) → честное «не удалось перепроверить»");
{
  const store = makeStore();
  delete store.getExecutionAudit;
  let polls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) await store.consumeManifest(id, "sheets", "[веб-хаб: подтверждено]");
    return origGetManifest(id, server);
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("честно сказано, что результат не перепроверен (а не выдуман успех)", dec.report.includes("не удалось перепроверить"), dec.report.slice(-260));
  check("auditId отсутствует", dec.auditId === undefined);
}

console.log("\n[30] чужое исполнение УПАЛО → отчёт помечен ⚠️ и называет ошибку");
{
  const store = makeStore();
  let polls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) await simulateWebHubExecute(store, id, { error: "Google API 403: insufficient permissions" });
    return origGetManifest(id, server);
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("заголовок ⚠️, а не ✅", dec.report.includes("⚠️") && !dec.report.includes("✅"), dec.report.slice(0, 120));
  check("текст ошибки донесён до модели", dec.report.includes("403"), dec.report.slice(-260));
}

console.log("\n[30a] добор пруфа: аудит-строка появляется сразу (confirmed), но post_verify_result дописывается позже — buildAlreadyExecutedReport дожидается, не сдаётся на первой попытке");
{
  const store = makeStore();
  let getExecAuditCalls = 0;
  store.getExecutionAudit = async () => {
    getExecAuditCalls++;
    if (getExecAuditCalls < 3) {
      // Строка УЖЕ есть (тот, кто исполнил, успел appendConsentAudit), но
      // пруф ещё не дописан — та самая гонка: updateConsentAuditOutcome с
      // пруфом придёт чуть позже, чем `executor.execute` реально завершится.
      return { id: "audit-late", outcome: "confirmed", postVerifyResult: null, error: null, actor: "web" };
    }
    return {
      id: "audit-late",
      outcome: "confirmed",
      postVerifyResult: "### 🧾 Независимая проверка\n\n- ✅ готово",
      error: null,
      actor: "web",
    };
  };
  let sleepCalls = 0;
  const fastSleep = async (ms) => { sleepCalls++; }; // без DI-часов — только для добора внутри buildAlreadyExecutedReport
  let polls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) await store.consumeManifest(id, "sheets", "[веб-хаб: подтверждено]");
    return origGetManifest(id, server);
  };
  const cfgSync = { ...syncCfg, now: undefined, sleep: fastSleep };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("добор реально попытался БОЛЬШЕ одного раза (getExecutionAudit)", getExecAuditCalls >= 3, `calls=${getExecAuditCalls}`);
  check("добор реально ждал между попытками (sleep DI вызван)", sleepCalls >= 2, `sleepCalls=${sleepCalls}`);
  check("итоговый отчёт содержит дождавшийся пруф, а не «не удалось перепроверить»", dec.report.includes("Независимая проверка") && dec.report.includes("готово"), dec.report.slice(-300));
  check("заголовок ✅ (пруф найден, binding в порядке)", dec.report.includes("✅"));
}

console.log("\n[30b] добор пруфа: пруф НИКОГДА не появляется — попыток не больше бюджета (6), отчёт честно говорит «не удалось перепроверить»");
{
  const store = makeStore();
  let getExecAuditCalls = 0;
  store.getExecutionAudit = async () => {
    getExecAuditCalls++;
    return { id: "audit-stuck", outcome: "confirmed", postVerifyResult: null, error: null, actor: "web" };
  };
  const fastSleep = async () => {};
  let polls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) await store.consumeManifest(id, "sheets", "[веб-хаб: подтверждено]");
    return origGetManifest(id, server);
  };
  const cfgSync = { ...syncCfg, now: undefined, sleep: fastSleep };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("добор остановился в пределах бюджета (≤6 попыток), а не завис", getExecAuditCalls <= 6, `calls=${getExecAuditCalls}`);
  check("добор реально пытался больше одного раза", getExecAuditCalls > 1, `calls=${getExecAuditCalls}`);
  check("честно сказано, что не удалось перепроверить (аудит есть, пруфа нет)", dec.report.includes("отсутствует") || dec.report.includes("не может"), dec.report.slice(-300));
}

console.log("\n[30c] чужое исполнение упало с ошибкой, содержащей URL с query (presigned-ссылка/токен) — в отчёте query вырезан, host+path остались");
{
  const store = makeStore();
  let polls = 0;
  const origGetManifest = store.getManifest.bind(store);
  store.getManifest = async (id, server) => {
    polls++;
    if (polls === 2) {
      await simulateWebHubExecute(store, id, {
        error: "Google API 403 at https://storage.googleapis.com/bucket/file?X-Goog-Signature=SECRETTOKEN123&X-Goog-Expires=900",
      });
    }
    return origGetManifest(id, server);
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check(
    "query-параметры (включая секретный токен) вырезаны из ответа модели",
    !dec.report.includes("SECRETTOKEN123") && !dec.report.includes("X-Goog-Signature"),
    dec.report.slice(-400),
  );
  check("host+path остались (диагностика не потеряна полностью)", dec.report.includes("storage.googleapis.com/bucket/file"), dec.report.slice(-400));
}

console.log("\n[31] ТГ-ветка sync-wait (особенность sheets-mcp) НЕ затронута: кнопка в окне → по-прежнему confirmed с payload");
{
  const store = makeStore();
  let checkApprovalCalls = 0;
  const tg = {
    enabledFor: () => true,
    notifyPlan: async () => ({ ok: true }),
    checkApproval: async () => (++checkApprovalCalls < 2 ? "pending" : "approved"),
  };
  const cfgSync = { ...syncCfg, now: undefined };
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", plan, rehash, store, cfg: cfgSync, tg });
  // Тут consumeManifest выигрываем МЫ, мутацию ещё НИКТО не делал — тул
  // обязан её исполнить, поэтому это честный confirmed, а не отчёт.
  check("kind=confirmed (мутацию делает вызывающий тул)", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 100));
  check("payload отдан наружу", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
