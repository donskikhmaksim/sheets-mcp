#!/usr/bin/env node
/**
 * Offline unit-тест бэкенд-логики веб-хаба подтверждений (`src/consentHub.ts`
 * — Часть 2 ТЗ `TZ_consent_web_hub.md`). Чистая логика: фейковый in-memory
 * ConsentStore + фейковый реестр авто-исполнителей, ни БД, ни сети, ни
 * реального Express — тот же приём, что `scripts/test-auto-execute.mjs`
 * тестирует `tryAutoExecute`.
 *
 * Покрывает тестовый план ТЗ §"Тестовый план", пункты 9-11 (применимые к
 * ОДНОМУ сервису — п.12 "страница" не входит, страница живёт в gmail-mcp) +
 * секрет/список отдельно. HTTP-уровневые 7/8 (404 без секрета/с неверным
 * секретом) покрыты отдельным скриптом `test-consent-hub-gate.mjs`
 * (реальный процесс, реальный fetch — только там, где действительно нужен
 * живой HTTP-роут, минимизируя дублирование медленных e2e-тестов).
 *
 * Запуск: node scripts/test-consent-hub.mjs  (после `npm run build` — см.
 * ниже: consentHub.ts, в отличие от consent.ts, ИМЕЕТ внутренние
 * относительные импорты (`./consent.js`, `./autoExecute.js`) — Node не
 * резолвит их напрямую из .ts (тот же приём, что test-sheets-gate.mjs
 * использует dist/ для tools/sheets.ts). npm test гоняет `npm run build`
 * перед этим скриптом.)
 */
import { hubSecretMatches, listPendingConsentsCore, decideConsentHubItem, pendingConsentItemFromRow, HUB_REJECT_MARKER } from "../dist/consentHub.js";
import { sha256, canonicalJson } from "../dist/consent.js";

const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;

function makeStore() {
  const manifests = new Map();
  const audits = [];
  return {
    manifests,
    audits,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
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
      if (clock.t >= r.expiresAt) return null;
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
    async listAwaitingConsent(server, nowMs) {
      return [...manifests.values()]
        .filter((r) => r.server === server && r.status === "AWAITING_CONSENT" && r.expiresAt > nowMs)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
  };
}

const cfg = { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, syncWaitMs: 0, syncPollMs: 1_000, now };

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

const PAYLOAD = { account: "work", items: [{ spreadsheetId: "SHEET1", range: "Sheet1!A1", values: [["x"]] }] };
const OBJHASH = sha256(PAYLOAD);
const rehashOk = (addressing) => sha256(addressing);
const rehashDrift = () => "different-hash-simulating-drift";

async function seedManifest(store, overrides = {}) {
  const id = overrides.id ?? `m-${Math.random().toString(36).slice(2)}`;
  await store.createManifest({
    id, server: "sheets", tool: "sheets_write_range", accountLabel: "work",
    payload: PAYLOAD, objectHash: OBJHASH, createdAt: clock.t, expiresAt: clock.t + 3_600_000,
    ...overrides,
  });
  return id;
}

// ── 0. hubSecretMatches ──────────────────────────────────────────────────────
console.log("\n[0] hubSecretMatches — константное сравнение, честные крайние случаи");
{
  check("верный секрет → true", hubSecretMatches("s3cr3t-value", "s3cr3t-value"));
  check("неверный секрет → false", !hubSecretMatches("wrong", "s3cr3t-value"));
  check("пустой ожидаемый секрет → false (не задан ⇒ ничего не матчит)", !hubSecretMatches("anything", ""));
  check("пустой предоставленный → false", !hubSecretMatches("", "s3cr3t-value"));
  check("разная длина → false, не бросает", !hubSecretMatches("short", "much-longer-secret-value"));
}

// ── 1. GET /pending-consents — список + деривация title/summary/preview ─────
console.log("\n[1] listPendingConsentsCore: только СВОИ AWAITING_CONSENT, не истёкшие");
{
  const store = makeStore();
  clock.t = 1_700_000_000_000;
  const id1 = await seedManifest(store, { id: "m1", createdAt: clock.t });
  await seedManifest(store, { id: "m2", server: "gmail" }); // чужой сервис — не должен попасть
  const id3 = await seedManifest(store, { id: "m3", createdAt: clock.t + 1000, expiresAt: clock.t + 5000 });
  await store.consumeManifest(id1, "sheets", "да"); // DONE — не должен попасть
  // истёкший — не должен попасть
  await seedManifest(store, { id: "m4", createdAt: clock.t - 10_000, expiresAt: clock.t - 1_000 });
  await store.createManifest({ id: "m5", server: "sheets", tool: "sheets_write_range", accountLabel: "work", payload: PAYLOAD, objectHash: OBJHASH, createdAt: clock.t + 2000, expiresAt: clock.t + 3600_000 });

  const result = await listPendingConsentsCore(store, "sheets", clock.t);
  check("service = 'sheets'", result.service === "sheets");
  const ids = result.items.map((it) => it.manifestId);
  check("DONE-манифест НЕ в списке", !ids.includes(id1));
  check("чужой сервис (gmail) НЕ в списке", !ids.includes("m2"));
  check("истёкший НЕ в списке", !ids.includes("m4"));
  check("живой AWAITING_CONSENT в списке", ids.includes(id3) && ids.includes("m5"));
  check("порядок — старые первыми (createdAt ASC)", ids.indexOf(id3) < ids.indexOf("m5"));
  const item3 = result.items.find((it) => it.manifestId === id3);
  check("title = имя тула (нет хранимого превью — честно из имеющихся полей)", item3.title === "sheets_write_range");
  check("summary несёт accountLabel", item3.summary.includes("work"));
  check("preview — детерминированный JSON payload'а (тот же canonicalJson)", item3.preview === canonicalJson(PAYLOAD));
  check("accountLabel/createdAt/expiresAt проброшены как есть", item3.accountLabel === "work" && item3.createdAt === clock.t + 1000);
}

console.log("\n[1b] pendingConsentItemFromRow — прямой юнит на билдер одного элемента");
{
  const row = { id: "mx", server: "sheets", tool: "sheets_clear_range", accountLabel: "personal", payload: { a: 1 }, objectHash: "h", status: "AWAITING_CONSENT", createdAt: clock.t, expiresAt: clock.t + 1000, consumedAt: null, userReply: null };
  const item = pendingConsentItemFromRow(row);
  check("manifestId = row.id", item.manifestId === "mx");
  check("tool проброшен", item.tool === "sheets_clear_range");
  check("preview парсится обратно в тот же объект", JSON.parse(item.preview).a === 1);
}

// ── 2. decide: bad_request ───────────────────────────────────────────────────
console.log("\n[2] decideConsentHubItem: некорректный ввод → 400 bad_request, стор не тронут");
{
  const store = makeStore();
  const deps = { store, cfg, getExecutor: () => undefined, buildExecCtx: async () => null };
  const r1 = await decideConsentHubItem({ manifestId: "", decision: "confirm" }, deps);
  check("пустой manifestId → 400", r1.status === 400 && r1.body.error === "bad_request");
  const r2 = await decideConsentHubItem({ manifestId: "x", decision: "maybe" }, deps);
  check("неизвестный decision → 400", r2.status === 400 && r2.body.error === "bad_request");
  const r3 = await decideConsentHubItem({ manifestId: 42, decision: "confirm" }, deps);
  check("нестроковый manifestId → 400 (не бросает)", r3.status === 400);
}

// ── 3. decide: not_found / already_decided / expired ────────────────────────
console.log("\n[3] decideConsentHubItem: not_found / already_decided / expired — машиночитаемые 4xx, не 500");
{
  const store = makeStore();
  clock.t = 1_700_000_000_000;
  const deps = { store, cfg, getExecutor: () => undefined, buildExecCtx: async () => null };

  const rMissing = await decideConsentHubItem({ manifestId: "does-not-exist", decision: "confirm" }, deps);
  check("несуществующий id → 404 not_found", rMissing.status === 404 && rMissing.body.error === "not_found");

  const idDone = await seedManifest(store, { id: "done1" });
  await store.consumeManifest(idDone, "sheets", "да");
  const rDone = await decideConsentHubItem({ manifestId: idDone, decision: "confirm" }, deps);
  check("уже DONE → 409 already_decided", rDone.status === 409 && rDone.body.error === "already_decided");

  const idExpired = await seedManifest(store, { id: "exp1", expiresAt: clock.t - 1 });
  const rExpired = await decideConsentHubItem({ manifestId: idExpired, decision: "confirm" }, deps);
  check("истёкший → 410 expired", rExpired.status === 410 && rExpired.body.error === "expired");
}

// ── 4. decide reject: комментарий → userReply, повтор невозможен ────────────
console.log("\n[4] Тест 10 ТЗ: decide reject с комментарием — манифест отклонён, комментарий как userReply");
{
  const store = makeStore();
  clock.t = 1_700_000_000_000;
  const deps = { store, cfg, getExecutor: () => undefined, buildExecCtx: async () => null };
  const id = await seedManifest(store);

  const r = await decideConsentHubItem({ manifestId: id, decision: "reject", comment: "не сейчас, перезвоню позже" }, deps);
  check("200, outcome=refused", r.status === 200 && r.body.ok === true && r.body.outcome === "refused");
  check("манифест INVALIDATED", store.manifests.get(id).status === "INVALIDATED");
  check("комментарий записан как userReply дословно", store.manifests.get(id).userReply === "не сейчас, перезвоню позже");
  const audit = store.audits.at(-1);
  check("аудит: outcome=invalidated, actor=human, refusalReason=hub_reject", audit.outcome === "invalidated" && audit.actor === "human" && audit.refusalReason === "hub_reject");
  check("аудит несёт тот же userReply, что и манифест", audit.userReply === "не сейчас, перезвоню позже");
}

console.log("\n[4b] decide reject БЕЗ комментария → честная метка вместо текста человека");
{
  const store = makeStore();
  const deps = { store, cfg, getExecutor: () => undefined, buildExecCtx: async () => null };
  const id = await seedManifest(store);
  await decideConsentHubItem({ manifestId: id, decision: "reject" }, deps);
  check("userReply = HUB_REJECT_MARKER (не выдуманное «нет» от имени человека)", store.manifests.get(id).userReply === HUB_REJECT_MARKER);
}

// ── 5. decide confirm: реально исполняет через executor, повтор → уже нет ───
console.log("\n[5] Тест 9 ТЗ: decide confirm — реально исполняет (мутация произошла), повтор → already_decided, без второй мутации");
{
  const store = makeStore();
  clock.t = 1_700_000_000_000;
  let executeCalls = 0;
  let lastCtx = null;
  const executor = {
    rehash: rehashOk,
    execute: async (payload, auditId, ctx) => {
      executeCalls++;
      lastCtx = ctx;
      return `Готово: записано в ${payload.items[0].spreadsheetId} (audit ${auditId})`;
    },
  };
  const deps = {
    store, cfg,
    getExecutor: (tool) => (tool === "sheets_write_range" ? executor : undefined),
    buildExecCtx: async () => ({ clients: { fake: true }, consentStore: store }),
  };
  const id = await seedManifest(store);

  const r1 = await decideConsentHubItem({ manifestId: id, decision: "confirm" }, deps);
  check("200, outcome=confirmed", r1.status === 200 && r1.body.ok === true && r1.body.outcome === "confirmed");
  check("result — реальный человекочитаемый текст отчёта исполнителя", typeof r1.body.result === "string" && r1.body.result.includes("Готово"));
  check("executor.execute вызван РОВНО один раз (мутация произошла один раз)", executeCalls === 1, executeCalls);
  check("манифест реально DONE", store.manifests.get(id).status === "DONE");
  check("контекст исполнения дошёл до executor.execute", lastCtx && lastCtx.clients.fake === true);

  const r2 = await decideConsentHubItem({ manifestId: id, decision: "confirm" }, deps);
  check("повторный decide на тот же manifestId → 409 already_decided", r2.status === 409 && r2.body.error === "already_decided");
  check("вторая мутация НЕ произошла (executor.execute всё ещё вызван только 1 раз)", executeCalls === 1, executeCalls);
}

console.log("\n[5b] decide confirm: тул без зарегистрированного executor → 409 not_supported, ничего не тронуто");
{
  const store = makeStore();
  const deps = { store, cfg, getExecutor: () => undefined, buildExecCtx: async () => null };
  const id = await seedManifest(store);
  const r = await decideConsentHubItem({ manifestId: id, decision: "confirm" }, deps);
  check("409 not_supported", r.status === 409 && r.body.error === "not_supported");
  check("манифест НЕ тронут (остался AWAITING_CONSENT)", store.manifests.get(id).status === "AWAITING_CONSENT");
}

console.log("\n[5c] decide confirm: дрейф состояния (binding mismatch) → 409, манифест НЕ consumed");
{
  const store = makeStore();
  const executor = { rehash: rehashDrift, execute: async () => "не должно вызваться" };
  const deps = { store, cfg, getExecutor: () => executor, buildExecCtx: async () => ({ clients: {}, consentStore: store }) };
  const id = await seedManifest(store);
  const r = await decideConsentHubItem({ manifestId: id, decision: "confirm" }, deps);
  check("409 binding_mismatch", r.status === 409 && r.body.error === "binding_mismatch");
  check("манифест НЕ consumed (остался AWAITING_CONSENT)", store.manifests.get(id).status === "AWAITING_CONSENT");
}

console.log("\n[5d] decide confirm: нет доступного пользователя (buildExecCtx → null) → 500 no_user, манифест НЕ сожжён впустую");
{
  const store = makeStore();
  const executor = { rehash: rehashOk, execute: async () => "не должно вызваться" };
  const deps = { store, cfg, getExecutor: () => executor, buildExecCtx: async () => null };
  const id = await seedManifest(store);
  const r = await decideConsentHubItem({ manifestId: id, decision: "confirm" }, deps);
  check("500 no_user", r.status === 500 && r.body.error === "no_user");
  check(
    "манифест НЕ consumed (остался AWAITING_CONSENT — согласие не потеряно впустую)",
    store.manifests.get(id).status === "AWAITING_CONSENT",
  );
}

console.log("\n[5e] decide confirm — executor.execute БРОСАЕТ исключение → аудит получает outcome:\"failed\" (не остаётся \"confirmed\" без пруфа), HTTP-ответ НЕ ok:true/confirmed, текст ошибки не пересказан наружу дословно");
{
  const store = makeStore();
  clock.t = 1_700_000_000_000;
  const boom = new Error("Google API 403 at https://storage.googleapis.com/bucket/f?X-Goog-Signature=SECRETTOKEN123");
  const executor = {
    rehash: rehashOk,
    execute: async () => {
      throw boom;
    },
  };
  const deps = {
    store, cfg,
    getExecutor: (tool) => (tool === "sheets_write_range" ? executor : undefined),
    buildExecCtx: async () => ({ clients: { fake: true }, consentStore: store }),
  };
  const id = await seedManifest(store);
  const r = await decideConsentHubItem({ manifestId: id, decision: "confirm" }, deps);
  check("НЕ 200/confirmed — исполнение упало", !(r.status === 200 && r.body.outcome === "confirmed"), JSON.stringify(r));
  check("HTTP-ответ не содержит текст исключения дословно (никакого SECRETTOKEN123)", !JSON.stringify(r.body).includes("SECRETTOKEN123"), JSON.stringify(r));
  check("манифест всё равно DONE (consumeManifest — атомарный one-shot, произошёл ДО execute)", store.manifests.get(id).status === "DONE");
  const failedRow = store.audits.find((a) => a.outcome === "failed");
  check("аудит-строка получила outcome:\"failed\" (гарантированно, несмотря на исключение)", !!failedRow, JSON.stringify(store.audits));
  check("текст ошибки в аудите есть, но query/токен из URL вырезаны", !!failedRow?.error && failedRow.error.includes("403") && !failedRow.error.includes("SECRETTOKEN123"), failedRow?.error);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
