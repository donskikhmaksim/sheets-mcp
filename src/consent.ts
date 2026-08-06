/**
 * consent.ts — единая точка согласия (consent-гейт) plan → execute.
 *
 * Нормативная спецификация: `mcp-development-standard/references/gate.md` §3.
 * ТЗ: раздел A (`TZ-google-mcp-consent-gate.md`).
 *
 * Это GENERIC-модуль. Он НЕ импортирует ни store, ни config сервера напрямую —
 * `store`, `cfg` и per-tool колбэки (`plan`, `rehash`) приходят параметрами
 * (dependency injection). Благодаря этому файл переносится ПОБАЙТОВО на 4 других
 * репо (sheets/calendar/docs/drive-mcp) — различаются только константа `server`
 * в cfg и per-tool билдеры превью/хеша, которые живут вне этого файла.
 *
 * Через `requireConsent(...)` обязаны проходить ВСЕ write-инструменты сервера
 * (gate.md §3.1: «инструмент, который мутирует, минуя require_consent, — дефект
 * уровня блокер»).
 *
 * ЧЕСТНЫЙ ОСТАТОЧНЫЙ ПРЕДЕЛ (ТЗ A.6 / gate.md §3.4 — НЕ притворяемся, что закрыт):
 * сервер физически НЕ может доказать, что `user_reply` не сочинён самой моделью.
 * Всё, что сервер вернул в тексте, модель уже знает; протокол MCP не даёт серверу
 * сигнала «пришёл новый ход пользователя». Поэтому гейт здесь ПОВЕДЕНЧЕСКИЙ, а не
 * криптографический: он превращает тихое само-подтверждение в ЯВНУЮ ЛОЖЬ, которая
 * остаётся в аудит-логе. Для неадверсариальной модели это работает как гейт, но
 * это компромисс. Целевая миграция: как только claude.ai получит form-mode
 * elicitation — брать подтверждение оттуда вместо `user_reply`, без смены сигнатур.
 *
 * automation_key-ветка (легальный обход для headless-автоматов) СОЗНАТЕЛЬНО не
 * реализована в этой версии: пре-чек потребителей не нашёл автоматов, зовущих
 * инструменты отправки напрямую (YAGNI). Единственный вход доверия — `user_reply`.
 */

import { createHash, randomUUID } from "node:crypto";
// Единственный не-DI импорт в этом модуле, и он осознан: реестр авто-
// исполнителей — это ПРАВИЛО ПО СВОЙСТВУ («есть чем исполнить по нажатию»),
// которое должно действовать всегда, а не «когда вызывающий не забыл его
// прокинуть». `autoExecute.ts` существует во всех репозиториях, куда
// копируется этот файл, и не тянет из `consent.ts` ничего кроме типов
// (`import type`), поэтому рантайм-цикла нет и переносимость сохраняется.
import { getAutoExecutor } from "./autoExecute.js";

// ───────────────────────── Типы контракта ──────────────────────────────────

/** Строка манифеста, как её хранит и отдаёт store. Времена — epoch-миллисекунды. */
export interface ConsentManifestRow {
  id: string;
  server: string;
  tool: string;
  accountLabel: string;
  /** Весь батч целиком — источник истины для исполнения (НЕ аргументы вызова). */
  payload: unknown;
  objectHash: string;
  status: "AWAITING_CONSENT" | "DONE" | "INVALIDATED";
  createdAt: number;
  expiresAt: number;
  consumedAt?: number | null;
  userReply?: string | null;
  /**
   * «Этот план ФИЗИЧЕСКИ ушёл в Telegram кнопками» — ставится РОВНО в одном
   * месте: сразу после того, как `notifyPlan` вернул успех (см. фазу плана в
   * `requireConsent`). Это СОСТОЯНИЕ ПЛАНА, а не текущее значение настройки:
   * `tgButtonOnly()` ниже читает только его и НИКОГДА не смотрит на
   * `enabledFor`/env — иначе выключение Telegram-слоя между планом и
   * исполнением задним числом снимало бы требование кнопки с уже отправленных
   * планов.
   */
  tgNotified?: boolean;
}

/** Запись аудита. Двухфазная: создаётся на решении гейта, дополняется исходом. */
export interface ConsentAuditEntry {
  id: string;
  ts: number;
  server: string;
  tool: string;
  accountLabel: string;
  manifestId?: string | null;
  objectHash?: string | null;
  /** `user_reply` ДОСЛОВНО, как прислала модель (без пересказа). */
  userReply: string;
  /** Результат каждой из проверок раздела 3.3. */
  checks: Record<string, string>;
  outcome: "confirmed" | "refused" | "invalidated";
  refusalReason?: string | null;
  /** "human" всегда в этой версии; "automation:<имя>" — будущая ветка. */
  actor: string;
}

/**
 * Интерфейс хранилища, который ОЖИДАЕТ этот модуль. Реализуется пакетом A1
 * (`src/store.ts`) поверх Postgres. Все запросы обязаны фильтровать по
 * `server` (общая таблица на 5 серверов — колонка `server`).
 *
 * A1 обязан реализовать РОВНО эти 6 функций под эти сигнатуры:
 */
export interface ConsentStore {
  /** Вставляет новый манифест в состоянии AWAITING_CONSENT. */
  createManifest(input: {
    id: string;
    server: string;
    tool: string;
    accountLabel: string;
    payload: unknown;
    objectHash: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;

  /** Читает манифест по id в рамках своего server; null если нет. */
  getManifest(id: string, server: string): Promise<ConsentManifestRow | null>;

  /**
   * АТОМАРНЫЙ one-shot. Помечает DONE + consumed_at + user_reply ТОЛЬКО если
   * строка ещё AWAITING_CONSENT и не истекла по TTL. Возвращает обновлённую
   * строку при успехе, иначе null (уже исполнен / истёк / инвалидирован / нет).
   * Гонка «двойной execute» закрывается структурно здесь, а не проверкой в JS.
   * Эталон реализации — `consumeCode` в store.ts (UPDATE … WHERE … RETURNING).
   */
  consumeManifest(
    id: string,
    server: string,
    userReply: string,
  ): Promise<ConsentManifestRow | null>;

  /**
   * Ставит на манифесте метку «план ушёл в Telegram кнопками» (`tg_notified`).
   * Вызывается РОВНО в одном месте — сразу после успешного `notifyPlan` в
   * фазе плана. Провал этого вызова — FAIL-CLOSED: вызывающий код обязан
   * убить манифест, а не оставить его исполнимым текстовым «да» (иначе
   * требование кнопки снималось бы падением одного UPDATE).
   */
  markTgNotified(id: string, server: string): Promise<void>;

  /** Помечает манифест INVALIDATED (явное отрицание пользователя). */
  invalidateManifest(
    id: string,
    server: string,
    userReply: string,
  ): Promise<void>;

  /** Append-only: пишет фазу согласия/отказа. */
  appendConsentAudit(entry: ConsentAuditEntry): Promise<void>;

  /**
   * Дополняет ранее записанную аудит-строку исходом мутации и post-verify.
   * Зовётся ИНСТРУМЕНТОМ (пакет A3) ПОСЛЕ мутации, не этим модулем — объявлен
   * здесь только чтобы зафиксировать контракт для A1.
   *
   * `preSnapshot` добавлен пакетом A3 (identity-postverify.md §5.2): снимок
   * исходящего объекта (account/to/cc/bcc/subject/начало тела — БЕЗ полного
   * тела) ДО необратимой мутации. Это не gmail-специфика — то же самое
   * потребуется T2 на остальных 4 серверах, поэтому поле в общем контракте,
   * а не только в store.ts.
   */
  updateConsentAuditOutcome(
    auditId: string,
    outcome: {
      outcome?: "confirmed" | "failed";
      postVerify?: string | null;
      error?: string | null;
      preSnapshot?: unknown;
    },
  ): Promise<void>;
}

/**
 * Опциональный внеполосный (out-of-band) фактор поверх `user_reply` — нажатие
 * кнопки в Telegram (gate.md §3.4: «модель может сфабриковать `user_reply` —
 * это не закрыто»; кнопка модели недоступна). DI, тем же приёмом, что и
 * `ConsentStore` выше: этот модуль НЕ импортирует `tg_approval.ts` — конкретную
 * реализацию инжектирует server.ts, типизируя её `: TgApprovalGate` там (как
 * `consentStoreAdapter`), чтобы дрейф сигнатур падал на СБОРКЕ, а не в проде.
 * Поэтому `consent.ts` остаётся переносимым ПОБАЙТОВО на другие 4 сервера
 * независимо от того, подключён там Telegram или нет.
 *
 * Инвариант совместимости: `tg` не передан (undefined) → ни одна из веток
 * ниже не выполняется, поведение гейта побайтово как до этой правки.
 */
export interface TgApprovalGate {
  /** true, если ДЛЯ ЭТОГО инструмента нужен внеполосный ТГ-фактор
   * (TG_APPROVAL_ENABLED и (TG_APPROVAL_TOOLS пусто ИЛИ содержит tool)). */
  enabledFor(tool: string): boolean;
  /**
   * Отправляет превью плана в Telegram с кнопками [✅ Подтвердить][🛑 Отклонить].
   * Зовётся ТОЛЬКО когда `enabledFor(tool)` истинно, сразу после
   * `createManifest`. Провал — FAIL-CLOSED (это расширение честного правила
   * gate.md §4 на этот слой): вызывающий код обязан НЕ оставлять манифест
   * живым, если это вернуло `{ ok: false }`.
   */
  notifyPlan(
    manifestId: string,
    previewBody: string,
    /** `expiresAt` — CONSENT-манифеста (не самого ТГ-запроса): реализация
     * обязана взять его как ВЕРХНИЙ предел, а не как значение напрямую —
     * approval-запрос вправе жить короче, по своему TTL, но не дольше плана,
     * к которому относится. */
    meta: { tool: string; accountLabel: string; expiresAt: number },
  ): Promise<{ ok: boolean; error?: string }>;
  /**
   * Текущее внеполосное решение по манифесту. `"none"` покрывает СРАЗУ два
   * случая — «запроса в Telegram никогда не было» и «TTL истёк»: фаза
   * исполнения обрабатывает их одинаково (отказ, план заново).
   */
  checkApproval(manifestId: string): Promise<"approved" | "pending" | "rejected" | "none">;
}

/** Конфиг сервера (различается между репо только значением `server`). */
export interface ConsentConfig {
  /** Константа сервера ($self), напр. "gmail". НЕ аргумент инструмента. */
  server: string;
  /** TTL манифеста, мс (env CONSENT_TTL_MS, дефолт 1 ч). */
  consentTtlMs: number;
  /** Минимальный зазор план↔исполнение, мс (env MIN_CONSENT_GAP_MS, почта = 5000). */
  minConsentGapMs: number;
  /** Кап размера батча одного манифеста (env SEND_BATCH_MAX, дефолт 10). */
  sendBatchMax: number;
  /** Инъекция часов (для тестов). Дефолт Date.now. */
  now?: () => number;
}

/**
 * Адресация для `rehash` (binding, gate.md §3.3 п.2). Это НЕ содержимое плана,
 * а идентификаторы объектов (messageId / draftId / threadId / получатели…),
 * ПО КОТОРЫМ надо СХОДИТЬ В ЖИВОЙ МИР и перечитать текущее состояние. Тип
 * намеренно назван и осмыслен как «адрес», а не `payload`, чтобы A3 не соблазнился
 * захешировать переданный объект (это дало бы тавтологию — см. `rehash` ниже).
 * Конкретную форму задаёт per-tool билдер плана (что он положил в `payload`).
 */
export type ConsentAddressing = unknown;

/** Результат фазы плана, который строит per-tool колбэк. */
export interface ConsentPlan {
  /** Весь батч — ляжет в манифест, из него же пойдёт исполнение. */
  payload: unknown;
  /** Хеш связывания (binding), обычно sha256(canonicalJson(...)). */
  objectHash: string;
  /** Человекочитаемое тело превью (с заголовком `### …`). Мету/хвост добавит модуль. */
  preview: string;
  /**
   * Число элементов в батче — для проверки капа SEND_BATCH_MAX. Необязательно:
   * если не передано, кап не проверяется (для не-батчевых инструментов).
   */
  batchSize?: number;
}

/** Параметры единой точки входа. */
export interface RequireConsentParams<T = unknown> {
  tool: string;
  accountLabel: string;
  /** undefined/"" в фазе плана; заданный — в фазе исполнения. */
  manifestId?: string | null;
  /** undefined/"" в фазе плана; ДОСЛОВНАЯ реплика человека в фазе исполнения. */
  userReply?: string | null;
  /** Строит план. ВЫЗЫВАЕТСЯ ТОЛЬКО в фазе плана, НЕ должен мутировать. */
  plan: () => ConsentPlan | Promise<ConsentPlan>;
  /**
   * BINDING (gate.md §3.3 п.2): пересчитывает objectHash из ЖИВОГО состояния
   * мира на момент исполнения, чтобы поймать ДРЕЙФ между планом и отправкой.
   *
   * ⚠️ КОНТРАКТ ДЛЯ A3 — ЭТО НЕ `sha256(payload)`, НЕ ТАВТОЛОГИЯ:
   *   Аргумент `addressing` — это АДРЕСАЦИЯ (идентификаторы объектов из payload
   *   манифеста: messageId / draftId / получатели …), а НЕ контент для хеша.
   *   Реализация ОБЯЗАНА по этим id СХОДИТЬ В МИР (перечитать письмо / черновик /
   *   получателя СЕЙЧАС) и вернуть sha256 ПЕРЕЧИТАННОГО живого состояния.
   *   `return sha256(addressing)` / `sha256(payload)` — ЗАПРЕЩЕНО: даст
   *   hash === objectHash ВСЕГДА, binding выродится в тавтологию `hash===hash`
   *   и НИКОГДА не поймает «получатель уехал / текст черновика изменился между
   *   планом и исполнением». Тип аргумента — `ConsentAddressing` (адрес), а не
   *   payload, ИМЕННО чтобы это различие нельзя было проглядеть.
   *   Возврат — `Promise<string>` (перечитывание мира — это I/O, не чистая ф-ция).
   */
  rehash: (addressing: ConsentAddressing) => string | Promise<string>;
  store: ConsentStore;
  cfg: ConsentConfig;
  /**
   * Опциональный внеполосный ТГ-фактор (см. `TgApprovalGate` выше). undefined
   * ⇒ поведение гейта побайтово как до этой правки — ни один из веток ниже не
   * задействуется.
   */
  tg?: TgApprovalGate;
}

/** Размеченный union исхода. Отказы — здесь, НЕ через throw. */
export type ConsentDecision<T = unknown> =
  | { kind: "planned"; manifestId: string; preview: string }
  | { kind: "confirmed"; manifestId: string; payload: T; auditId: string }
  | { kind: "refused"; result: string };

/**
 * Докстринг параметра `user_reply` — ДОСЛОВНО по смыслу из ТЗ A.3 / gate.md §3.3.
 * Инструмент (A3) обязан навесить эту строку на zod-параметр `user_reply`.
 */
export const USER_REPLY_DOC =
  "Скопируй сюда ДОСЛОВНО последнее сообщение пользователя, которым он " +
  "подтвердил. Не сочиняй и не пересказывай. Если пользователь ещё не ответил " +
  "— не вызывай этот инструмент.";

// ───────────────────────── Хелперы: хеш и время ────────────────────────────

/** Детерминированный stringify с рекурсивной сортировкой ключей объектов. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** sha256(canonicalJson(value)) в hex — стабильный objectHash для binding. */
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Время в America/Los_Angeles как «5 авг, 07:15» (ТЗ A.4 — всегда LA, не UTC). */
export function formatLaTime(epochMs: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "America/Los_Angeles",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

// ───────────────────────── Рендер (единый формат) ──────────────────────────

/**
 * Единый рендерер блока согласия/отказа (output-format.md §7.1 п.5: «инструмент,
 * лепящий строку руками, — дефект»). header уже включает статус-эмодзи из
 * замороженной легенды §7.2 (🛑 для отказа гейта).
 */
export function renderConsentBlock(header: string, body: string): string {
  return `### ${header}\n\n${body}`;
}

function renderPlanned(
  previewBody: string,
  id: string,
  expiresAt: number,
  /** true ⇒ план исполняется ТОЛЬКО кнопкой: просить текстовое «да»
   * бессмысленно и вводит агента в заблуждение (повторный вызов инструмента
   * всё равно получит отказ). */
  buttonOnly = false,
): string {
  const meta = `_план \`${id}\` · истекает в ${formatLaTime(expiresAt)} PT_`;
  const tail = buttonOnly
    ? "_[агенту: покажи это пользователю дословно. Подтверждение — ТОЛЬКО кнопкой " +
      "в Telegram; текстовое «да» для этого плана не принимается. Повторно вызывать " +
      "инструмент НЕ нужно — сервер исполнит сам, как только кнопка будет нажата. " +
      "Просто скажи пользователю, что ждёшь нажатия.]_"
    : "_[агенту: покажи это пользователю дословно и дождись его ответа. " +
      "Не вызывай исполнение, пока он не ответил.]_";
  return `${previewBody}\n\n${meta}\n\n${tail}`;
}

function renderRefusal(header: string, body: string): string {
  // 🛑 — «жёсткий стоп, ничего не изменено» (output-format §7.2).
  return renderConsentBlock(`🛑 ${header}`, body);
}

/**
 * Минимальная нейтрализация внешнего текста при подстановке в отказ: убрать
 * переводы строк, обрезать. Это НЕ полный safeText — полная нейтрализация
 * markdown-инъекции живёт в S1 (`src/util.ts`) и применяется при интеграции в
 * инструмент. Здесь только чтобы реплика не разорвала блок отказа.
 */
function inlineReply(s: string, max = 80): string {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

// ───────────────────────── Классификация user_reply ────────────────────────

// Словари RU+EN ЗАХАРДКОЖЕНЫ на сервере и модели НЕ отдаются (gate.md §3.3).
//
// ПЕРЕВЁРНУТЫЙ ПРИНЦИП (порт строгого протокола из ticktick-mcp, PR #15).
// Раньше согласием считался ответ, в котором ГДЕ-ТО ЕСТЬ утвердительное слово
// (`tokens.some(...)`). Это fail-open: «ок, кроме последней» и «да, но третий
// пропусти» проходили как чистое согласие, и исполнялся ВЕСЬ план — включая
// то, что человек явно исключил. Слов-ограничителей в словарях не было вообще.
//
// Теперь наоборот: согласие — это ответ, ЦЕЛИКОМ состоящий из понятных
// элементов. Формула (`classifyReply`, финальный шаг):
//   core непуст И len(core) ≤ CONSENT_MAX_TOKENS И хотя бы один токен из
//   AFFIRMATIVE_WORDS И КАЖДЫЙ токен из (AFFIRMATIVE_WORDS ∪ FILLER_WORDS).
// Один незнакомый токен ⇒ НЕ согласие (класс `unknown` = «ambiguous»), отказ
// с просьбой ответить одним словом. Сервер СОЗНАТЕЛЬНО не угадывает, какое
// подмножество плана имелось в виду: угадывание — это второй способ сделать
// не то, что просили.
//
// ⚠️ ГРАНИЦЫ СЛОВ И КИРИЛЛИЦА. В JavaScript `\b` определён через
// `\w = [A-Za-z0-9_]`; кириллица туда НЕ входит, и флаг `u` этого не меняет:
//   /\bкроме\b/.test("ок, кроме последней")  → false   ← молча не работает
//   /\bexcept\b/.test("ok, except last")     → true
// Механический перенос питоновских регулярок отключил бы ВСЕ русские маркеры,
// оставив английские рабочими — тесты на английских фразах были бы зелёными.
// Поэтому все границы собираются из `WB`/`WE` (lookaround по `\p{L}\p{N}_`)
// с флагом `u`, а не из `\b`. Тест «русский caveat-маркер срабатывает»
// (scripts/test-consent.mjs, раздел 16) существует ровно для этой поломки.
const WB = "(?<![\\p{L}\\p{N}_])"; // левая граница слова, юникод-безопасная
const WE = "(?![\\p{L}\\p{N}_])"; // правая граница слова, юникод-безопасная

/** Утвердительные слова. Одного мало — нужен ещё и «весь остаток понятен». */
const AFFIRMATIVE_WORDS = new Set([
  // RU
  "да", "ага", "угу", "ок", "окей", "окай", "океюшки", "подтверждаю",
  "подтверждено", "подтверждаешь", "удаляй", "удали", "давай", "давайте",
  "го", "погнали", "поехали", "делай", "применяй", "применить", "применяем",
  "конечно", "точно", "хорошо", "договорились", "принято", "валяй",
  "согласен", "согласна", "согласны", "действуй", "действуйте",
  "вперёд", "вперед", "верно", "правильно", "именно",
  "утверждаю", "одобряю", "одобрено", "безусловно", "однозначно",
  "продолжай", "продолжаем", "запускай", "жми", "стартуй", "стартуем",
  "выполняй", "сливай", "слей", "создавай", "создай", "обновляй", "обнови",
  "отметь", "отмечай", "перемещай", "перемести", "восстанавливай",
  "восстанови", "завершай", "заверши", "архивируй", "ставь", "поставь",
  "сделай", "сделайте", "сделаем",
  "отправляй", "отправь", "отправляем", "шли", "плюс", "ясно",
  // Глаголы-команды ЭТОГО домена (таблицы). Та же дисциплина, что в эталоне,
  // где под свой домен добавлены «сливай/архивируй/отметь»: для sheets-mcp
  // живое подтверждение звучит как «да, пиши» / «ок, запиши».
  "пиши", "пишем", "запиши", "записывай", "добавь", "добавляй",
  "очисти", "очищай", "замени", "заменяй", "форматируй", "вставь", "вставляй",
  // EN
  "yes", "yep", "yeah", "yup", "sure", "confirm", "confirmed", "ok", "okay",
  "k", "approve", "approved", "go", "send", "proceed", "aye", "yea",
  "+", "+1", "agreed", "right", "correct", "exactly", "absolutely",
  "definitely", "affirmative", "alright", "fine", "deal", "certainly",
  "do", "accept", "accepted", "good",
]);

/** Наречия образа действия: «да, только БЫСТРЕЕ» — это по-прежнему «да», а не
 * оговорка. Отдельный набор, потому что он же гасит caveat-маркер «только». */
const MANNER_WORDS = new Set([
  "быстрее", "побыстрее", "быстро", "скорее", "поскорее", "аккуратно",
  "аккуратнее", "осторожно", "осторожнее", "внимательно", "внимательнее",
  "тихо", "медленно", "спокойно", "пожалуйста", "давай", "давайте",
]);

/** Шум, который сам по себе согласием не является, но и не мешает ему.
 * «ладно» — здесь, а НЕ в AFFIRMATIVE_WORDS: прямое решение Максима
 * (2026-08-06) — односложное «ладно» согласием НЕ считается (нет ни одного
 * утвердительного токена → ambiguous), а «ладно, давай» — считается.
 * Это единственное сознательное расхождение с питоновским эталоном, где
 * «ладно» отсутствует во всех словарях и оба варианта дают ambiguous. */
const FILLER_WORDS = new Set([
  ...MANNER_WORDS,
  "ладно",
  "только", "ну", "же", "уж", "уже", "тогда", "сразу", "сейчас", "спасибо",
  "плиз", "please", "thanks", "thank", "you", "now", "ahead", "it", "sounds",
  "удаление", "создание", "изменение", "обновление", "перемещение",
  "завершение", "слияние", "восстановление", "запись", "добавление",
]);

/** Устойчивые обороты → одно слово. Применяются ТОЛЬКО на финальном шаге
 * (проверка согласия), НЕ раньше: отрицание/оговорка/неуверенность обязаны
 * видеть исходный текст. */
const SET_PHRASES: Array<[RegExp, string]> = [
  [new RegExp(`${WB}вс[её]\\s+(?:верно|правильно|так)${WE}`, "giu"), "верно"],
  [new RegExp(`${WB}так\\s+точно${WE}`, "giu"), "точно"],
  [new RegExp(`${WB}без\\s+(?:проблем|вопросов|базара|разговоров|сомнений)${WE}`, "giu"), "ок"],
  [new RegExp(`${WB}(?:go|move)\\s+ahead${WE}`, "giu"), "go"],
  [new RegExp(`${WB}of\\s+course${WE}`, "giu"), "конечно"],
];

/** Верхний предел длины «ядра» согласия. Длинная реплика — это уже не «да». */
const CONSENT_MAX_TOKENS = 8;

// Частицы-отрицания: САМИ ПО СЕБЕ не решают. Отрицание — только «частица + голова».
// ЭТО МЕСТО УМНЕЕ ПИТОНОВСКОГО ЭТАЛОНА и сохранено намеренно: там отрицанием
// считается любой токен-отрицание в любой позиции, из-за чего «отправляй, не
// тяни» (согласие) убило бы живой план. Здесь частица даёт отказ только перед
// «головой» (см. `hasParticleNegation`).
const NEGATION_PARTICLES = new Set(["не", "not"]);

// «Головы», которые после частицы дают отказ, но сами утверждением НЕ являются
// (иначе одиночное «надо»/«нужно» ложно читалось бы как «да»). «не надо»,
// «не нужно», «не буду» → отказ; голое «надо» → unknown (безопасный переспрос).
const NEGATED_HEADS = new Set([
  "надо", "нужно", "стоит", "буду", "будем", "хочу", "хочется",
]);

// Самостоятельные негации: отрицание в любой позиции токена, инвалидируют план.
// Именно этот набор закрывает «позднее отрицание» — «да, всё верно, но подожди
// с третьей» / «ок, я всё проверил, отбой»: утверждение в начале фразы не
// отменяет отказ в её конце.
const STANDALONE_NEGATIONS = new Set([
  // RU
  "нет", "неа", "нельзя", "стоп", "отмена", "отмени", "отменить", "отставить",
  "погоди", "подожди", "стой", "отбой",
  // EN
  "no", "nope", "nah", "stop", "cancel", "abort", "dont", "don't", "wait",
  "nvm", "negative",
]);

const NEGATION_PHRASES = new Set([
  "do not", "not now", "hold on", "no dont", "not yet", "не надо", "не нужно",
]);

/**
 * Оговорка / частичное согласие. Сервер не умеет исполнять план ЧАСТИЧНО, а
 * угадывать исключённое подмножество отказывается — поэтому такой ответ
 * СЖИГАЕТ план и требует построить его заново уже без лишнего.
 *
 * `только` гасится negative-lookahead'ом на наречия образа действия, иначе
 * «да, только быстрее» (обычное согласие) читалось бы как оговорка.
 * `без` гасится на устойчивые обороты («без проблем» — это «ок», не «без X»).
 */
const MANNER_ALTERNATION = [...MANNER_WORDS]
  // По УБЫВАНИЮ длины: иначе «быстро» примерилось бы раньше «быстрее» и
  // хвост «-е» остался бы снаружи lookahead'а.
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .join("|");

const CAVEAT_RE = new RegExp(
  `${WB}(?:` +
    "кроме|исключая|исключи\\p{L}*|за\\s+исключением|" +
    "но\\s+не|а\\s+не|" +
    "не\\s+(?:надо|нужно|трогай|трогая|удаляй|удали|включай|бери|берём|берем|стоит)|" +
    "оставь\\p{L}*|оставить|оставим|оставляем|оставляя|" +
    "пропусти\\p{L}*|пропустить|пропустим|пропуская|" +
    `только(?!\\s+(?:${MANNER_ALTERNATION})${WE})|` +
    "без\\s+(?!проблем|вопросов|базара|разговоров|сомнений|задержек|проволочек|лишних)\\p{L}+|" +
    "except|excluding|exclude|apart\\s+from|other\\s+than|but\\s+not|" +
    "all\\s+but|everything\\s+but|skip" +
    `)${WE}`,
  "iu",
);

/** Пересказ вместо дословной реплики: «Пользователь: да», «he confirmed».
 * Это ровно то, что печатает модель, подтверждающая сама за человека. */
const PARAPHRASE_RE = new RegExp(
  "^(?:пользователь|юзер|человек|владелец|хозяин|user|the\\s+user)\\s*[:\\-—]|" +
    "^(?:пользователь|юзер|человек|владелец|он|она|user)\\s+" +
    `(?:сказал|сказала|ответил|ответила|подтвердил|подтвердила|говорит|пишет|написал|написала)${WE}|` +
    `^(?:the\\s+user|he|she|they)\\s+(?:said|says|replied|confirmed|approved)${WE}|` +
    `${WB}(?:по|согласно)\\s+словам\\s+(?:пользователя|юзера|человека|владельца)${WE}|` +
    `${WB}со\\s+слов\\s+(?:пользователя|юзера|человека|владельца)${WE}|` +
    `${WB}as\\s+(?:the\\s+)?user\\s+said${WE}|${WB}according\\s+to\\s+the\\s+user${WE}`,
  "iu",
);

/** Неуверенность/безразличие. Для необратимой операции этого недостаточно —
 * переспросить, но план НЕ сжигать. */
const HEDGE_RE = new RegExp(
  `${WB}(?:` +
    "наверн(?:ое|о)|возможно|может\\s+быть|думаю|кажется|вроде(?:\\s+бы)?|" +
    "не\\s+уверен\\p{L}*|сомневаюсь|" +
    "как\\s+(?:хочешь|хотите|знаешь|знаете|сам\\p{L}*)|" +
    "что\\s+(?:хочешь|хотите)|вс[ёе]\\s+равно|пофиг|" +
    "maybe|probably|i\\s+guess|i\\s+think|whatever|up\\s+to\\s+you|not\\s+sure|dunno" +
    `)${WE}`,
  "iu",
);

/** Эхо служебного жаргона САМОГО сервера (имя гейтованного тула, manifest_id,
 * JSON, псевдо-команда «WRITE 5») — признак того, что «согласие» напечатала
 * модель, а не человек. Имена тулов — этого репозитория (sheets_* / triage_*). */
const ECHO_ARTIFACT_RE =
  /^(?:write|append|clear|create|update|delete|replace|format|add)\s*\d+$|manifest_id|(?:sheets|triage)_\w+\s*\(|^\{[\s\S]*\}$/i;

/** trim → срезать `.!?,;:` с ОБОИХ КРАЁВ всей строки → схлопнуть пробелы →
 * lower. Пунктуация ВНУТРИ остаётся намеренно: регулярки выше обязаны видеть
 * запятую («ок, кроме последней»). */
function normalizeConsentReply(s: string): string {
  const trimmed = s.trim().replace(/^[.!?,;:]+|[.!?,;:]+$/g, "");
  return trimmed.replace(/\s+/g, " ").trim().toLowerCase();
}

/** split по пробелам; с каждого токена убрать апострофы (don't → dont) и
 * краевые `.,!?;:`; пустые выбросить. `+` и `+1` НЕ срезаются. */
function consentTokens(norm: string): string[] {
  return norm
    .split(" ")
    .map((t) => t.replace(/['’`]/g, "").replace(/^[.,!?;:]+|[.,!?;:]+$/g, ""))
    .filter(Boolean);
}

function collapseSetPhrases(norm: string): string {
  let out = norm;
  for (const [rx, repl] of SET_PHRASES) out = out.replace(rx, repl);
  return out;
}

function isServiceString(raw: string, ctx: { manifestId: string; tool: string }): boolean {
  if (raw === ctx.manifestId) return true; // id — адрес плана, не согласие
  if (raw === ctx.tool) return true; // имя инструмента
  if (/^[A-Z_]+\s+\d+$/.test(raw)) return true; // "SEND 1", "DELETE 5" — псевдо-код
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return true; // uuid
  if (/^[0-9a-f]{16,}$/i.test(raw)) return true; // голый длинный hex
  try {
    JSON.parse(raw); // JSON (объект/массив/число/true/false/null) — машинный ответ
    return true;
  } catch {
    /* обычный текст — не JSON */
  }
  return false;
}

/**
 * Классы ответа. ДВА РАЗНЫХ ПОСЛЕДСТВИЯ, это поведенчески значимо:
 *  • `negation`, `caveat`      → план АННУЛИРУЕТСЯ, нужно перепланировать;
 *  • `service`, `paraphrase`,
 *    `hedge`, `unknown`        → план ОСТАЁТСЯ ЖИВЫМ, вызов можно повторить.
 * Наказывать человека перепланированием за КРИВОЕ ОФОРМЛЕНИЕ ответа моделью
 * (пересказ, эхо, «наверное») — неправильно: он-то ничего не отменял.
 */
export type ReplyClass =
  | "service"
  | "paraphrase"
  | "negation"
  | "caveat"
  | "hedge"
  | "affirmation"
  | "unknown";

/** Голова после частицы, дающая отказ: «не <affirmation>» или «не <NEGATED_HEAD>». */
function isNegatedHead(t: string | undefined): boolean {
  return t != null && (AFFIRMATIVE_WORDS.has(t) || NEGATED_HEADS.has(t));
}

/**
 * true, если в токенах есть конструкция «частица-отрицание (не/not)
 * НЕПОСРЕДСТВЕННО перед головой». Именно это — а не «частица где-то в строке» —
 * отличает «не отправляй»/«not sure» (отрицание) от «отправляй, не тяни»
 * (частица перед не-головой: не отказ, но и не согласие — ambiguous).
 */
function hasParticleNegation(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (NEGATION_PARTICLES.has(tokens[i]) && isNegatedHead(tokens[i + 1])) return true;
  }
  return false;
}

/**
 * Классифицирует реплику. ПОРЯДОК ПРОВЕРОК МЕНЯТЬ НЕЛЬЗЯ:
 *   пусто → эхо → пересказ → строка целиком в отрицаниях → оговорка →
 *   отрицание по токенам → неуверенность → согласие (строгая формула) →
 *   ambiguous.
 * Проверка «вся строка целиком в словаре отрицаний» стоит ДО оговорки
 * НАМЕРЕННО: иначе «не надо» уехало бы в caveat.
 */
export function classifyReply(
  userReply: string,
  ctx: { manifestId: string; tool: string },
): ReplyClass {
  const raw = userReply.trim();
  if (!raw) return "unknown";
  const norm = normalizeConsentReply(raw);
  if (!norm) return "unknown";

  if (isServiceString(raw, ctx) || ECHO_ARTIFACT_RE.test(norm)) return "service";
  if (PARAPHRASE_RE.test(norm)) return "paraphrase";
  if (NEGATION_PHRASES.has(norm) || STANDALONE_NEGATIONS.has(norm)) return "negation";
  if (CAVEAT_RE.test(norm)) return "caveat";

  const tokens = consentTokens(norm);
  if (tokens.some((t) => STANDALONE_NEGATIONS.has(t)) || hasParticleNegation(tokens)) {
    return "negation";
  }
  if (HEDGE_RE.test(norm)) return "hedge";

  // Строгая формула согласия: ядро непусто, короткое, содержит хотя бы одно
  // утвердительное слово и НЕ содержит ничего незнакомого.
  const core = consentTokens(collapseSetPhrases(norm));
  if (
    core.length > 0 &&
    core.length <= CONSENT_MAX_TOKENS &&
    core.some((t) => AFFIRMATIVE_WORDS.has(t)) &&
    core.every((t) => AFFIRMATIVE_WORDS.has(t) || FILLER_WORDS.has(t))
  ) {
    return "affirmation";
  }
  return "unknown";
}

// ─────────────────── Исполнение ТОЛЬКО кнопкой (button-only) ───────────────

/**
 * true, если для ЭТОГО плана текстовое подтверждение закрыто СОВСЕМ и
 * единственный способ его исполнить — нажатие кнопки человеком в Telegram.
 *
 * Две строки, никаких списков имён тулов:
 *  1. `row.tgNotified` — план РЕАЛЬНО ушёл кнопками (метка поставлена в момент
 *     успешной отправки). Читается СОСТОЯНИЕ ПЛАНА, а не текущая настройка:
 *     `enabledFor`/`TG_APPROVAL_ENABLED` здесь не читаются ВООБЩЕ, иначе
 *     выключение переменной между планом и исполнением снимало бы требование
 *     кнопки задним числом.
 *  2. «есть чем исполнить по нажатию» — у тула зарегистрирован авто-исполнитель
 *     (`autoExecute.ts`), которого фоновый поллер вызовет сам. Это правило по
 *     СВОЙСТВУ, а не перечень исключений: как только у тула появляется
 *     исполнитель, он автоматически становится button-only, а список
 *     исключений пережил бы свою причину. Побочный полезный эффект — мягкая
 *     деградация: забыли исполнитель ⇒ просто остался открыт обычный текстовый
 *     путь (через блок 3.5), а не «исполнить невозможно вообще».
 *
 * Смысл: модель физически не может исполнить операцию — что бы она ни
 * написала в `user_reply`. Это устраняет дыру «модель сочиняет согласие за
 * человека», а не уменьшает её.
 */
export function tgButtonOnly(row: Pick<ConsentManifestRow, "tool" | "tgNotified">): boolean {
  if (!row.tgNotified) return false;
  return getAutoExecutor(row.tool) !== undefined;
}

// ───────────────────────── Ядро: requireConsent ────────────────────────────

export async function requireConsent<T = unknown>(
  p: RequireConsentParams<T>,
): Promise<ConsentDecision<T>> {
  const { tool, accountLabel, plan, rehash, store, cfg } = p;
  const now = cfg.now ?? Date.now;
  const manifestId = p.manifestId ?? "";
  const userReply = p.userReply ?? "";
  const hasId = manifestId !== "";
  const hasReply = userReply !== "";

  // Общий журнал отказа + возврат refused.
  const refuse = async (
    header: string,
    body: string,
    checks: Record<string, string>,
    opts?: { manifestId?: string; objectHash?: string; outcome?: "refused" | "invalidated"; reason?: string },
  ): Promise<ConsentDecision<T>> => {
    await store.appendConsentAudit({
      id: randomUUID(),
      ts: now(),
      server: cfg.server,
      tool,
      accountLabel,
      manifestId: opts?.manifestId ?? (hasId ? manifestId : null),
      objectHash: opts?.objectHash ?? null,
      userReply,
      checks,
      outcome: opts?.outcome ?? "refused",
      refusalReason: opts?.reason ?? header,
      actor: "human",
    });
    return { kind: "refused", result: renderRefusal(header, body) };
  };

  // Ровно один из пары задан — вызывающий перепутал фазу.
  if (hasId !== hasReply) {
    return refuse(
      "Нужны оба параметра",
      "Для исполнения плана нужны И `manifest_id`, И `user_reply`. Чтобы " +
        "построить план — вызови инструмент без обоих.",
      { call: "half_pair" },
    );
  }

  // ───── ФАЗА ПЛАНА (нет ни id, ни reply): читаем состояние, НЕ мутируем ─────
  if (!hasId && !hasReply) {
    const built = await plan();
    if (built.batchSize != null && built.batchSize > cfg.sendBatchMax) {
      return refuse(
        "Слишком большой батч",
        `В плане ${built.batchSize} элементов — больше предела ${cfg.sendBatchMax}. ` +
          "Разбей на несколько вызовов: один манифест = один радиус согласия.",
        { batchCap: "exceeded" },
      );
    }
    const id = randomUUID();
    const createdAt = now();
    const expiresAt = createdAt + cfg.consentTtlMs;
    await store.createManifest({
      id,
      server: cfg.server,
      tool,
      accountLabel,
      payload: built.payload,
      objectHash: built.objectHash,
      createdAt,
      expiresAt,
    });

    let previewBody = built.preview;
    let buttonOnly = false;
    if (p.tg?.enabledFor(tool)) {
      // Fail-closed (plan §4): если отправка в Telegram упала, манифест НЕ
      // остаётся живым — иначе исполнение осталось бы доступно через голое
      // `user_reply`, без второго фактора, который для этого инструмента
      // объявлен обязательным.
      const sent = await p.tg.notifyPlan(id, built.preview, { tool, accountLabel, expiresAt });
      if (!sent.ok) {
        await store.invalidateManifest(id, cfg.server, "");
        return refuse(
          "Не смог отправить запрос подтверждения в Telegram",
          "Действие НЕ выполнено, ничего не изменено. Проверьте бота/настройки Telegram-подтверждения" +
            (sent.error ? ` (${inlineReply(sent.error)}).` : " и попробуйте снова."),
          { tg: "send_failed" },
          { manifestId: id, outcome: "invalidated", reason: "tg_send_failed" },
        );
      }
      // Метка «план ушёл кнопками» — РОВНО здесь, сразу после успешной
      // отправки, и только здесь. Провал записи — FAIL-CLOSED: план без метки
      // остался бы исполнимым текстовым «да», то есть падение одного UPDATE
      // молча снимало бы требование кнопки.
      try {
        await store.markTgNotified(id, cfg.server);
      } catch (err) {
        await store.invalidateManifest(id, cfg.server, "");
        return refuse(
          "Не смог зафиксировать отправку запроса подтверждения",
          "Запрос ушёл в Telegram, но сервер не смог отметить план как «подтверждается " +
            "кнопкой». Действие НЕ выполнено, план аннулирован — повторите позже " +
            `(${inlineReply(err instanceof Error ? err.message : String(err))}).`,
          { tg: "mark_failed" },
          { manifestId: id, outcome: "invalidated", reason: "tg_mark_failed" },
        );
      }

      // Есть ли чем исполнить по нажатию — то же правило по свойству, что и в
      // `tgButtonOnly()`. Если исполнителя нет, приписка честно просит
      // повторить вызов инструмента (мягкая деградация), а не нажать кнопку и
      // ждать чуда.
      buttonOnly = getAutoExecutor(tool) !== undefined;
      previewBody = buttonOnly
        ? `${built.preview}\n\n_⏳ Запрос на подтверждение отправлен в Telegram. Нажмите кнопку ` +
          `в боте — сервер исполнит это САМ. Текстовое «да» здесь для этого плана не принимается._`
        : `${built.preview}\n\n_⏳ Запрос на подтверждение отправлен в Telegram — подтвердите кнопкой в ` +
          `боте, затем ответьте «да» здесь._`;
    }

    return {
      kind: "planned",
      manifestId: id,
      preview: renderPlanned(previewBody, id, expiresAt, buttonOnly),
    };
  }

  // ───── ФАЗА ИСПОЛНЕНИЯ (оба заданы) ─────
  const checks: Record<string, string> = {};

  // (1) Манифест существует, наш server, тот же tool/account, ещё AWAITING.
  const row = await store.getManifest(manifestId, cfg.server);
  if (
    !row ||
    row.tool !== tool ||
    row.accountLabel !== accountLabel ||
    row.status !== "AWAITING_CONSENT"
  ) {
    checks.manifest = row ? "mismatch_or_closed" : "missing";
    return refuse(
      "План не найден или истёк",
      "Не нашёл активный план для этого действия. Построй план заново — вызови " +
        "инструмент без `manifest_id` и без `user_reply`.",
      checks,
    );
  }
  checks.manifest = "ok";

  // (2) Анти-дуплет — ПЕРВОЙ, манифест НЕ трогаем (иначе «план+execute в одном
  //     ходе» сожжёт план отрицанием/consume раньше, чем человек ответит).
  if (now() - row.createdAt < cfg.minConsentGapMs) {
    checks.antiDoublet = "too_fast";
    return refuse(
      "Слишком быстро — похоже на подтверждение без человека",
      "Между показом плана и исполнением прошло меньше " +
        `${Math.round(cfg.minConsentGapMs / 1000)} с. Покажи план пользователю, ` +
        "дождись его ответа и вызови снова. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  checks.antiDoublet = "ok";

  // (3) Классификация user_reply. ДВА КЛАССА ПОСЛЕДСТВИЙ:
  //     negation/caveat        → план АННУЛИРУЕТСЯ (перепланировать);
  //     service/paraphrase/
  //     hedge/unknown          → отказ, но план ОСТАЁТСЯ ЖИВЫМ.
  //
  //     ПОРЯДОК ВНУТРИ ЭТОГО ШАГА ВАЖЕН: сначала аннулирующие классы, потом
  //     (3.4) button-only, и только потом «а утвердительно ли». Отрицание
  //     сильнее требования кнопки — человек сказал «нет», план мёртв.
  const cls = classifyReply(userReply, { manifestId, tool });
  checks.reply = cls;
  if (cls === "negation") {
    await store.invalidateManifest(manifestId, cfg.server, userReply);
    return refuse(
      "Отменено пользователем",
      `В ответе («${inlineReply(userReply)}») есть отрицание — где бы в фразе оно ни ` +
        "стояло, это не согласие. План отменён, ничего не изменено. Чтобы " +
        "повторить — построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "negation" },
    );
  }
  if (cls === "caveat") {
    await store.invalidateManifest(manifestId, cfg.server, userReply);
    return refuse(
      "Частичное согласие — так нельзя",
      `Ответ («${inlineReply(userReply)}») согласен НЕ со всем планом (есть «кроме», ` +
        "«только», «пропусти» и т.п.). Сервер не умеет исполнять план частично и не " +
        "станет угадывать, что именно исключено. План аннулирован — построй его " +
        "ЗАНОВО, уже без лишнего, и покажи пользователю снова.",
      checks,
      { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "caveat" },
    );
  }
  // (3.4) ИСПОЛНЕНИЕ ТОЛЬКО КНОПКОЙ. Стоит ПОСЛЕ аннулирующих классов
  // (человек сказал «нет» — план мёртв, кнопка тут уже ни при чём) и ДО любой
  // проверки «а утвердительно ли». С этого места СОДЕРЖАНИЕ реплики не влияет
  // ни на что: «да», «давай, подтверждаю», «ага, делай» получают ОДИН И ТОТ ЖЕ
  // отказ. В этом и есть суть — модель не может исполнить операцию, сочинив
  // согласие за человека.
  if (tgButtonOnly(row)) {
    // ВНИМАНИЕ: здесь НЕ читается `p.tg.enabledFor(tool)` и никакой env —
    // только метка на самом манифесте (см. `tgButtonOnly`). Иначе выключение
    // Telegram-слоя между планом и исполнением задним числом открыло бы
    // текстовый путь для уже отправленного кнопками плана.
    const approval = p.tg ? await p.tg.checkApproval(manifestId) : "pending";
    checks.tgButtonOnly = approval;
    if (approval === "approved") {
      // КРИТИЧНО: манифест НЕ гасим. Фоновый исполнитель ещё не добрался до
      // него — если погасить здесь, он найдёт план закрытым и операция не
      // произойдёт ВООБЩЕ.
      return refuse(
        "Уже подтверждено кнопкой",
        "Кнопка в Telegram уже нажата — сервер исполняет это САМ, в фоне. Ничего " +
          "повторять не надо и повторно звать инструмент не нужно: результат придёт " +
          "в то же сообщение в боте.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
    if (approval === "rejected") {
      await store.invalidateManifest(manifestId, cfg.server, userReply);
      return refuse(
        "Отклонено в Telegram",
        "🛑 Действие отклонено кнопкой в Telegram. План отменён, ничего не изменено. " +
          "Чтобы повторить — построй план заново.",
        checks,
        { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "tg_rejected" },
      );
    }
    if (approval === "none") {
      return refuse(
        "Запрос подтверждения истёк",
        "Запрос подтверждения в Telegram не найден или истёк по TTL. Построй план заново.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
    return refuse(
      "Этот план подтверждается только кнопкой",
      "Текстовое подтверждение для него отключено — что бы пользователь ни написал в " +
        "чате. Повторно звать инструмент НЕ нужно: сервер исполнит сам, как только " +
        "кнопка в Telegram будет нажата. Просто скажи пользователю, что ждёшь нажатия. " +
        "План активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }

  if (cls === "service") {
    return refuse(
      "Это не ответ человека",
      "`user_reply` повторяет служебный жаргон сервера (id / имя инструмента / JSON / " +
        "псевдо-код) — ровно то, что печатает модель, подтверждающая сама себя. " +
        "Скопируй ДОСЛОВНО то, что написал человек. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "paraphrase") {
    return refuse(
      "Это пересказ, а не реплика человека",
      `«${inlineReply(userReply)}» — пересказ от третьего лица («пользователь сказал…»), ` +
        "а нужна реплика человека ДОСЛОВНО, его собственными словами. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "hedge") {
    return refuse(
      "Неуверенный ответ",
      `В «${inlineReply(userReply)}» слышна неуверенность или безразличие («наверное», ` +
        "«как хочешь»). Для необратимой операции этого недостаточно — переспроси " +
        "пользователя и вызови снова. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "unknown") {
    return refuse(
      "Не однозначное согласие",
      `«${inlineReply(userReply)}» — не однозначное «да». Сервер СОЗНАТЕЛЬНО не угадывает, ` +
        "что имелось в виду: угадав неверно, он сделает не то, что просили. Попроси " +
        "пользователя ответить одним словом — «да» или «нет» — и вызови снова. " +
        "План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  // cls === "affirmation" → идём дальше.

  // (3.5) Внеполосный ТГ-фактор для планов, у которых НЕТ авто-исполнителя
  // (мягкая деградация из `tgButtonOnly`). Такой план кнопка сама исполнить
  // не может, поэтому текстовый путь для него остаётся открытым — но только
  // после нажатия. Планы С исполнителем сюда не доходят: их забрал блок (3.4)
  // выше. Когда `tg` не передан или `enabledFor(tool)` ложно — блок не
  // выполняется, поведение ниже побайтово как до появления Telegram-слоя.
  // Встаёт ПЕРЕД дорогим binding+consume: не тратим rehash впустую.
  if (p.tg?.enabledFor(tool)) {
    const approval = await p.tg.checkApproval(manifestId);
    checks.tgApproval = approval;
    if (approval === "pending") {
      return refuse(
        "Жду подтверждения в Telegram",
        "⏳ Подтвердите кнопкой в боте, затем повторите. План ещё активен.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
    if (approval === "rejected") {
      await store.invalidateManifest(manifestId, cfg.server, userReply);
      return refuse(
        "Отклонено в Telegram",
        "🛑 Действие отклонено кнопкой в Telegram. План отменён, ничего не отправлено. Чтобы " +
          "повторить — построй план заново.",
        checks,
        { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "tg_rejected" },
      );
    }
    if (approval === "none") {
      return refuse(
        "Запрос подтверждения истёк",
        "Запрос подтверждения в Telegram не найден или истёк по TTL. Построй план заново.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
    // approval === "approved" → идём дальше.
  }

  // (4) Binding: пересчитанный хеш ЖИВОГО состояния == сохранённому при плане.
  //     row.payload здесь передаётся rehash как АДРЕСАЦИЯ (источник id для
  //     перечитывания), а НЕ как контент для хеша — см. контракт `rehash` выше.
  //     rehash обязан сходить в мир; если он вернёт sha256(row.payload), эта
  //     проверка выродится в тавтологию и дрейф состояния не поймается.
  const currentHash = await rehash(row.payload);
  if (currentHash !== row.objectHash) {
    checks.binding = "mismatch";
    return refuse(
      "Состояние изменилось после планирования",
      "Объекты, к которым относился план, изменились (получатель/содержимое " +
        "«уехали»). Ради безопасности исполнение отклонено — построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  checks.binding = "ok";

  // (5) Одноразовость + TTL — АТОМАРНЫМ consumeManifest (гонка закрыта в БД).
  const consumed = await store.consumeManifest(manifestId, cfg.server, userReply);
  if (!consumed) {
    checks.oneShot = "consumed_or_expired";
    return refuse(
      "План не найден, истёк или уже исполнен",
      "Этот план уже был исполнен, инвалидирован или истёк по TTL за время " +
        "проверок. Построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  checks.oneShot = "ok";

  // (6) Журналирование факта согласия (фаза 1). Исход мутации + post-verify
  //     допишет инструмент через updateConsentAuditOutcome(auditId, …).
  const auditId = randomUUID();
  await store.appendConsentAudit({
    id: auditId,
    ts: now(),
    server: cfg.server,
    tool,
    accountLabel,
    manifestId,
    objectHash: row.objectHash,
    userReply,
    checks,
    outcome: "confirmed",
    actor: "human",
  });

  // payload берём ИЗ манифеста (не из аргументов вызова) — ТЗ 0.3 / A.1.
  return { kind: "confirmed", manifestId, payload: consumed.payload as T, auditId };
}

// ───────────────────────── Авто-исполнение по кнопке ────────────────────────

/**
 * Максим, ночь на 2026-08-05: «нажал кнопку — должно сразу исполниться на
 * бэке, не ждать, что модель ещё раз вызовет инструмент». До этой функции
 * кнопка в Telegram только переключала флаг в `tg_approvals` — реальная
 * мутация происходила ТОЛЬКО когда модель САМА второй раз звала инструмент
 * с `user_reply`; если пользователь ничего не писал в чат после нажатия —
 * действие могло не наступить никогда.
 *
 * Эта функция закрывает разрыв: сервер сам, фоновым поллером (см. per-server
 * `autoExecutePoller.ts`), находит манифесты AWAITING_CONSENT с уже
 * APPROVED-строкой в `tg_approvals` и атомарно исполняет их — БЕЗ участия
 * модели вообще. Та же дисциплина, что у execute-фазы `requireConsent`:
 * binding (rehash) + одноразовость (`consumeManifest`) + аудит-лог — только
 * шаги (3) и (3.5) (классификация `user_reply`, включая negative/affirmative)
 * пропущены, потому что кнопка в Telegram УЖЕ есть окончательное согласие
 * человека для этого инструмента (`tg.enabledFor(tool)` было истинно в
 * момент постройки плана — иначе строка в `tg_approvals` не появилась бы).
 *
 * ВАЖНО (два независимых режима — прямое требование Максима): эта функция
 * вызывается ТОЛЬКО фоновым поллером для манифестов, у которых
 * `tg.enabledFor(tool)` было истинно на момент плана. Обычный путь через
 * `requireConsent()` (чат-«да», без TG) НЕ меняется НИ НА БИТ — это отдельная
 * функция, а не альтернативная ветка внутри `requireConsent`, чтобы не
 * рисковать регрессией старого поведения.
 *
 * Возвращает null (не бросает), если манифест уже неактуален (гонка с чем-то
 * ещё, TTL истёк, дрейф состояния) — вызывающий поллер просто пропускает и
 * логирует, это не ошибка.
 */
export interface AutoExecuteResult<T = unknown> {
  manifestId: string;
  tool: string;
  accountLabel: string;
  payload: T;
  auditId: string;
}

/** Метка вместо `user_reply` человека — честно отражает происхождение
 * (кнопка, не текст), видна в аудит-логе. НЕ выглядит как утвердительное
 * слово специально — если этот текст случайно попадёт куда-то ещё
 * (например по ошибке будет передан в `requireConsent` напрямую), он не
 * должен пройти обычную классификацию `classifyReply` как настоящее «да». */
export const TG_AUTO_REPLY_MARKER = "[авто: подтверждено кнопкой в Telegram]";

export async function tryAutoExecute<T = unknown>(
  candidate: { manifestId: string; tool: string; accountLabel: string },
  rehash: (addressing: ConsentAddressing) => string | Promise<string>,
  store: ConsentStore,
  cfg: ConsentConfig,
): Promise<AutoExecuteResult<T> | null> {
  const now = cfg.now ?? Date.now;

  const row = await store.getManifest(candidate.manifestId, cfg.server);
  if (
    !row ||
    row.tool !== candidate.tool ||
    row.accountLabel !== candidate.accountLabel ||
    row.status !== "AWAITING_CONSENT"
  ) {
    return null;
  }

  // Binding — та же проверка, что в requireConsent (4): живой мир не уехал
  // между планом и нажатием кнопки.
  const currentHash = await rehash(row.payload);
  if (currentHash !== row.objectHash) {
    return null;
  }

  // Одноразовость — тот же атомарный consumeManifest, что и у обычного пути.
  const consumed = await store.consumeManifest(candidate.manifestId, cfg.server, TG_AUTO_REPLY_MARKER);
  if (!consumed) return null;

  const auditId = randomUUID();
  await store.appendConsentAudit({
    id: auditId,
    ts: now(),
    server: cfg.server,
    tool: candidate.tool,
    accountLabel: candidate.accountLabel,
    manifestId: candidate.manifestId,
    objectHash: row.objectHash,
    userReply: TG_AUTO_REPLY_MARKER,
    checks: { tgApproval: "approved", binding: "ok", oneShot: "ok" },
    outcome: "confirmed",
    // "tg_auto" — честно отличается от "human": подтверждение кнопкой, не
    // текстовой репликой в чате. Тип поля — `string` (см. интерфейс выше),
    // менять его не нужно.
    actor: "tg_auto",
  });

  return {
    manifestId: candidate.manifestId,
    tool: candidate.tool,
    accountLabel: candidate.accountLabel,
    payload: consumed.payload as T,
    auditId,
  };
}
