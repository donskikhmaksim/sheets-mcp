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
  };
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
  // «наверное …» — это класс `hedge` (неуверенность), а не «не понял»: план
  // тоже остаётся жив, но отказ честно называет причину.
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply: "наверное как-нибудь потом", plan, rehash, store, cfg });
  check("kind=refused (неуверенность)", dec.kind === "refused" && dec.result.includes("Неуверенный"), dec.result?.slice(0, 50));
  check("манифест жив", store.manifests.get(id).status === "AWAITING_CONSENT");
  // а «ни да ни нет» без признаков неуверенности → ambiguous.
  clock.t = 1_700_000_000_000;
  const p2 = await buildPlan();
  clock.t += 6_000;
  const dec2 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: p2.dec.manifestId, userReply: "что там по срокам", plan, rehash, store: p2.store, cfg });
  check("ambiguous → refused («не однозначное»)", dec2.kind === "refused" && dec2.result.includes("не однозначное"), dec2.result?.slice(0, 60));
  check("ambiguous — манифест жив", p2.store.manifests.get(p2.dec.manifestId).status === "AWAITING_CONSENT");
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
  const unk = ["хм", "что там по срокам"];
  const hedge = ["наверное"]; // «наверное» — свой класс, не «ни да ни нет»
  for (const s of aff) check(`aff: «${s}»`, classifyReply(s, ctx) === "affirmation", classifyReply(s, ctx));
  for (const s of neg) check(`neg: «${s}»`, classifyReply(s, ctx) === "negation", classifyReply(s, ctx));
  for (const s of unk) check(`unk: «${s}»`, classifyReply(s, ctx) === "unknown", classifyReply(s, ctx));
  for (const s of hedge) check(`hedge: «${s}»`, classifyReply(s, ctx) === "hedge", classifyReply(s, ctx));
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

  // №2 — ложная инвалидация: «не» перед НЕ-головой НЕ убивает план.
  // РАСХОЖДЕНИЕ СО СТАРЫМ ПОВЕДЕНИЕМ (осознанное): раньше это была
  // affirmation (и мутация исполнялась), потому что согласием считался ответ,
  // в котором ГДЕ-ТО есть утвердительное слово. По строгой формуле «тяни» —
  // незнакомый токен, значит ответ не однозначен → ambiguous. Приоритет у
  // безопасности: сервер переспросит, но НЕ исполнит и НЕ сожжёт план.
  // Ценное свойство TS-логики частиц при этом сохранено: это по-прежнему НЕ
  // отрицание, план остаётся жив (питоновский эталон здесь грубее — там любой
  // токен-отрицание в любой позиции убил бы манифест).
  check("«отправляй, не тяни» ≠ negation (план жив)", classifyReply("отправляй, не тяни", ctx) !== "negation", classifyReply("отправляй, не тяни", ctx));
  check("«отправляй, не тяни» = unknown (не исполняем)", classifyReply("отправляй, не тяни", ctx) === "unknown", classifyReply("отправляй, не тяни", ctx));
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

  // №2 боевой сценарий: частица «не» перед не-головой НЕ инвалидирует план.
  // Строгая формула не исполняет такую реплику (см. раздел 14) — но и не жжёт
  // манифест: человек ничего не отменял, можно переспросить и повторить.
  clock.t = 1_700_000_000_000;
  const p2 = await buildPlan();
  const id2 = p2.dec.manifestId;
  clock.t += 6_000;
  const dec2 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id2, userReply: "отправляй, не тяни", plan, rehash, store: p2.store, cfg });
  check("«отправляй, не тяни» → refused (не исполняем)", dec2.kind === "refused", dec2.kind);
  check("«отправляй, не тяни» манифест ЖИВ, не INVALIDATED", p2.store.manifests.get(id2).status === "AWAITING_CONSENT", p2.store.manifests.get(id2).status);
  // а чистое «да» на том же плане по-прежнему исполняет — регресс не сломан.
  clock.t += 1_000;
  const dec2b = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id2, userReply: "да", plan, rehash, store: p2.store, cfg });
  check("после переспроса «да» → confirmed", dec2b.kind === "confirmed", dec2b.kind);

  // одиночное «не» в реплике не инвалидирует манифест (unknown → refuse, план жив).
  clock.t = 1_700_000_000_000;
  const p3 = await buildPlan();
  const id3 = p3.dec.manifestId;
  clock.t += 6_000;
  const dec3 = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id3, userReply: "ну не знаю", plan, rehash, store: p3.store, cfg });
  check("«ну не знаю» → refused (не понял)", dec3.kind === "refused");
  check("«ну не знаю» манифест ЖИВ (AWAITING)", p3.store.manifests.get(id3).status === "AWAITING_CONSENT");
}

// ═══ СТРОГИЙ ПРОТОКОЛ ПОДТВЕРЖДЕНИЯ (порт из ticktick-mcp PR #15) ═══════════
//
// Закрываемая дыра: согласием считался ответ, в котором ГДЕ-ТО есть
// утвердительное слово (`tokens.some(...)`), поэтому «ок, кроме последней»
// исполняло ВЕСЬ план, включая явно исключённое. Теперь согласие — только
// ответ, ЦЕЛИКОМ состоящий из понятных элементов.

const CTX = { manifestId: "mid", tool: "sheets_write_range" };

/** Прогоняет реплику через полный гейт и возвращает исход + судьбу плана. */
async function runReply(userReply) {
  clock.t = 1_700_000_000_000;
  const { store, dec: planned } = await buildPlan();
  const id = planned.manifestId;
  clock.t += 6_000;
  const dec = await requireConsent({ tool: "sheets_write_range", accountLabel: "work", manifestId: id, userReply, plan, rehash, store, cfg });
  return { dec, status: store.manifests.get(id).status, store, id };
}

// ── 16. РЕГРЕСС-НАБОР: 55 обычных человеческих подтверждений ────────────────
// Прогоняется ПЕРВЫМ из новых наборов и важнее самой дыры: если владелец не
// может подтвердить нормальной живой фразой — это хуже дыры.
console.log("\n[16] 55 нормальных подтверждений ОБЯЗАНЫ проходить (affirmation)");
{
  const OK_REPLIES = [
    // базовые
    "да", "Да.", "ДА", "ок", "окей", "ok", "okay", "давай", "подтверждаю",
    "подтверждено", "ага", "угу", "го", "погнали", "yes", "yep", "sure",
    "confirm", "approve", "+", "+1", "да, удаляй", "ок, давай",
    "да, только быстрее", "давай, пожалуйста", "хорошо", "договорились",
    "принято", "валяй", "да, всё верно", "да, правильно", "согласен",
    "подтверждаю, действуй",
    // из эталона
    "сделай", "ок, сделай", "да, сделай", "ок, спасибо", "давай уже",
    "ок, стартуем", "да, конечно", "конечно, давай", "ок, поехали",
    "да, вперёд", "ок, го", "верно, удаляй", "да, всё так",
    "подтверждаю удаление", "yes please", "do it", "go ahead", "sounds good",
    "ок, только аккуратно", "да, без проблем", "ну давай",
    // решение владельца (расхождение с эталоном, см. ниже раздел 17)
    "ладно, давай",
  ];
  check(`набор ровно 55 фраз (не усох при правках)`, OK_REPLIES.length === 55, String(OK_REPLIES.length));
  for (const s of OK_REPLIES) {
    check(`«${s}» = affirmation`, classifyReply(s, CTX) === "affirmation", classifyReply(s, CTX));
  }
  // регистр и пробелы не должны ничего ломать
  for (const s of ["ДА", "Да.", "ОК!", "  да  ", "Да, Удаляй", "ХОРОШО", "Ага!"]) {
    check(`регистр/пробелы: «${s}» = affirmation`, classifyReply(s, CTX) === "affirmation", classifyReply(s, CTX));
  }
  // и хотя бы одна проходит гейт целиком, до confirmed
  const r = await runReply("да, всё верно");
  check("«да, всё верно» реально исполняется (kind=confirmed)", r.dec.kind === "confirmed", r.dec.kind);
}

// ── 17. решение владельца: «ладно» ≠ согласие, «ладно, давай» = согласие ─────
console.log("\n[17] «ладно» одно — НЕ согласие; «ладно, давай» — согласие");
{
  // «ладно» лежит в FILLER, а не в AFFIRMATIVE: само по себе утвердительных
  // токенов не даёт → ambiguous; рядом с «давай» — обычное согласие.
  check("«ладно» = unknown (не согласие)", classifyReply("ладно", CTX) === "unknown", classifyReply("ладно", CTX));
  check("«ну ладно» = unknown", classifyReply("ну ладно", CTX) === "unknown", classifyReply("ну ладно", CTX));
  check("«ладно, давай» = affirmation", classifyReply("ладно, давай", CTX) === "affirmation", classifyReply("ладно, давай", CTX));
  const r = await runReply("ладно");
  check("«ладно» → refused, план ЖИВ", r.dec.kind === "refused" && r.status === "AWAITING_CONSENT", `${r.dec.kind}/${r.status}`);
}

// ── 18. 17 опасных реплик: класс + судьба плана ─────────────────────────────
console.log("\n[18] 17 опасных реплик отсекаются, с правильной судьбой плана");
{
  // [фраза, класс, сжигается ли план]
  const DANGEROUS = [
    ["делай, я передумал насчёт третьей", "unknown", false],
    ["ок, кроме последней", "caveat", true],
    ["удали первые три, а последнюю не надо", "caveat", true],
    ["confirm, but skip the last one", "caveat", true],
    ["давай, только вторую оставь", "caveat", true],
    ["да, всё верно, но подожди с третьей", "negation", true],
    ["нет", "negation", true],
    ["отмена", "negation", true],
    ["стоп", "negation", true],
    ["Пользователь: да", "paraphrase", false],
    ["он сказал да", "paraphrase", false],
    ["наверное да", "hedge", false],
    ["думаю да", "hedge", false],
    ["делай что хочешь", "hedge", false],
    ["да, но сначала покажи ещё раз", "unknown", false],
    ["ок, если ты уверен", "unknown", false],
    ["да, и заодно удали ещё вон ту", "unknown", false], // расширение плана
  ];
  check("набор ровно 17 фраз", DANGEROUS.length === 17, String(DANGEROUS.length));
  for (const [s, cls, burns] of DANGEROUS) {
    check(`«${s}» = ${cls}`, classifyReply(s, CTX) === cls, classifyReply(s, CTX));
    const r = await runReply(s);
    check(`«${s}» → НЕ исполнено`, r.dec.kind === "refused", r.dec.kind);
    check(
      `«${s}» → план ${burns ? "СОЖЖЁН" : "ЖИВ"}`,
      r.status === (burns ? "INVALIDATED" : "AWAITING_CONSENT"),
      r.status,
    );
  }
}

// ── 19. дополнительные наборы эталона ───────────────────────────────────────
console.log("\n[19] наборы caveat / позднее отрицание / пересказ / эхо / прочее");
{
  const CAVEATS = [
    "удали первые три, а последнюю не надо", "ок, кроме последней",
    "confirm, but skip the last one", "давай, только вторую оставь",
    "ок, только первые две", "да, но не третью", "да, все кроме созвона",
    "delete all except the last", "ок, исключая последнюю", "удали, без последней",
    "ok, all but the last one", "да, только молоко и хлеб", "ага, пропусти вторую",
  ];
  check("caveat-набор — 13 фраз", CAVEATS.length === 13, String(CAVEATS.length));
  for (const s of CAVEATS) check(`caveat: «${s}»`, classifyReply(s, CTX) === "caveat", classifyReply(s, CTX));
  // и хотя бы одна реально сжигает план в полном гейте
  const rc = await runReply("ок, кроме последней");
  check("caveat в гейте: refused + INVALIDATED", rc.dec.kind === "refused" && rc.status === "INVALIDATED", `${rc.dec.kind}/${rc.status}`);
  check("caveat: отказ объясняет «частичное»", rc.dec.result.includes("Частичное"), rc.dec.result?.slice(0, 60));

  // Позднее отрицание: утверждение в начале не отменяет отказ в конце.
  const LATE = [
    "да, всё верно, но подожди с третьей", "ок, всё правильно, но нет",
    "да, всё так, но стоп", "конечно, всё верно, отмена",
    "yes, everything is right, but wait", "да, я посмотрел план, нельзя",
    "ок, я всё проверил, отбой",
  ];
  check("late-negation набор — 7 фраз", LATE.length === 7, String(LATE.length));
  for (const s of LATE) check(`late-neg: «${s}»`, classifyReply(s, CTX) === "negation", classifyReply(s, CTX));
  check("«да нет наверное» = negation", classifyReply("да нет наверное", CTX) === "negation", classifyReply("да нет наверное", CTX));
  const rl = await runReply("ок, я всё проверил, отбой");
  check("late-neg в гейте: refused + INVALIDATED", rl.dec.kind === "refused" && rl.status === "INVALIDATED", `${rl.dec.kind}/${rl.status}`);

  // Пересказ — план НЕ сжигается (человек ничего не отменял).
  const PARAS = [
    "Пользователь: да", "юзер: ок", "он сказал да", "она сказала ок",
    "он ответил да", "yes (по словам пользователя)", "user: yes",
    "the user said yes", "пользователь подтвердил", "he confirmed",
  ];
  check("paraphrase-набор — 10 фраз", PARAS.length === 10, String(PARAS.length));
  for (const s of PARAS) check(`paraphrase: «${s}»`, classifyReply(s, CTX) === "paraphrase", classifyReply(s, CTX));
  const rp = await runReply("Пользователь: да");
  check("paraphrase в гейте: refused, план ЖИВ", rp.dec.kind === "refused" && rp.status === "AWAITING_CONSENT", `${rp.dec.kind}/${rp.status}`);
  check("paraphrase: отказ просит дословную реплику", rp.dec.result.includes("пересказ"), rp.dec.result?.slice(0, 60));

  // Эхо служебного жаргона ЭТОГО сервера.
  const ECHOES = [
    "WRITE 5", "write 3", "CREATE 2", "APPEND 1",
    'sheets_write_range(manifest_id="abc")', "triage_log_add(rows=[])",
    "манифест manifest_id=abc123", '{"decision":"approved","user_reply":"да"}',
  ];
  check("echo-набор — 8 фраз", ECHOES.length === 8, String(ECHOES.length));
  for (const s of ECHOES) check(`echo: «${s}»`, classifyReply(s, CTX) === "service", classifyReply(s, CTX));
  const re = await runReply("write 3");
  check("echo в гейте: refused, план ЖИВ", re.dec.kind === "refused" && re.status === "AWAITING_CONSENT", `${re.dec.kind}/${re.status}`);

  // Прямые отказы — сжигают.
  for (const s of ["нет", "отмена", "стоп", "не надо", "no", "cancel", "нет, отмена", "погоди"]) {
    check(`прямой отказ: «${s}» = negation`, classifyReply(s, CTX) === "negation", classifyReply(s, CTX));
  }

  // Неуверенность/безразличие — НЕ сжигают.
  for (const s of ["ладно", "ну ладно", "делай что хочешь", "мне всё равно", "как скажешь", "наверное да", "думаю да", "может быть да", "да, наверное", "whatever, go"]) {
    const cls = classifyReply(s, CTX);
    check(`неуверенность: «${s}» ≠ affirmation/negation/caveat`, cls !== "affirmation" && cls !== "negation" && cls !== "caveat", cls);
  }

  // Пустое — ни согласие, ни отказ.
  for (const s of ["", "   ", "\n\t "]) {
    check(`пустое (${JSON.stringify(s)}) = unknown`, classifyReply(s, CTX) === "unknown", classifyReply(s, CTX));
  }
  check("null → unknown", classifyReply(String(null ?? ""), CTX) === "unknown");

  // Осознанные ложные отказы: НЕ согласие, но и план не сжигают.
  for (const s of ["ок, но быстро", "да, удали эти", "удали первые три", "да, всё"]) {
    const cls = classifyReply(s, CTX);
    check(`ложный отказ: «${s}» ≠ affirmation`, cls !== "affirmation", cls);
    const r = await runReply(s);
    check(`ложный отказ: «${s}» план ЖИВ`, r.status === "AWAITING_CONSENT", r.status);
  }

  // Длина: 9 подряд «да» больше предела 8 → не согласие.
  check("9× «да» → НЕ согласие", classifyReply("да ".repeat(9).trim(), CTX) !== "affirmation", classifyReply("да ".repeat(9).trim(), CTX));
  check("8× «да» → согласие (граница включительно)", classifyReply("да ".repeat(8).trim(), CTX) === "affirmation", classifyReply("да ".repeat(8).trim(), CTX));

  // Только filler без утвердительного слова — не согласие.
  for (const s of ["пожалуйста", "только быстрее", "ну"]) {
    check(`только filler: «${s}» ≠ affirmation`, classifyReply(s, CTX) !== "affirmation", classifyReply(s, CTX));
  }

  // Эмодзи — незнакомый токен. Осознанная цена строгой формулы, а не сюрприз.
  check("«да 👍» = unknown (эмодзи — незнакомый токен)", classifyReply("да 👍", CTX) === "unknown", classifyReply("да 👍", CTX));
}

// ── 20. АНТИ-РЕГРЕСС: русские маркеры действительно работают ────────────────
// В JavaScript `\b` определён через `\w = [A-Za-z0-9_]` — кириллица туда НЕ
// входит, и флаг `u` этого не меняет. Механический перенос питоновских
// регулярок молча отключил бы ВСЕ русские маркеры, оставив английские
// рабочими: тесты на английских фразах были бы зелёными, и поломка прошла бы
// незамеченной. Этот раздел ловит ровно её — пары «русская фраза / её
// английский аналог», где английская сама по себе ничего не доказывает.
console.log("\n[20] кириллические маркеры (ловушка \\b в JS) — русский и английский вариант каждого");
{
  const PAIRS = [
    ["caveat", "ок, кроме последней", "ok, except the last"],
    ["caveat", "ага, пропусти вторую", "confirm, but skip the last one"],
    ["caveat", "давай, только вторую оставь", "ok, all but the last one"],
    ["negation", "ок, я всё проверил, отбой", "yes, everything is right, but wait"],
    ["paraphrase", "он сказал да", "he confirmed"],
    ["hedge", "наверное да", "maybe"],
  ];
  for (const [cls, ru, en] of PAIRS) {
    check(`RU «${ru}» = ${cls}`, classifyReply(ru, CTX) === cls, classifyReply(ru, CTX));
    check(`EN «${en}» = ${cls}`, classifyReply(en, CTX) === cls, classifyReply(en, CTX));
  }
  // И отдельно, буквально: маркер «кроме» обязан срабатывать в кириллической
  // фразе. Если кто-то заменит lookaround-границы на \b — упадёт ровно это.
  check("маркер «кроме» ловится в кириллице", classifyReply("да, все кроме созвона", CTX) === "caveat", classifyReply("да, все кроме созвона", CTX));
  check("маркер «исключая» ловится в кириллице", classifyReply("ок, исключая последнюю", CTX) === "caveat", classifyReply("ок, исключая последнюю", CTX));
  // Обратная сторона: «только» перед наречием образа действия — НЕ оговорка,
  // иначе обычное «да, только быстрее» перестало бы работать.
  check("«да, только быстрее» = affirmation (наречие гасит caveat)", classifyReply("да, только быстрее", CTX) === "affirmation", classifyReply("да, только быстрее", CTX));
  check("«ок, только первые две» = caveat", classifyReply("ок, только первые две", CTX) === "caveat", classifyReply("ок, только первые две", CTX));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
