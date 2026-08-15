/**
 * consentHub.ts — backend-логика веб-хаба подтверждений, часть 2 ТЗ
 * `TZ_consent_web_hub.md`. ЭТО НЕ сам хаб (страница/агрегатор четырёх
 * соседей — то живёт в gmail-mcp, вне зоны этой задачи): здесь только два
 * маршрута, которые есть в КАЖДОМ из 5 сервисов —
 *   `GET  /pending-consents`         — список СВОИХ манифестов AWAITING_CONSENT;
 *   `POST /pending-consents/decide`  — подтвердить/отклонить один из них.
 *
 * Логика вынесена из http.ts в отдельный, ЧИСТЫЙ (без Express Request/
 * Response) модуль по тому же приёму, что `selectLegacyOrOnboardingUser` в
 * http.ts — так её можно юнит-тестировать с фейковым store/executor, без
 * реального HTTP-сервера и без Postgres (см. `scripts/test-consent-hub.mjs`).
 *
 * ЧЕСТНЫЙ ОСТАТОЧНЫЙ ПРЕДЕЛ (аналог по духу gate.md §3.4, задокументировано
 * прямо в ТЗ): `consent_manifests` НЕ хранит текст превью, который ушёл бы в
 * Telegram/модели — только `payload` (сырой батч) и `objectHash`. Схему
 * НЕ мигрируем (ТЗ §2 "Что НЕ трогать" — "выводи title/summary из превью, а
 * не мигрируй таблицу"), поэтому `title`/`summary`/`preview` в
 * `GET /pending-consents` собираются из УЖЕ ИМЕЮЩИХСЯ полей манифеста
 * (`tool`/`accountLabel`/`createdAt`/`payload`), а не из настоящего
 * человекочитаемого текста плана — он нигде не сохраняется. Это осознанное
 * решение, а не недосмотр; см. отчёт по задаче.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ConsentStore, ConsentConfig, ConsentManifestRow } from "./consent.js";
import { canonicalJson, formatLaTime, tryAutoExecute, stripUrlQuery } from "./consent.js";
import type { AutoExecutorEntry, AutoExecutorCtx } from "./autoExecute.js";
import { runAutoExecutorSafely } from "./autoExecute.js";

// ───────────────────────── Секрет хаба ──────────────────────────────────────

/** Константное по времени сравнение секрета хаба (тот же приём, что
 * `secretMatches`/`secretTokenMatches` в http.ts/tg_approval.ts). */
export function hubSecretMatches(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ───────────────────────── GET /pending-consents ────────────────────────────

export interface PendingConsentItem {
  manifestId: string;
  tool: string;
  title: string;
  summary: string;
  preview: string;
  createdAt: number;
  expiresAt: number;
  accountLabel: string;
}

/** Строит один элемент списка из строки манифеста. `title`/`summary` — см.
 * файловый doc-comment про "остаточный предел": `payload`, а не хранимое
 * превью, — единственный источник контента, который у нас реально есть. */
export function pendingConsentItemFromRow(row: ConsentManifestRow): PendingConsentItem {
  return {
    manifestId: row.id,
    tool: row.tool,
    title: row.tool,
    summary: `${row.accountLabel} · ${formatLaTime(row.createdAt)}`,
    preview: canonicalJson(row.payload),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    accountLabel: row.accountLabel,
  };
}

export interface PendingConsentsStore {
  listAwaitingConsent(server: string, nowMs: number): Promise<ConsentManifestRow[]>;
}

export async function listPendingConsentsCore(
  store: PendingConsentsStore,
  server: string,
  nowMs: number,
): Promise<{ service: string; items: PendingConsentItem[] }> {
  const rows = await store.listAwaitingConsent(server, nowMs);
  return { service: server, items: rows.map(pendingConsentItemFromRow) };
}

// ───────────────────────── POST /pending-consents/decide ───────────────────

/** Метка вместо реплики человека для отказов через веб-хаб без комментария —
 * тот же принцип, что `TG_AUTO_REPLY_MARKER` в consent.ts: честно отражает
 * происхождение решения в аудит-логе, а не выглядит как настоящее "нет". */
export const HUB_REJECT_MARKER = "[веб-хаб: отклонено]";

export type ConsentHubDecision = "confirm" | "reject";

export interface ConsentHubDecideInput {
  manifestId: unknown;
  decision: unknown;
  comment?: unknown;
}

export interface ConsentHubDecideDeps {
  store: ConsentStore;
  cfg: ConsentConfig;
  /** Тот же реестр, что использует `runAutoExecutePoller` в http.ts
   * (`autoExecute.ts`'s `getAutoExecutor`) — `decide confirm` идёт РОВНО тем
   * же путём, что нажатие кнопки в Telegram: `tryAutoExecute` + этот же
   * per-tool executor, БЕЗ дублирования логики исполнения (ТЗ §2 п.2). */
  getExecutor: (tool: string) => AutoExecutorEntry | undefined;
  /** Строит контекст исполнения (клиенты Google + consent store) для
   * `executor.execute(...)`. `null` ⇒ нет доступного пользователя — тот же
   * honest-degradation случай, что уже обрабатывает `runAutoExecutePoller`. */
  buildExecCtx: () => Promise<AutoExecutorCtx | null>;
}

export type ConsentHubDecideResult =
  | { status: 200; body: { ok: true; outcome: "confirmed"; result: string } }
  | { status: 200; body: { ok: true; outcome: "refused" } }
  | { status: 200; body: { ok: false; outcome: "execution_failed" } }
  | { status: 400; body: { error: "bad_request" } }
  | { status: 404; body: { error: "not_found" } }
  | { status: 409; body: { error: "already_decided" | "binding_mismatch" | "not_supported" } }
  | { status: 410; body: { error: "expired" } }
  | { status: 500; body: { error: "no_user" } };

/**
 * Ядро `POST /pending-consents/decide` — без Express, чтобы тестироваться
 * офлайн (мок `store`/`getExecutor`/`buildExecCtx`, как `scripts/test-auto-
 * execute.mjs` тестирует `tryAutoExecute`). http.ts — тонкая обвязка вокруг
 * этой функции (парсинг `req.body`, авторизация секретом, `res.status(...)
 * .json(...)`).
 */
export async function decideConsentHubItem(
  input: ConsentHubDecideInput,
  deps: ConsentHubDecideDeps,
): Promise<ConsentHubDecideResult> {
  const manifestId = typeof input.manifestId === "string" ? input.manifestId.trim() : "";
  const decision = input.decision;
  const comment = typeof input.comment === "string" ? input.comment : undefined;
  if (!manifestId || (decision !== "confirm" && decision !== "reject")) {
    return { status: 400, body: { error: "bad_request" } };
  }

  const now = deps.cfg.now ?? Date.now;
  const row = await deps.store.getManifest(manifestId, deps.cfg.server);
  if (!row) return { status: 404, body: { error: "not_found" } };
  if (row.status !== "AWAITING_CONSENT") return { status: 409, body: { error: "already_decided" } };
  if (now() > row.expiresAt) return { status: 410, body: { error: "expired" } };

  if (decision === "reject") {
    const userReply = comment && comment.trim() ? comment.trim() : HUB_REJECT_MARKER;
    // Тот же путь отказа, что негация в requireConsent (consent.ts): помечаем
    // INVALIDATED и пишем аудит-строку — комментарий (если есть) идёт как
    // `userReply`, ровно как реплика человека из Telegram (ТЗ §2 п.2).
    await deps.store.invalidateManifest(manifestId, deps.cfg.server, userReply);
    await deps.store.appendConsentAudit({
      id: randomUUID(),
      ts: now(),
      server: deps.cfg.server,
      tool: row.tool,
      accountLabel: row.accountLabel,
      manifestId,
      objectHash: row.objectHash,
      userReply,
      checks: { source: "consent_hub" },
      outcome: "invalidated",
      refusalReason: "hub_reject",
      actor: "human",
    });
    return { status: 200, body: { ok: true, outcome: "refused" } };
  }

  // decision === "confirm" — переиспользуем tryAutoExecute + реестр
  // авто-исполнителей (autoExecute.ts), ТОТ ЖЕ путь, что нажатие кнопки в
  // Telegram (`runAutoExecutePoller` в http.ts): binding-чек (rehash),
  // атомарный consume, аудит, а затем РЕАЛЬНОЕ исполнение через
  // per-tool `executor.execute`. Никакой отдельной копии этой логики здесь.
  const executor = deps.getExecutor(row.tool);
  if (!executor) return { status: 409, body: { error: "not_supported" } };

  // Строим контекст исполнения (клиенты Google) ДО consumeManifest — тот же
  // порядок, что `runAutoExecutePoller` в http.ts (проверяет `user` ДО
  // цикла): манифест одноразовый, а `consumeManifest` внутри `tryAutoExecute`
  // необратим, так что "нет пользователя" обязан провалиться РАНЬШЕ, иначе
  // манифест сгорит без единого реального исполнения — потерянное согласие,
  // не просто неудобство.
  const ctx = await deps.buildExecCtx();
  if (!ctx) return { status: 500, body: { error: "no_user" } };

  const result = await tryAutoExecute(
    { manifestId, tool: row.tool, accountLabel: row.accountLabel },
    executor.rehash,
    deps.store,
    deps.cfg,
  );
  if (!result) {
    // tryAutoExecute уже покрывает: гонка (кто-то другой успел первым),
    // дрейф состояния (binding), TTL — все схлопываются в один и тот же
    // машиночитаемый исход для клиента хаба (мы уже проверили not_found/
    // already_decided/expired выше отдельно, так что сюда попадает
    // практически всегда именно дрейф/гонка).
    return { status: 409, body: { error: "binding_mismatch" } };
  }

  let reportText: string;
  try {
    reportText = await runAutoExecutorSafely(executor, result.payload, result.auditId, ctx, deps.store.updateConsentAuditOutcome);
  } catch (err) {
    // `runAutoExecutorSafely` уже дописала outcome:"failed" в аудит-строку
    // (см. её doc-comment) — здесь только решаем, что вернуть по HTTP.
    // НЕ пересказываем `err.message` наружу дословно (security-checklist.md
    // §6 — может содержать URL нижележащего API с query/токеном): хаб
    // получает машиночитаемый статус, полный текст остаётся в аудит-логе
    // (уже прогнан через `stripUrlQuery` внутри обёртки).
    console.error(
      `POST /pending-consents/decide: execute упал для ${row.tool}/${manifestId}:`,
      stripUrlQuery(err instanceof Error ? err.message : String(err)),
    );
    return { status: 200, body: { ok: false, outcome: "execution_failed" } };
  }
  return { status: 200, body: { ok: true, outcome: "confirmed", result: reportText } };
}
