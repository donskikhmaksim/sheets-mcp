/**
 * Google Sheets tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { sheets_v4 } from "googleapis";
import { ok, fail, guard, safeText, mapWithLimit, withRetry } from "../util.js";
import { accountField, getAutoExecuteClients, type UserClients } from "../accounts.js";
import type { GoogleClients } from "../google.js";
import {
  requireConsent,
  sha256,
  formatLaTime,
  USER_REPLY_DOC,
  AUTOMATION_KEY_DOC,
  type ConsentStore,
  type ConsentConfig,
  type ConsentPlan,
  type TgApprovalGate,
} from "../consent.js";
import { registerAutoExecutor, type AutoExecutorCtx } from "../autoExecute.js";
import { renderAutoExecuteReport } from "../report.js";

/** One row of the shared consent_audit log, as read by `sheets_consent_audit`.
 * Mirrors store.ts's `ConsentAuditRow` structurally — same "don't import
 * store.ts directly, context provides adapters" convention as elsewhere;
 * `server.ts` wires the real implementation in. */
interface ConsentAuditRow {
  id: string;
  ts: number;
  tool: string;
  accountLabel: string;
  manifestId?: string | null;
  objectHash?: string | null;
  userReply: string;
  outcome: string;
  refusalReason?: string | null;
  actor: string;
  postVerifyResult: string | null;
  error: string | null;
  preSnapshot: unknown;
}

interface ConsentAuditFilters {
  server: string;
  since?: number;
  until?: number;
  accountLabel?: string;
  tool?: string;
  outcome?: string;
}

/** Read-only access to the consent-gate audit log — "разбор инцидента без
 * ssh" (limits-audit.md §11). Separate from `ConsentStore` above: this is
 * neither the plan nor the execute gate, just a read path over the same
 * consent_audit table the gate already writes to. */
interface AuditStore {
  listConsentAudit(filters: ConsentAuditFilters, limit?: number, offset?: number): Promise<ConsentAuditRow[]>;
  countConsentAudit(filters: ConsentAuditFilters): Promise<number>;
}

/** Context threaded into `registerSheetsTools`/`registerTriageTools` carrying
 * the consent-gate wiring (ported from gmail-mcp's `GmailSnoozeContext`). */
export interface SheetsConsentContext {
  /** Consent-gate storage. null exactly when Postgres isn't configured —
   * every gated write tool below refuses outright when this is null
   * (gate.md §3.5: no durable manifest storage means no gate, and that must
   * never become a silent bypass). */
  consentStore: ConsentStore | null;
  /** Gate knobs (TTL / anti-doublet gap / batch cap), always present even
   * when consentStore is null so a refusal message can still be built
   * without a crash. Real value comes from `consentServerConfig` in
   * server.ts (env-driven). */
  consentCfg: ConsentConfig;
  /** Read-only access to the consent_audit log. null exactly when Postgres
   * isn't configured (same honest-degradation rule as `consentStore`). */
  auditStore: AuditStore | null;
  /** Опциональный внеполосный ТГ-фактор (ported from gmail-mcp). undefined ⇒
   * поведение гейта побайтово как до добавления TG-approval. */
  tg?: TgApprovalGate;
  /** DI-проверка `automation_key` (ТЗ `TZ_automation_key_consent_gate.md`).
   * undefined ⇒ automation_key-ветка в `requireConsent` целиком выключена,
   * поведение побайтово как до этой правки. Реальное значение — `server.ts`'s
   * `checkAutomationKey` (читает общую `tg_automation_windows`). */
  checkAutomationKey?: (key: string) => Promise<{ ok: boolean; channel?: string }>;
}

/** Fallback gate config for callers that don't wire a real one (offline unit
 * tests exercising other tools). Mirrors config.ts's `loadConsentGateConfig()`
 * defaults; production always gets the real env-driven config from server.ts. */
const DEFAULT_CONSENT_CFG: ConsentConfig = {
  server: "sheets",
  consentTtlMs: 3_600_000,
  minConsentGapMs: 2_000,
  sendBatchMax: 10,
};

const DEFAULT_CONSENT_CTX: SheetsConsentContext = {
  consentStore: null,
  consentCfg: DEFAULT_CONSENT_CFG,
  auditStore: null,
};

/** "#RRGGBB" (or "RRGGBB") -> Sheets API color object. */
function hexToColor(hex: string): sheets_v4.Schema$Color {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Bad color "${hex}", expected #RRGGBB.`);
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** Column letters -> 0-based index (A->0, B->1, ... AA->26). Exported for tests. */
export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parses an A1 range (optionally "Sheet1!A1:C10") into a Sheets GridRange.
 * Resolves the sheet title to a numeric sheetId via the provided lookup.
 */
export function a1ToGridRange(
  range: string,
  sheetIdByTitle: Map<string, number>,
  firstSheetId: number,
): sheets_v4.Schema$GridRange {
  const trimmed = range.trim();
  let sheetPart: string | undefined;
  let cells: string;
  const bang = trimmed.lastIndexOf("!");
  if (bang >= 0) {
    sheetPart = trimmed.slice(0, bang).replace(/^'|'$/g, "");
    cells = trimmed.slice(bang + 1).trim();
  } else if (/^[A-Za-z]+\d/.test(trimmed)) {
    // Looks like a cell reference (e.g. A1) on the default sheet.
    cells = trimmed;
  } else {
    // A bare tab name => whole sheet.
    sheetPart = trimmed;
    cells = "";
  }
  const sheetId = sheetPart
    ? sheetIdByTitle.get(sheetPart) ??
      (() => {
        throw new Error(`No sheet/tab named "${sheetPart}".`);
      })()
    : firstSheetId;

  if (!cells) return { sheetId }; // whole sheet
  const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(cells);
  if (!m) throw new Error(`Cannot parse range "${cells}". Use e.g. A1 or A1:C10.`);
  const startCol = colToIndex(m[1]);
  const startRow = parseInt(m[2], 10) - 1;
  const endCol = m[3] ? colToIndex(m[3]) : startCol;
  const endRow = m[4] ? parseInt(m[4], 10) - 1 : startRow;
  return {
    sheetId,
    startRowIndex: startRow,
    endRowIndex: endRow + 1,
    startColumnIndex: startCol,
    endColumnIndex: endCol + 1,
  };
}

/** 0-based column index → letters (0→A, 25→Z, 26→AA). Handles columns past Z. */
export function colIndexToLetters(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Sheets API Color → "#RRGGBB" string, or null for unset/pure-black. */
function colorToHex(c?: sheets_v4.Schema$Color | null): string | null {
  if (!c) return null;
  const r = Math.round((c.red ?? 0) * 255);
  const gr = Math.round((c.green ?? 0) * 255);
  const b = Math.round((c.blue ?? 0) * 255);
  if (r === 0 && gr === 0 && b === 0) return null; // default / transparent
  return `#${r.toString(16).padStart(2, "0")}${gr.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Compact, human-readable summary of a cell's CellFormat. */
function summariseFormat(fmt?: sheets_v4.Schema$CellFormat | null) {
  if (!fmt) return null;
  const tf = fmt.textFormat;
  return {
    backgroundColor: colorToHex(fmt.backgroundColor),
    textColor: colorToHex(tf?.foregroundColor),
    bold: tf?.bold ?? false,
    italic: tf?.italic ?? false,
    strikethrough: tf?.strikethrough ?? false,
    underline: tf?.underline ?? false,
    fontSize: tf?.fontSize ?? null,
    fontFamily: tf?.fontFamily ?? null,
    horizontalAlignment: fmt.horizontalAlignment ?? null,
    verticalAlignment: fmt.verticalAlignment ?? null,
    wrapStrategy: fmt.wrapStrategy ?? null,
    numberFormat: fmt.numberFormat
      ? { type: fmt.numberFormat.type, pattern: fmt.numberFormat.pattern }
      : null,
    borders: fmt.borders
      ? {
          top: fmt.borders.top?.style ?? null,
          bottom: fmt.borders.bottom?.style ?? null,
          left: fmt.borders.left?.style ?? null,
          right: fmt.borders.right?.style ?? null,
        }
      : null,
  };
}

/** Best-effort display string for a cell, mirroring what the user sees. */
function cellText(cell: sheets_v4.Schema$CellData): string | null {
  if (cell.formattedValue != null) return cell.formattedValue;
  const ev = cell.effectiveValue ?? cell.userEnteredValue;
  if (!ev) return null;
  if (ev.stringValue != null) return ev.stringValue;
  if (ev.numberValue != null) return String(ev.numberValue);
  if (ev.boolValue != null) return ev.boolValue ? "TRUE" : "FALSE";
  if (ev.formulaValue != null) return ev.formulaValue;
  if (ev.errorValue) return ev.errorValue.message ?? "#ERROR";
  return null;
}

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valuesField = z.array(z.array(cellValue)).describe("2D array of rows × columns.");
const valueInputOptionField = z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED").optional();

// ── Consent-gate machinery (mcp-development-standard/references/gate.md) ───
// Ported from gmail-mcp's tools/gmail.ts: the same requireConsent/plan→execute
// wiring, one §5.3 report renderer, and REAL (non-tautological) rehash for
// every gated write below — each rehash re-reads the LIVE target (range
// content / spreadsheet title / tab list / cell formatting) at execute time,
// never `sha256(payload)` in disguise, except where noted (sheets_create has
// no live object to bind against yet — same documented degenerate case as
// gmail_send).

type PostVerifyOutcome = "ok" | "warn" | "mismatch";
interface VerifyLine {
  outcome: PostVerifyOutcome;
  line: string;
}

/** Now, formatted for America/Los_Angeles. */
function nowInLA(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }) + " America/Los_Angeles";
}

/** Worst outcome across a batch, for choosing the summary status header. */
function worstOutcome(results: Array<{ outcome: PostVerifyOutcome }>): PostVerifyOutcome {
  if (results.some((r) => r.outcome === "mismatch")) return "mismatch";
  if (results.some((r) => r.outcome === "warn")) return "warn";
  return "ok";
}

/** One §5.3 renderer for the whole file (output-format.md §7.1 p.5: "an
 * instrument hand-rolling its own status string is a defect"). */
function renderVerifyReport(title: string, subtitle: string, results: VerifyLine[]): string {
  const okN = results.filter((r) => r.outcome === "ok").length;
  const warnN = results.filter((r) => r.outcome === "warn").length;
  const mmN = results.filter((r) => r.outcome === "mismatch").length;
  const body = results.map((r) => r.line).join("\n");
  return (
    `### 🧾 ${title}\n` +
    `_${nowInLA()} · ${subtitle}_\n\n` +
    `${body}\n\n` +
    `**Итог: ✅ ${okN} подтверждено, ⚠️ ${warnN} не проверено, ❌ ${mmN} расхождение.**\n` +
    `_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО — это серверная проверка, не заменяй пересказом]_`
  );
}

/**
 * Aggregates a gated batch mutation's per-item results with REAL independent
 * post-verify reads: every item without an execute-time `error` gets a fresh
 * `verify` read, the response header reflects the WORST outcome (never
 * smoothed to ✅ on a ❌ — §5.3), and the audit row's phase-2 outcome is
 * filled in via `updateConsentAuditOutcome` so `sheets_consent_audit` shows
 * what actually happened, not just that the human said yes.
 */
async function buildMutationResult<T extends { error?: string; spreadsheetId?: string }>(opts: {
  results: T[];
  total: number;
  verb: string;
  summaryIcon: string;
  verify: (item: T) => Promise<VerifyLine>;
  reportTitle: string;
  reportSubtitle: string;
  consentStore?: ConsentStore;
  auditId?: string;
  preSnapshot?: unknown;
  /** Pass the account's Google client to annotate each result with the
   * spreadsheet's human-readable `spreadsheetTitle` (output-format.md §7.1
   * p.2: objects are shown by name, not raw id). Titles are fetched at most
   * once per distinct `spreadsheetId` in this batch. Omit for tools whose
   * results already carry the spreadsheet's own title verbatim (sheets_create
   * — the title IS the input, re-fetching it would be redundant). */
  g?: GoogleClients;
}): Promise<ReturnType<typeof ok>> {
  const { results, total, verb, summaryIcon, verify, reportTitle, reportSubtitle, consentStore, auditId, preSnapshot, g } = opts;
  const succeeded = results.filter((r) => !r.error);
  const pv = await mapWithLimit(succeeded, (r) => verify(r));
  let outResults: unknown[] = results;
  if (g) {
    const titleCache: TitleCache = new Map();
    outResults = await mapWithLimit(results, async (r) => {
      const id = r.spreadsheetId;
      const spreadsheetTitle = id ? await cachedSpreadsheetTitle(g, titleCache, id) : null;
      return { ...r, spreadsheetTitle };
    });
  }
  const okN = succeeded.length;
  const failN = total - okN;
  const worst = worstOutcome(pv);
  let icon = summaryIcon;
  let tail = "";
  if (worst === "mismatch") {
    icon = "❌";
    tail = " — РАСХОЖДЕНИЕ при проверке, см. отчёт";
  } else if (worst === "warn" || failN > 0) {
    icon = "⚠️";
    if (failN > 0) tail = ` (${failN} с ошибкой)`;
  }
  if (consentStore && auditId) {
    const errs = results
      .filter((r): r is T & { error: string } => !!r.error)
      .map((r) => r.error)
      .join("; ");
    await consentStore
      .updateConsentAuditOutcome(auditId, {
        outcome: okN > 0 ? "confirmed" : "failed",
        postVerify:
          `${icon} ${verb} ${okN}/${total}${tail}` + (pv.length ? ` · post-verify: ${pv.map((p) => p.line).join("; ")}` : ""),
        error: errs || null,
        ...(preSnapshot !== undefined ? { preSnapshot } : {}),
      })
      .catch((e) => {
        console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e));
      });
  }
  return ok({
    summary: `${icon} ${verb} ${okN}/${total}${tail}`,
    results: outResults,
    ...(pv.length ? { verification: renderVerifyReport(reportTitle, reportSubtitle, pv) } : {}),
  });
}

/** Live cell VALUES of an A1 range, or null if the read itself failed. Used
 * both to build the pre-write pre-snapshot at plan time AND to re-read the
 * same range at rehash/post-verify time — the identical function on both
 * sides is what makes the binding a real drift check, not a tautology. */
async function liveRangeValues(g: GoogleClients, spreadsheetId: string, range: string): Promise<unknown[][] | null> {
  try {
    const res = await g.sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values ?? [];
  } catch {
    return null; // range/tab may not exist yet — treated as "empty" by callers, not a hard failure
  }
}

/** Live spreadsheet title, or null if unreadable (deleted/no access) — used
 * for identity-guard/binding on tools whose target is a whole spreadsheet
 * rather than a specific range (create/add_tab/append/raw_batch_update). */
async function liveSpreadsheetTitle(g: GoogleClients, spreadsheetId: string): Promise<string | null> {
  try {
    const res = await g.sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title" });
    return res.data.properties?.title ?? null;
  } catch {
    return null;
  }
}

/** A per-request cache for `liveSpreadsheetTitle`, so a batch of items that
 * share a `spreadsheetId` (write_range/clear_range/append_rows/format_range/
 * add_tab) fetch the spreadsheet's human-readable title at most once, not
 * once per item. Callers create ONE cache per tool invocation (not module- or
 * server-scoped — a stale title must never leak across requests) and pass it
 * to `cachedSpreadsheetTitle`. */
type TitleCache = Map<string, Promise<string | null>>;

async function cachedSpreadsheetTitle(g: GoogleClients, cache: TitleCache, spreadsheetId: string): Promise<string | null> {
  let p = cache.get(spreadsheetId);
  if (!p) {
    p = liveSpreadsheetTitle(g, spreadsheetId);
    cache.set(spreadsheetId, p);
  }
  return p;
}

/** Live tab titles for a spreadsheet, or null if unreadable. */
async function liveTabTitles(g: GoogleClients, spreadsheetId: string): Promise<string[] | null> {
  try {
    const res = await g.sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    return (res.data.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

/** Post-verify: re-reads a range and confirms it now holds the requested
 * values (dimension + cell-by-cell compare against what was requested to
 * write). A SEPARATE fresh read — never reuses the mutation call's own
 * response as proof (§5.1 p.1). */
async function postVerifyRangeWritten(
  g: GoogleClients,
  spreadsheetId: string,
  range: string,
  expected: unknown[][],
): Promise<VerifyLine> {
  const live = await liveRangeValues(g, spreadsheetId, range);
  const label = safeText(range) || "(диапазон)";
  if (live === null) {
    return { outcome: "warn", line: `- ⚠️ **«${label}»** — не удалось перепроверить (${safeText(spreadsheetId)})` };
  }
  const rows = Math.min(expected.length, live.length);
  let mismatchAt: string | null = null;
  for (let r = 0; r < rows && !mismatchAt; r++) {
    const cols = Math.min(expected[r].length, live[r]?.length ?? 0);
    for (let c = 0; c < cols; c++) {
      // Sheets round-trips numbers/booleans as their live JS type but may
      // stringify formulas/USER_ENTERED input — compare loosely via String().
      if (String(expected[r][c] ?? "") !== String(live[r]?.[c] ?? "")) {
        mismatchAt = `${String.fromCharCode(65 + c)}${r + 1}`;
        break;
      }
    }
  }
  if (mismatchAt || live.length < expected.length) {
    return {
      outcome: "mismatch",
      line: `- ❌ **«${label}»** — живое содержимое не совпадает с запрошенным${mismatchAt ? ` (расхождение у ${mismatchAt})` : " (меньше строк, чем записано)"}`,
    };
  }
  return { outcome: "ok", line: `- ✅ **«${label}»** — записано, живое содержимое совпадает` };
}

/** Post-verify: re-reads a range and confirms it is now empty (or absent). */
async function postVerifyRangeCleared(g: GoogleClients, spreadsheetId: string, range: string): Promise<VerifyLine> {
  const live = await liveRangeValues(g, spreadsheetId, range);
  const label = safeText(range) || "(диапазон)";
  if (live === null) {
    return { outcome: "warn", line: `- ⚠️ **«${label}»** — не удалось перепроверить` };
  }
  const stillHasData = live.some((row) => row.some((c) => c !== "" && c != null));
  if (stillHasData) {
    return { outcome: "mismatch", line: `- ❌ **«${label}»** — в диапазоне всё ещё есть данные` };
  }
  return { outcome: "ok", line: `- ✅ **«${label}»** — диапазон пуст` };
}

/** Post-verify: spreadsheet still exists and its title matches (identity
 * confirmation for whole-spreadsheet mutations: create/add_tab/append). */
async function postVerifySpreadsheetIdentity(
  g: GoogleClients,
  spreadsheetId: string,
  expectedTitle: string | null,
  label: string,
): Promise<VerifyLine> {
  const title = await liveSpreadsheetTitle(g, spreadsheetId);
  const lbl = safeText(label) || "(таблица)";
  if (title === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить таблицу ${safeText(spreadsheetId)}` };
  }
  if (expectedTitle !== null && title !== expectedTitle) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — название таблицы изменилось: живое «${safeText(title)}»` };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(title) || lbl}»** — таблица существует` };
}

/** Post-verify: a tab with this title now exists in the spreadsheet. */
async function postVerifyTabExists(g: GoogleClients, spreadsheetId: string, title: string): Promise<VerifyLine> {
  const tabs = await liveTabTitles(g, spreadsheetId);
  const lbl = safeText(title) || "(вкладка)";
  if (tabs === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить список вкладок` };
  }
  if (!tabs.includes(title)) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — вкладки нет среди живых: ${tabs.map((t) => safeText(t, 40)).join(", ") || "(пусто)"}` };
  }
  return { outcome: "ok", line: `- ✅ **«${lbl}»** — вкладка существует` };
}

/** Post-verify: re-reads formatting of a range and confirms the requested
 * fields now hold the requested values. */
async function postVerifyFormatApplied(
  g: GoogleClients,
  spreadsheetId: string,
  range: string,
  expected: Partial<{
    bold: boolean;
    italic: boolean;
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    horizontalAlignment: string;
    verticalAlignment: string;
    wrapStrategy: string;
  }>,
): Promise<VerifyLine> {
  const label = safeText(range) || "(диапазон)";
  try {
    const res = await g.sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      includeGridData: true,
      fields: "sheets(data(rowData(values(userEnteredFormat))))",
    });
    const cell = res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
    const fmt = cell?.userEnteredFormat;
    const tf = fmt?.textFormat;
    const mismatches: string[] = [];
    if (expected.bold !== undefined && !!tf?.bold !== expected.bold) mismatches.push("bold");
    if (expected.italic !== undefined && !!tf?.italic !== expected.italic) mismatches.push("italic");
    if (expected.fontSize !== undefined && tf?.fontSize !== expected.fontSize) mismatches.push("fontSize");
    if (mismatches.length) {
      return { outcome: "mismatch", line: `- ❌ **«${label}»** — не совпало: ${mismatches.join(", ")}` };
    }
    return { outcome: "ok", line: `- ✅ **«${label}»** — форматирование применено` };
  } catch {
    return { outcome: "warn", line: `- ⚠️ **«${label}»** — не удалось перепроверить форматирование` };
  }
}

/** Post-verify for `sheets_raw_batch_update`: content-level verification of an
 * ARBITRARY batchUpdate request is not generically possible (honest limit,
 * STANDARD §15.1 Q20 — must be named up front, always ⚠️). This only confirms
 * the spreadsheet is still reachable after the call. */
async function postVerifyRawBatchApplied(g: GoogleClients, spreadsheetId: string): Promise<VerifyLine> {
  const title = await liveSpreadsheetTitle(g, spreadsheetId);
  if (title === null) {
    return { outcome: "warn", line: `- ⚠️ **(${safeText(spreadsheetId)})** — таблица недоступна после применения` };
  }
  return {
    outcome: "warn",
    line: `- ⚠️ **«${safeText(title)}»** — запрос применён без ошибки; произвольный batchUpdate нельзя обобщённо перепроверить по содержимому (честный предел, см. GUIDE.md)`,
  };
}

/** Dry (non-mutating) find — same matching semantics as `sheets_find_replace`
 * (literal substring, `matchCase`), returning every matching cell's address
 * and CURRENT value. Used identically at plan time (to build the preview +
 * pre-snapshot) and at rehash/post-verify time (to detect drift) — the
 * shared function is what makes the binding real, not `sha256(payload)`. */
async function dryFindMatches(
  g: GoogleClients,
  opts: { spreadsheetId: string; find: string; matchCase: boolean; sheetId?: number },
): Promise<Array<{ sheet: string | null; sheetId: number | null; cell: string; value: string }>> {
  const res = await g.sheets.spreadsheets.get({
    spreadsheetId: opts.spreadsheetId,
    includeGridData: true,
    fields: "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,effectiveValue,userEnteredValue))))",
  });
  const needle = opts.matchCase ? opts.find : opts.find.toLowerCase();
  const found: Array<{ sheet: string | null; sheetId: number | null; cell: string; value: string }> = [];
  for (const sheet of res.data.sheets ?? []) {
    const sid = sheet.properties?.sheetId ?? null;
    if (opts.sheetId !== undefined && sid !== opts.sheetId) continue;
    const tab = sheet.properties?.title ?? null;
    for (const gd of sheet.data ?? []) {
      const startRow = gd.startRow ?? 0;
      const startCol = gd.startColumn ?? 0;
      for (const [ri, rowData] of (gd.rowData ?? []).entries()) {
        for (const [ci, cell] of (rowData.values ?? []).entries()) {
          const value = cellText(cell);
          if (value === null || value === "") continue;
          const hay = opts.matchCase ? value : value.toLowerCase();
          if (!hay.includes(needle)) continue;
          const colLetter = colIndexToLetters(startCol + ci);
          found.push({ sheet: tab, sheetId: sid, cell: `${colLetter}${startRow + ri + 1}`, value });
        }
      }
    }
  }
  return found;
}

// ── Payload shapes stored in consent_manifests for the gated tools below ────
// These are exactly what `decision.payload` carries back in the confirmed
// branch — the source of truth for the mutation, never the caller's arguments
// on the execute call (plan §A3 blocker requirement). Module-level (not
// nested inside `registerSheetsTools`, unlike the request-scoped code that
// builds them) so both the tool handler AND the module-level auto-executors
// registered further down (Максим, 2026-08-05 — Telegram-button auto-execute,
// see autoExecute.ts) can reference the same type.
interface WriteRangeItem {
  spreadsheetId: string;
  range: string;
  values: unknown[][];
  valueInputOption?: "USER_ENTERED" | "RAW";
}
interface WriteRangePayload {
  account: string;
  items: WriteRangeItem[];
}
interface AppendRowsItem {
  spreadsheetId: string;
  range: string;
  values: unknown[][];
  valueInputOption?: "USER_ENTERED" | "RAW";
}
interface AppendRowsPayload {
  account: string;
  items: AppendRowsItem[];
}
interface ClearRangeItem {
  spreadsheetId: string;
  range: string;
}
interface ClearRangePayload {
  account: string;
  items: ClearRangeItem[];
}
interface CreateItem {
  title: string;
  sheetTitles?: string[];
}
interface CreatePayload {
  account: string;
  spreadsheets: CreateItem[];
}
interface AddTabItem {
  spreadsheetId: string;
  title: string;
}
interface AddTabPayload {
  account: string;
  items: AddTabItem[];
}
interface FindReplacePayload {
  account: string;
  spreadsheetId: string;
  find: string;
  replace: string;
  matchCase: boolean;
  sheetId?: number;
}
type FormatItem = {
  spreadsheetId: string;
  range: string;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  textColor?: string;
  backgroundColor?: string;
  horizontalAlignment?: "LEFT" | "CENTER" | "RIGHT";
  verticalAlignment?: "TOP" | "MIDDLE" | "BOTTOM";
  wrapStrategy?: "OVERFLOW_CELL" | "CLIP" | "WRAP";
  numberFormatType?: "NUMBER" | "CURRENCY" | "PERCENT" | "DATE" | "TIME" | "DATE_TIME" | "TEXT" | "SCIENTIFIC";
  numberFormatPattern?: string;
};
interface FormatRangePayload {
  account: string;
  items: FormatItem[];
}
interface RawBatchPayload {
  account: string;
  spreadsheetId: string;
  requests: object[];
}

// ── Binding-snapshot helpers, hoisted to module level ────────────────────────
// Originally declared inside `registerSheetsTools` (request-scoped); moved
// here UNCHANGED (they only ever took `g`/items as explicit parameters, no
// closure over `clients`/`ctx`/`server`) so the module-level `rehash` callbacks
// registered via `registerAutoExecutor` below can call them too — the auto-
// execute registry is populated once at import time, outside any request.
async function writeRangeBindingSnapshot(g: GoogleClients, items: WriteRangeItem[]) {
  return mapWithLimit(items, async (it) => ({
    spreadsheetId: it.spreadsheetId,
    range: it.range,
    preValues: (await liveRangeValues(g, it.spreadsheetId, it.range)) ?? [],
  }));
}
async function appendBindingSnapshot(g: GoogleClients, items: AppendRowsItem[]) {
  return mapWithLimit(items, async (it) => ({
    spreadsheetId: it.spreadsheetId,
    title: await liveSpreadsheetTitle(g, it.spreadsheetId),
  }));
}
async function clearBindingSnapshot(g: GoogleClients, items: ClearRangeItem[]) {
  return mapWithLimit(items, async (it) => ({
    spreadsheetId: it.spreadsheetId,
    range: it.range,
    preValues: (await liveRangeValues(g, it.spreadsheetId, it.range)) ?? [],
  }));
}
async function addTabBindingSnapshot(g: GoogleClients, items: AddTabItem[]) {
  return mapWithLimit(items, async (it) => ({
    spreadsheetId: it.spreadsheetId,
    title: it.title,
    liveTitle: await liveSpreadsheetTitle(g, it.spreadsheetId),
    liveTabs: (await liveTabTitles(g, it.spreadsheetId)) ?? [],
  }));
}
async function formatBindingSnapshot(g: GoogleClients, items: FormatItem[]) {
  return mapWithLimit(items, async (it) => {
    try {
      const res = await g.sheets.spreadsheets.get({
        spreadsheetId: it.spreadsheetId,
        ranges: [it.range],
        includeGridData: true,
        fields: "sheets(data(rowData(values(userEnteredFormat))))",
      });
      const cell = res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
      return { spreadsheetId: it.spreadsheetId, range: it.range, currentFormat: summariseFormat(cell?.userEnteredFormat) };
    } catch {
      return { spreadsheetId: it.spreadsheetId, range: it.range, currentFormat: null };
    }
  });
}

// Human-readable Telegram-report extraction now lives in `../report.js`'s
// `renderAutoExecuteReport` (task #131, 2026-08-06 — the old `extractText`
// here just returned `result.content[0].text`, which for any object payload
// IS `JSON.stringify(data, null, 2)` — raw JSON, including a model-directive
// line from `renderVerifyReport`'s `verification`, reached Telegram
// unfiltered). See that file's top comment for the full story.

// ── Auto-execute cores (Максим, 2026-08-05) ──────────────────────────────────
// Ядро исполнения каждого гейтованного тула — вынесено из тела тула (после
// `decision.kind === "confirmed"`), чтобы БЫТЬ ВЫЗЫВАЕМЫМ И ИЗ обычного MCP
// tool-хендлера (модель вызвала execute второй раз), И ИЗ фонового
// авто-поллера (кнопка в Telegram сама триггерит это через autoExecute.ts,
// без участия модели вообще — см. consent.ts's `tryAutoExecute` doc-comment).
// Логика мутации НЕ изменена ни на строчку — только извлечена в функцию.
// Регистрация автоисполнителей — на уровне МОДУЛЯ (autoExecute.ts's
// doc-comment: `registerSheetsTools` вызывается заново на каждый запрос).

async function executeWriteRangeCore(
  g: GoogleClients,
  payload: WriteRangePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await writeRangeBindingSnapshot(g, payload.items);

  // Group by spreadsheetId (same batching strategy as before the gate).
  const byId = new Map<string, WriteRangeItem[]>();
  for (const item of payload.items) {
    const list = byId.get(item.spreadsheetId) ?? [];
    list.push(item);
    byId.set(item.spreadsheetId, list);
  }
  const results: Array<{ spreadsheetId: string; range?: string; updatedRange?: string; updatedCells?: number | null; error?: string }> = [];
  for (const [spreadsheetId, group] of byId) {
    if (group.length === 1) {
      const { range, values, valueInputOption } = group[0];
      try {
        const res = await withRetry(() =>
          g.sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: valueInputOption ?? "USER_ENTERED",
            requestBody: { values },
          }),
        );
        results.push({ spreadsheetId, range, updatedRange: res.data.updatedRange ?? range, updatedCells: res.data.updatedCells });
      } catch (e: unknown) {
        results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
      }
    } else {
      const vio = group[0].valueInputOption ?? "USER_ENTERED";
      try {
        const res = await withRetry(() =>
          g.sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: vio, data: group.map(({ range, values }) => ({ range, values })) },
          }),
        );
        for (const [i, resp] of (res.data.responses ?? []).entries()) {
          results.push({ spreadsheetId, range: group[i]?.range, updatedRange: resp.updatedRange ?? undefined, updatedCells: resp.updatedCells });
        }
      } catch (e: unknown) {
        for (const it of group) results.push({ spreadsheetId, range: it.range, error: String(e instanceof Error ? e.message : e) });
      }
    }
  }

  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Записано",
    summaryIcon: "✏️",
    verify: (r) => postVerifyRangeWritten(g, r.spreadsheetId, r.range!, payload.items.find((it) => it.spreadsheetId === r.spreadsheetId && it.range === r.range)?.values ?? []),
    reportTitle: "Независимая проверка записи",
    reportSubtitle: "запрошено ⇄ живое содержимое Google Sheets",
    consentStore,
    auditId,
    preSnapshot,
    g,
  });
}

registerAutoExecutor("sheets_write_range", {
  rehash: async (addressing) => {
    const a = addressing as WriteRangePayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const snapshot = await writeRangeBindingSnapshot(g, a.items);
    return sha256({
      account: a.account,
      items: snapshot.map((s) => ({ spreadsheetId: s.spreadsheetId, range: s.range, preValues: s.preValues })),
    });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as WriteRangePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeWriteRangeCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeAppendRowsCore(
  g: GoogleClients,
  payload: AppendRowsPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const results: Array<{ spreadsheetId: string; range?: string; updatedRange?: string; error?: string }> = [];
  for (const { spreadsheetId, range, values, valueInputOption } of payload.items) {
    try {
      const res = await withRetry(() =>
        g.sheets.spreadsheets.values.append({
          spreadsheetId,
          range,
          valueInputOption: valueInputOption ?? "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values },
        }),
      );
      results.push({ spreadsheetId, range, updatedRange: res.data.updates?.updatedRange ?? range });
    } catch (e: unknown) {
      results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
    }
  }

  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Добавлено",
    summaryIcon: "➕",
    verify: (r) => postVerifySpreadsheetIdentity(g, r.spreadsheetId, null, r.updatedRange ?? r.spreadsheetId),
    reportTitle: "Независимая проверка добавления строк",
    reportSubtitle: "запрошено ⇄ живое состояние Google Sheets",
    consentStore,
    auditId,
    g,
  });
}

registerAutoExecutor("sheets_append_rows", {
  rehash: async (addressing) => {
    const a = addressing as AppendRowsPayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const snapshot = await appendBindingSnapshot(g, a.items);
    return sha256({ account: a.account, items: snapshot });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as AppendRowsPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeAppendRowsCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeClearRangeCore(
  g: GoogleClients,
  payload: ClearRangePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const preSnapshot = await clearBindingSnapshot(g, payload.items);
  const results: Array<{ spreadsheetId: string; range?: string; clearedRange?: string; clearedRowCount?: number; error?: string }> = [];
  for (const { spreadsheetId, range } of payload.items) {
    try {
      const before = preSnapshot.find((s) => s.spreadsheetId === spreadsheetId && s.range === range)?.preValues ?? [];
      const res = await withRetry(() => g.sheets.spreadsheets.values.clear({ spreadsheetId, range }));
      results.push({ spreadsheetId, range, clearedRange: res.data.clearedRange ?? range, clearedRowCount: before.length });
    } catch (e: unknown) {
      results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
    }
  }

  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Очищено",
    summaryIcon: "🧹",
    verify: (r) => postVerifyRangeCleared(g, r.spreadsheetId, r.range!),
    reportTitle: "Независимая проверка очистки",
    reportSubtitle: "запрошено ⇄ живое содержимое Google Sheets",
    consentStore,
    auditId,
    preSnapshot,
    g,
  });
}

registerAutoExecutor("sheets_clear_range", {
  rehash: async (addressing) => {
    const a = addressing as ClearRangePayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const snapshot = await clearBindingSnapshot(g, a.items);
    return sha256({ account: a.account, items: snapshot });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as ClearRangePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeClearRangeCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeCreateCore(
  g: GoogleClients,
  payload: CreatePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  // Bounded fan-out (mapWithLimit, cap 8) instead of an unbounded Promise.all
  // — a large batch of spreadsheets used to fire every .create() call at
  // once, tripping Sheets/Drive per-user rate limits. The 429/5xx retry lives
  // in `withRetry`, wrapped around just the one network call so a per-item
  // try/catch below still captures a final failure into `results` instead of
  // throwing.
  const results = await mapWithLimit(payload.spreadsheets, async ({ title, sheetTitles }) => {
    try {
      const res = await withRetry(() =>
        g.sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: sheetTitles?.length ? sheetTitles.map((t) => ({ properties: { title: t } })) : undefined,
          },
          fields: "spreadsheetId,spreadsheetUrl,properties.title",
        }),
      );
      return { spreadsheetId: res.data.spreadsheetId ?? "", title: res.data.properties?.title ?? title, spreadsheetUrl: res.data.spreadsheetUrl };
    } catch (e: unknown) {
      return { spreadsheetId: "", title, error: String(e instanceof Error ? e.message : e) };
    }
  });

  return buildMutationResult({
    results,
    total: payload.spreadsheets.length,
    verb: "Создано",
    summaryIcon: "📄",
    verify: (r) => postVerifySpreadsheetIdentity(g, r.spreadsheetId, r.title, r.title),
    reportTitle: "Независимая проверка создания",
    reportSubtitle: "запрошено ⇄ живое состояние Google Drive",
    consentStore,
    auditId,
    // No `g` here: results already carry the spreadsheet's own `title`
    // verbatim (it's the create input, echoed back) — re-fetching would just
    // duplicate it under a second key.
  });
}

registerAutoExecutor("sheets_create", {
  rehash: (addressing) => sha256(addressing),
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as CreatePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeCreateCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeAddTabCore(
  g: GoogleClients,
  payload: AddTabPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const results: Array<{ spreadsheetId: string; sheetId?: number; title?: string; error?: string }> = [];
  for (const { spreadsheetId, title } of payload.items) {
    try {
      const res = await withRetry(() =>
        g.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title } } }] },
        }),
      );
      const props = res.data.replies?.[0]?.addSheet?.properties;
      results.push({ spreadsheetId, sheetId: props?.sheetId ?? undefined, title: props?.title ?? title });
    } catch (e: unknown) {
      results.push({ spreadsheetId, title, error: String(e instanceof Error ? e.message : e) });
    }
  }

  return buildMutationResult({
    results,
    total: payload.items.length,
    verb: "Добавлено",
    summaryIcon: "📑",
    verify: (r) => postVerifyTabExists(g, r.spreadsheetId, r.title!),
    reportTitle: "Независимая проверка добавления вкладки",
    reportSubtitle: "запрошено ⇄ живой список вкладок",
    consentStore,
    auditId,
    g,
  });
}

registerAutoExecutor("sheets_add_tab", {
  rehash: async (addressing) => {
    const a = addressing as AddTabPayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const snapshot = await addTabBindingSnapshot(g, a.items);
    return sha256({ account: a.account, items: snapshot.map(({ spreadsheetId, title, liveTitle, liveTabs }) => ({ spreadsheetId, title, liveTitle, liveTabs })) });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as AddTabPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeAddTabCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeFindReplaceCore(
  g: GoogleClients,
  payload: FindReplacePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  // Single call, single spreadsheetId per invocation — "cache" here just
  // means "call once", fetched alongside preMatches rather than again per
  // downstream step.
  const [preMatches, spreadsheetTitle] = await Promise.all([
    dryFindMatches(g, {
      spreadsheetId: payload.spreadsheetId,
      find: payload.find,
      matchCase: payload.matchCase,
      sheetId: payload.sheetId,
    }),
    liveSpreadsheetTitle(g, payload.spreadsheetId),
  ]);
  let fr: sheets_v4.Schema$FindReplaceResponse = {};
  let execError: string | undefined;
  try {
    const res = await withRetry(() =>
      g.sheets.spreadsheets.batchUpdate({
        spreadsheetId: payload.spreadsheetId,
        requestBody: {
          requests: [
            {
              findReplace: {
                find: payload.find,
                replacement: payload.replace,
                matchCase: payload.matchCase,
                allSheets: payload.sheetId === undefined ? true : undefined,
                sheetId: payload.sheetId,
              },
            },
          ],
        },
      }),
    );
    fr = res.data.replies?.[0]?.findReplace ?? {};
  } catch (e: unknown) {
    execError = String(e instanceof Error ? e.message : e);
  }

  // Post-verify: re-read each previously-matched cell and confirm it no
  // longer holds the old value (or, if find===replace, that it's unchanged).
  const pv = await mapWithLimit(preMatches, async (m): Promise<VerifyLine> => {
    const cellRange = `${m.sheet ? `'${m.sheet}'!` : ""}${m.cell}`;
    const live = await liveRangeValues(g, payload.spreadsheetId, cellRange);
    const liveVal = live?.[0]?.[0] != null ? String(live[0][0]) : "";
    const expected = payload.matchCase
      ? m.value.split(payload.find).join(payload.replace)
      : m.value.replace(new RegExp(payload.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), payload.replace);
    if (live === null) return { outcome: "warn", line: `- ⚠️ **${safeText(m.cell)}** — не удалось перепроверить` };
    if (payload.find === payload.replace) return { outcome: "ok", line: `- ✅ **${safeText(m.cell)}** — без изменений (find===replace)` };
    if (liveVal === expected) return { outcome: "ok", line: `- ✅ **${safeText(m.cell)}** — «${safeText(liveVal, 60)}»` };
    return { outcome: "mismatch", line: `- ❌ **${safeText(m.cell)}** — живое «${safeText(liveVal, 60)}», ожидалось «${safeText(expected, 60)}»` };
  });
  const worst = worstOutcome(pv);
  const icon = execError ? "❌" : worst === "mismatch" ? "❌" : worst === "warn" ? "⚠️" : "🔁";
  const summary = execError
    ? `❌ Ошибка при замене: ${safeText(execError, 200)}`
    : `${icon} Заменено «${safeText(payload.find, 60)}» → «${safeText(payload.replace, 60)}» — совпадений: ${fr.occurrencesChanged ?? preMatches.length}${payload.sheetId !== undefined ? ` (вкладка ${payload.sheetId})` : " (все вкладки)"}`;
  if (consentStore && auditId) {
    await consentStore
      .updateConsentAuditOutcome(auditId, {
        outcome: execError ? "failed" : "confirmed",
        postVerify: summary + (pv.length ? ` · post-verify: ${pv.map((p) => p.line).join("; ")}` : ""),
        error: execError ?? null,
        preSnapshot: preMatches,
      })
      .catch((e) => console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e)));
  }
  return ok({
    summary,
    spreadsheetId: payload.spreadsheetId,
    spreadsheetTitle,
    findReplace: fr,
    ...(pv.length ? { verification: renderVerifyReport("Независимая проверка замены", "запрошено ⇄ живое содержимое затронутых ячеек", pv) } : {}),
  });
}

registerAutoExecutor("sheets_find_replace", {
  rehash: async (addressing) => {
    const a = addressing as FindReplacePayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const matches = await dryFindMatches(g, { spreadsheetId: a.spreadsheetId, find: a.find, matchCase: a.matchCase, sheetId: a.sheetId });
    return sha256({
      spreadsheetId: a.spreadsheetId,
      find: a.find,
      replace: a.replace,
      matchCase: a.matchCase,
      sheetId: a.sheetId ?? null,
      matches: matches.map((m) => ({ sheet: m.sheet, cell: m.cell, value: m.value })),
    });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as FindReplacePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeFindReplaceCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeFormatRangeCore(
  g: GoogleClients,
  payload: FormatRangePayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  const approvedItems = payload.items;
  const results: Array<{ spreadsheetId: string; range: string; applied?: number; error?: string }> = [];

  for (const item of approvedItems) {
    const {
      spreadsheetId, range, bold, italic, fontSize, textColor,
      backgroundColor, horizontalAlignment, verticalAlignment, wrapStrategy,
      numberFormatType, numberFormatPattern,
    } = item;
    try {
      const fmt: sheets_v4.Schema$CellFormat = {};
      const fields: string[] = [];
      const textFormat: sheets_v4.Schema$TextFormat = {};
      if (bold !== undefined) { textFormat.bold = bold; fields.push("userEnteredFormat.textFormat.bold"); }
      if (italic !== undefined) { textFormat.italic = italic; fields.push("userEnteredFormat.textFormat.italic"); }
      if (fontSize !== undefined) { textFormat.fontSize = fontSize; fields.push("userEnteredFormat.textFormat.fontSize"); }
      if (textColor) { textFormat.foregroundColor = hexToColor(textColor); fields.push("userEnteredFormat.textFormat.foregroundColor"); }
      if (Object.keys(textFormat).length) fmt.textFormat = textFormat;
      if (backgroundColor) { fmt.backgroundColor = hexToColor(backgroundColor); fields.push("userEnteredFormat.backgroundColor"); }
      if (horizontalAlignment) { fmt.horizontalAlignment = horizontalAlignment; fields.push("userEnteredFormat.horizontalAlignment"); }
      if (verticalAlignment) { fmt.verticalAlignment = verticalAlignment; fields.push("userEnteredFormat.verticalAlignment"); }
      if (wrapStrategy) { fmt.wrapStrategy = wrapStrategy; fields.push("userEnteredFormat.wrapStrategy"); }
      if (numberFormatPattern || numberFormatType) {
        fmt.numberFormat = { type: numberFormatType ?? "NUMBER", pattern: numberFormatPattern };
        fields.push("userEnteredFormat.numberFormat");
      }
      if (!fields.length) {
        results.push({ spreadsheetId, range, error: "No formatting options specified." });
        continue;
      }

      const meta = await withRetry(() =>
        g.sheets.spreadsheets.get({
          spreadsheetId,
          fields: "sheets.properties(sheetId,title)",
        }),
      );
      const titleToId = new Map<string, number>();
      for (const s of meta.data.sheets ?? []) {
        if (s.properties?.title && typeof s.properties.sheetId === "number") {
          titleToId.set(s.properties.title, s.properties.sheetId);
        }
      }
      const firstSheetId = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
      const gridRange = a1ToGridRange(range, titleToId, firstSheetId);

      await withRetry(() =>
        g.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              { repeatCell: { range: gridRange, cell: { userEnteredFormat: fmt }, fields: fields.join(",") } },
            ],
          },
        }),
      );
      results.push({ spreadsheetId, range, applied: fields.length });
    } catch (e: unknown) {
      results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
    }
  }

  return buildMutationResult({
    results,
    total: approvedItems.length,
    verb: "Отформатировано",
    summaryIcon: "🎨",
    verify: (r) => {
      const it = approvedItems.find((x) => x.spreadsheetId === r.spreadsheetId && x.range === r.range)!;
      return postVerifyFormatApplied(g, r.spreadsheetId, r.range, {
        bold: it.bold,
        italic: it.italic,
        fontSize: it.fontSize,
      });
    },
    reportTitle: "Независимая проверка форматирования",
    reportSubtitle: "запрошено ⇄ живое форматирование Google Sheets",
    consentStore,
    auditId,
    g,
  });
}

registerAutoExecutor("sheets_format_range", {
  rehash: async (addressing) => {
    const a = addressing as FormatRangePayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const snapshot = await formatBindingSnapshot(g, a.items);
    return sha256({ account: a.account, items: snapshot });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as FormatRangePayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeFormatRangeCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

async function executeRawBatchCore(
  g: GoogleClients,
  payload: RawBatchPayload,
  auditId: string,
  consentStore: ConsentStore,
): Promise<CallToolResult> {
  let replies: sheets_v4.Schema$Response[] | undefined;
  let execError: string | undefined;
  try {
    const res = await withRetry(() =>
      g.sheets.spreadsheets.batchUpdate({
        spreadsheetId: payload.spreadsheetId,
        requestBody: { requests: payload.requests },
      }),
    );
    replies = res.data.replies ?? undefined;
  } catch (e: unknown) {
    execError = String(e instanceof Error ? e.message : e);
  }
  // Single call, single spreadsheetId per invocation — fetched once here,
  // alongside the post-verify read, rather than again downstream.
  const [verify, spreadsheetTitle] = await Promise.all([
    postVerifyRawBatchApplied(g, payload.spreadsheetId),
    liveSpreadsheetTitle(g, payload.spreadsheetId),
  ]);
  const icon = execError ? "❌" : "⚠️"; // always ⚠️ on success — honest limit, see postVerifyRawBatchApplied
  const summary = execError
    ? `❌ Ошибка batchUpdate: ${safeText(execError, 200)}`
    : `${icon} Применено низкоуровневых запросов к таблице: ${payload.requests.length}`;
  if (consentStore && auditId) {
    await consentStore
      .updateConsentAuditOutcome(auditId, {
        outcome: execError ? "failed" : "confirmed",
        postVerify: `${summary} · ${verify.line}`,
        error: execError ?? null,
      })
      .catch((e) => console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e)));
  }
  return ok({
    summary,
    spreadsheetId: payload.spreadsheetId,
    spreadsheetTitle,
    replies,
    verification: renderVerifyReport("Независимая проверка raw batchUpdate", "запрошено ⇄ доступность таблицы (содержимое не проверяется — честный предел)", [verify]),
  });
}

registerAutoExecutor("sheets_raw_batch_update", {
  rehash: async (addressing) => {
    const a = addressing as RawBatchPayload;
    const clients = getAutoExecuteClients();
    if (!clients) throw new Error("auto-execute: клиенты ещё не готовы");
    const g = clients.resolve(a.account);
    const title = await liveSpreadsheetTitle(g, a.spreadsheetId);
    return sha256({ spreadsheetId: a.spreadsheetId, title, requests: a.requests });
  },
  execute: async (payload, auditId, ctx: AutoExecutorCtx) => {
    const p = payload as RawBatchPayload;
    const g = ctx.clients.resolve(p.account);
    const result = await executeRawBatchCore(g, p, auditId, ctx.consentStore);
    return renderAutoExecuteReport(result);
  },
});

export function registerSheetsTools(server: McpServer, clients: UserClients, ctx: SheetsConsentContext = DEFAULT_CONSENT_CTX) {
  const account = accountField(clients);

  // ── sheets_list ────────────────────────────────────────────────────────────
  server.registerTool(
    "sheets_list",
    {
      title: "List spreadsheets",
      description:
        "List Google Spreadsheets the account can access. Optionally filter by a name substring.",
      inputSchema: {
        account,
        nameContains: z
          .string()
          .optional()
          .describe("Only return spreadsheets whose name contains this text."),
        maxResults: z.number().int().min(1).max(200).default(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, nameContains, maxResults }) => {
      const g = clients.resolve(account);
      const qParts = [
        "mimeType='application/vnd.google-apps.spreadsheet'",
        "trashed=false",
      ];
      if (nameContains) {
        qParts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
      }
      const res = await g.drive.files.list({
        q: qParts.join(" and "),
        pageSize: maxResults ?? 50,
        fields: "files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
      });
      const files = res.data.files ?? [];
      return ok({
        summary: `${files.length} spreadsheet(s)${nameContains ? ` matching "${nameContains}"` : ""} on account "${account ?? "default"}"`,
        files,
      });
    }),
  );

  // ── sheets_get_info ────────────────────────────────────────────────────────
  server.registerTool(
    "sheets_get_info",
    {
      title: "Get spreadsheet info",
      description:
        "Get title and sheet/tab list for one or more spreadsheets. Returns per-item results; errors are captured per item.",
      inputSchema: {
        account,
        spreadsheetIds: z.array(z.string()).min(1).describe("One or more spreadsheet IDs."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, spreadsheetIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        spreadsheetIds.map(async (spreadsheetId) => {
          try {
            const res = await g.sheets.spreadsheets.get({
              spreadsheetId,
              fields:
                "spreadsheetId,properties.title,spreadsheetUrl,sheets(properties(sheetId,title,index,gridProperties))",
            });
            return {
              spreadsheetId: res.data.spreadsheetId ?? spreadsheetId,
              title: res.data.properties?.title,
              spreadsheetUrl: res.data.spreadsheetUrl,
              sheets: res.data.sheets,
            };
          } catch (e: unknown) {
            return { spreadsheetId, error: String(e instanceof Error ? e.message : e) };
          }
        }),
      );
      const ok_count = results.filter((r) => !("error" in r)).length;
      return ok({
        summary: `Got info for ${ok_count}/${spreadsheetIds.length} spreadsheet(s)`,
        results,
      });
    }),
  );

  // ── sheets_read_range ──────────────────────────────────────────────────────
  server.registerTool(
    "sheets_read_range",
    {
      title: "Read range",
      description:
        "Read cell values from one or more A1 ranges. Runs in parallel. Returns per-item results.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D20' or 'Sheet1'."),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        items.map(async ({ spreadsheetId, range }) => {
          try {
            const res = await g.sheets.spreadsheets.values.get({ spreadsheetId, range });
            const values = res.data.values ?? [];
            const cols = values.reduce((n, row) => Math.max(n, row.length), 0);
            return {
              spreadsheetId,
              range: res.data.range ?? range,
              values,
              summary: `${values.length} row(s), ${cols} col(s)`,
            };
          } catch (e: unknown) {
            return { spreadsheetId, range, error: String(e instanceof Error ? e.message : e) };
          }
        }),
      );
      const ok_count = results.filter((r) => !("error" in r)).length;
      return ok({
        summary: `Read ${ok_count}/${items.length} range(s)`,
        results,
      });
    }),
  );

  // ── sheets_write_range ─────────────────────────────────────────────────────
  // Absorbs the old sheets_batch_write: pass multiple items with the same spreadsheetId
  // to write several ranges. Items targeting the same spreadsheet are written
  // via batchUpdate in one call; different spreadsheets are written sequentially
  // (to avoid conflicts within a spreadsheet while allowing parallelism across them).
  // `WriteRangeItem`/`WriteRangePayload`/`writeRangeBindingSnapshot` now live at
  // module level (see the "Payload shapes" / "Binding-snapshot helpers"
  // sections above `registerSheetsTools`) — the module-level auto-executor
  // registered further down needs them too, and a function-local declaration
  // wouldn't be visible there.

  server.registerTool(
    "sheets_write_range",
    {
      title: "Write range(s)",
      description:
        "Overwrite cell values in one or more A1 ranges. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — NOTHING is written yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually write — the approved batch is read back from the plan, not from whatever " +
        "`items` the second call carries. " +
        "`valueInputOption` USER_ENTERED parses formulas/numbers like the UI; RAW stores text verbatim.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("A1 notation of the top-left target, e.g. 'Sheet1!A1'."),
              values: valuesField,
              valueInputOption: valueInputOptionField,
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Запись недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести запись через гейт подтверждения и поэтому не пишет — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<WriteRangePayload>({
        tool: "sheets_write_range",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план записи.");
          }
          const snapshot = await writeRangeBindingSnapshot(g, items);
          const payload: WriteRangePayload = { account: accountName, items };
          const lines = items.map((it, i) => {
            const pre = snapshot[i].preValues;
            const rows = it.values.length;
            const cols = it.values.reduce((n, row) => Math.max(n, row.length), 0);
            const preview = it.values
              .slice(0, 3)
              .map((row) => row.slice(0, 5).map((v) => safeText(String(v ?? ""), 30)).join(" | "))
              .join(" / ");
            return (
              `- **«${safeText(it.spreadsheetId, 60)}»** ${safeText(it.range, 60)}: ${rows}×${cols} — ` +
              `${safeText(preview, 200) || "(пусто)"}${it.values.length > 3 ? "…" : ""}` +
              (pre.length ? ` _(сейчас в диапазоне ${pre.length} строк(и) — будут перезаписаны)_` : " _(диапазон сейчас пуст)_")
            );
          });
          const preview = `### 📤 План: Запись в диапазон(ы) — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({
            account: accountName,
            items: snapshot.map((s) => ({ spreadsheetId: s.spreadsheetId, range: s.range, preValues: s.preValues })),
          });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as WriteRangePayload;
          const snapshot = await writeRangeBindingSnapshot(g, a.items);
          return sha256({
            account: a.account,
            items: snapshot.map((s) => ({ spreadsheetId: s.spreadsheetId, range: s.range, preValues: s.preValues })),
          });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeWriteRangeCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_append_rows ─────────────────────────────────────────────────────
  // DEBATABLE (flagged per Maksim's "gate ALL write tools, no exceptions"
  // decision — see the port report): this is additive-only (Sheets always
  // appends past the end of existing data; it can't overwrite anything), so
  // the risk profile is much closer to a read than to write_range/clear_range.
  // Gated anyway per the standing rule; binding is weak-but-real (re-reads
  // the spreadsheet's live title, catching rename/delete between plan and
  // execute) rather than content-based, since "the end of the data" isn't a
  // stable thing to bind against.
  // `AppendRowsItem`/`AppendRowsPayload`/`appendBindingSnapshot` now live at
  // module level (see above `registerSheetsTools`) — needed by the
  // module-level auto-executor registered further down.

  server.registerTool(
    "sheets_append_rows",
    {
      title: "Append rows",
      description:
        "Append rows to the end of data in one or more sheets. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — nothing is appended yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually append.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("Sheet/table to append to, e.g. 'Sheet1'."),
              values: valuesField,
              valueInputOption: valueInputOptionField,
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Добавление строк недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<AppendRowsPayload>({
        tool: "sheets_append_rows",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план добавления строк.");
          }
          const snapshot = await appendBindingSnapshot(g, items);
          const payload: AppendRowsPayload = { account: accountName, items };
          const lines = items.map((it, i) => {
            const preview = it.values
              .slice(0, 3)
              .map((row) => row.slice(0, 5).map((v) => safeText(String(v ?? ""), 30)).join(" | "))
              .join(" / ");
            return `- **«${safeText(snapshot[i].title ?? it.spreadsheetId, 60)}»** ${safeText(it.range, 60)}: +${it.values.length} row(s) — ${safeText(preview, 200) || "(пусто)"}`;
          });
          const preview = `### 📤 План: Добавление строк — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items: snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as AppendRowsPayload;
          const snapshot = await appendBindingSnapshot(g, a.items);
          return sha256({ account: a.account, items: snapshot });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeAppendRowsCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_clear_range ─────────────────────────────────────────────────────
  // `ClearRangeItem`/`ClearRangePayload`/`clearBindingSnapshot` now live at
  // module level (see above `registerSheetsTools`).

  server.registerTool(
    "sheets_clear_range",
    {
      title: "Clear range",
      description:
        "Clear values from one or more A1 ranges (keeps formatting; irreversible once confirmed — the cleared " +
        "content is only recoverable from the server's pre-mutation snapshot in the audit log, not undoable via " +
        "this tool). Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT " +
        "`manifest_id`/`user_reply` (with `items`) to build a plan and return a preview of what would be erased " +
        "— nothing is cleared yet. Show the preview to the user verbatim and wait for their reply. Call again " +
        "with the returned `manifest_id` and the user's VERBATIM `user_reply` to actually clear.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D20'."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Очистка недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<ClearRangePayload>({
        tool: "sheets_clear_range",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план очистки.");
          }
          const snapshot = await clearBindingSnapshot(g, items);
          const payload: ClearRangePayload = { account: accountName, items };
          const lines = snapshot.map((s) => {
            const rowN = s.preValues.length;
            const preview = s.preValues
              .slice(0, 3)
              .map((row) => row.slice(0, 5).map((v) => safeText(String(v ?? ""), 30)).join(" | "))
              .join(" / ");
            return `- **«${safeText(s.spreadsheetId, 60)}»** ${safeText(s.range, 60)} — сотрёт ${rowN} строк(и): ${safeText(preview, 200) || "(уже пусто)"}`;
          });
          const preview = `### 📤 План: Очистка диапазона(ов) — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items: snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as ClearRangePayload;
          const snapshot = await clearBindingSnapshot(g, a.items);
          return sha256({ account: a.account, items: snapshot });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeClearRangeCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_create ──────────────────────────────────────────────────────────
  // `CreateItem`/`CreatePayload` now live at module level (see above
  // `registerSheetsTools`).

  server.registerTool(
    "sheets_create",
    {
      title: "Create spreadsheet",
      description:
        "Create one or more new spreadsheets. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with " +
        "`spreadsheets`) to build a plan and return a preview — nothing is created yet. Show the preview to the " +
        "user verbatim and wait for their reply. Call again with the returned `manifest_id` and the user's " +
        "VERBATIM `user_reply` to actually create.",
      inputSchema: {
        account,
        spreadsheets: z
          .array(
            z.object({
              title: z.string().describe("Title of the new spreadsheet."),
              sheetTitles: z
                .array(z.string())
                .optional()
                .describe("Optional list of tab names to create."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, spreadsheets, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Создание недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<CreatePayload>({
        tool: "sheets_create",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: () => {
          if (!spreadsheets || !spreadsheets.length) {
            throw new Error("Нужен непустой `spreadsheets`, чтобы построить план создания.");
          }
          const payload: CreatePayload = { account: accountName, spreadsheets };
          const lines = spreadsheets.map(
            (s) => `- **«${safeText(s.title, 120)}»**${s.sheetTitles?.length ? ` — вкладки: ${s.sheetTitles.map((t) => safeText(t, 40)).join(", ")}` : ""}`,
          );
          const preview = `### 📤 План: Создание таблиц — ${spreadsheets.length}\n\n${lines.join("\n")}`;
          // Degenerate binding (documented exception, same as gmail_send in
          // gmail-mcp/src/tools/gmail.ts): a spreadsheet that doesn't exist
          // yet has no live object to re-read against — the only protection
          // is that payload comes FROM the manifest, not the execute call's
          // arguments (see consent.ts's contract comment on `rehash`).
          return { payload, objectHash: sha256(payload), preview, batchSize: spreadsheets.length };
        },
        rehash: (addressing) => sha256(addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeCreateCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_add_tab ─────────────────────────────────────────────────────────
  // `AddTabItem`/`AddTabPayload`/`addTabBindingSnapshot` now live at module
  // level (see above `registerSheetsTools`).

  server.registerTool(
    "sheets_add_tab",
    {
      title: "Add a tab/sheet",
      description:
        "Add one or more new tabs to existing spreadsheets. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — nothing is added yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually add.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              title: z.string().describe("Name of the new tab."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Добавление вкладки недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<AddTabPayload>({
        tool: "sheets_add_tab",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план добавления вкладки.");
          }
          const snapshot = await addTabBindingSnapshot(g, items);
          const payload: AddTabPayload = { account: accountName, items };
          const lines = snapshot.map(
            (s) =>
              `- **«${safeText(s.liveTitle ?? s.spreadsheetId, 60)}»** — новая вкладка «${safeText(s.title, 60)}»` +
              (s.liveTabs.includes(s.title) ? " ⚠️ вкладка с таким именем уже есть" : ""),
          );
          const preview = `### 📤 План: Добавление вкладок — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items: snapshot.map(({ spreadsheetId, title, liveTitle, liveTabs }) => ({ spreadsheetId, title, liveTitle, liveTabs })) });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as AddTabPayload;
          const snapshot = await addTabBindingSnapshot(g, a.items);
          return sha256({ account: a.account, items: snapshot.map(({ spreadsheetId, title, liveTitle, liveTabs }) => ({ spreadsheetId, title, liveTitle, liveTabs })) });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeAddTabCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_find_replace ────────────────────────────────────────────────────
  // `FindReplacePayload` now lives at module level (see above `registerSheetsTools`).

  server.registerTool(
    "sheets_find_replace",
    {
      title: "Find & replace",
      description:
        "Find and replace text across a spreadsheet (or a single sheet if sheetId is provided). Two-mode " +
        "consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` " +
        "(with `find`/`replace`/etc.) to build a plan — this ONLY reads matching cells, it changes nothing. Show " +
        "the returned preview (listing every cell that would change) to the user verbatim and wait for their " +
        "reply. Call again with the returned `manifest_id` and the user's VERBATIM `user_reply` to actually replace.",
      inputSchema: {
        account,
        spreadsheetId: z.string().optional().describe("Required to build a plan. Ignored on the execute call."),
        find: z.string().optional().describe("Required to build a plan. Ignored on the execute call."),
        replace: z.string().optional().describe("Required to build a plan. Ignored on the execute call."),
        matchCase: z.boolean().default(false).optional(),
        sheetId: z
          .number()
          .int()
          .optional()
          .describe("Restrict to one sheet (numeric sheetId from sheets_get_info)."),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, spreadsheetId, find, replace, matchCase, sheetId, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Замена недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;
      const mc = matchCase ?? false;

      const decision = await requireConsent<FindReplacePayload>({
        tool: "sheets_find_replace",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!spreadsheetId || find === undefined || replace === undefined) {
            throw new Error("Нужны `spreadsheetId`, `find` и `replace`, чтобы построить план замены.");
          }
          const matches = await dryFindMatches(g, { spreadsheetId, find, matchCase: mc, sheetId });
          const payload: FindReplacePayload = { account: accountName, spreadsheetId, find, replace, matchCase: mc, sheetId };
          const lines = matches
            .slice(0, 30)
            .map((m) => `- ${safeText(m.sheet ?? "", 30)}!${m.cell}: «${safeText(m.value, 60)}» → «${safeText(m.value.split(find).join(replace), 60)}»`);
          const preview =
            `### 📤 План: Найти и заменить — ${matches.length} совпадение(й)\n\n` +
            `«${safeText(find, 100)}» → «${safeText(replace, 100)}»${sheetId !== undefined ? ` (лист ${sheetId})` : " (все листы)"}\n\n` +
            (lines.length ? lines.join("\n") + (matches.length > 30 ? `\n… и ещё ${matches.length - 30}` : "") : "_совпадений не найдено — заменять нечего_");
          const objectHash = sha256({
            spreadsheetId,
            find,
            replace,
            matchCase: mc,
            sheetId: sheetId ?? null,
            matches: matches.map((m) => ({ sheet: m.sheet, cell: m.cell, value: m.value })),
          });
          return { payload, objectHash, preview, batchSize: Math.max(matches.length, 1) };
        },
        rehash: async (addressing) => {
          const a = addressing as FindReplacePayload;
          const matches = await dryFindMatches(g, { spreadsheetId: a.spreadsheetId, find: a.find, matchCase: a.matchCase, sheetId: a.sheetId });
          return sha256({
            spreadsheetId: a.spreadsheetId,
            find: a.find,
            replace: a.replace,
            matchCase: a.matchCase,
            sheetId: a.sheetId ?? null,
            matches: matches.map((m) => ({ sheet: m.sheet, cell: m.cell, value: m.value })),
          });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeFindReplaceCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_format_range ────────────────────────────────────────────────────
  // `FormatItem`/`FormatRangePayload`/`formatBindingSnapshot` now live at
  // module level (see above `registerSheetsTools`).

  server.registerTool(
    "sheets_format_range",
    {
      title: "Format a range",
      description:
        "Apply common cell formatting to one or more A1 ranges without hand-writing batchUpdate JSON: " +
        "bold/italic, font size, text & background colour (#RRGGBB), alignment, number format, text wrap. " +
        "Pass only the options you want to change. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — nothing is formatted yet. Show the preview to the user verbatim " +
        "and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually format.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:C1'. Whole sheet if only a tab name."),
              bold: z.boolean().optional(),
              italic: z.boolean().optional(),
              fontSize: z.number().int().min(1).max(400).optional(),
              textColor: z.string().optional().describe("#RRGGBB"),
              backgroundColor: z.string().optional().describe("#RRGGBB"),
              horizontalAlignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
              verticalAlignment: z.enum(["TOP", "MIDDLE", "BOTTOM"]).optional(),
              wrapStrategy: z.enum(["OVERFLOW_CELL", "CLIP", "WRAP"]).optional(),
              numberFormatType: z
                .enum(["NUMBER", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "TEXT", "SCIENTIFIC"])
                .optional(),
              numberFormatPattern: z
                .string()
                .optional()
                .describe("e.g. '#,##0.00', '0.0%', 'dd.mm.yyyy', '$#,##0'."),
            }),
          )
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Форматирование недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<FormatRangePayload>({
        tool: "sheets_format_range",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план форматирования.");
          }
          const snapshot = await formatBindingSnapshot(g, items);
          const payload: FormatRangePayload = { account: accountName, items };
          const lines = items.map((it) => {
            const changes = [
              it.bold !== undefined ? `bold=${it.bold}` : null,
              it.italic !== undefined ? `italic=${it.italic}` : null,
              it.fontSize !== undefined ? `fontSize=${it.fontSize}` : null,
              it.textColor ? `textColor=${it.textColor}` : null,
              it.backgroundColor ? `backgroundColor=${it.backgroundColor}` : null,
              it.horizontalAlignment ?? null,
              it.verticalAlignment ?? null,
              it.wrapStrategy ?? null,
              it.numberFormatPattern ?? it.numberFormatType ?? null,
            ]
              .filter(Boolean)
              .join(", ");
            return `- **«${safeText(it.spreadsheetId, 60)}»** ${safeText(it.range, 60)}: ${changes || "(нет изменений)"}`;
          });
          const preview = `### 📤 План: Форматирование — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({ account: accountName, items: snapshot });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as FormatRangePayload;
          const snapshot = await formatBindingSnapshot(g, a.items);
          return sha256({ account: a.account, items: snapshot });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeFormatRangeCore(g, payload, auditId, consentStore);
    }),
  );

  // ── sheets_raw_batch_update ────────────────────────────────────────────────
  // Most dangerous write tool in this file (arbitrary Sheets API requests) —
  // explicit P1 in the port plan. Binding is necessarily weaker than the
  // content-based tools above: `requests` is an opaque bag of API operations
  // (merges, conditional formatting, sheet deletes, protected ranges…) with
  // no generic "current state" to diff against. What CAN be bound for real is
  // the spreadsheet's own identity (title) — re-read live at both plan and
  // execute time — which at least catches "wrong/renamed/deleted spreadsheet"
  // drift; `requests` itself rides along from the manifest unmodified (same
  // as gmail_send's message body: protected by "payload comes from the
  // manifest, not the execute call's arguments", not by content-diffing).
  // Post-verify is honestly ALWAYS ⚠️ (STANDARD §15.1 Q20: an operation where
  // generic post-verify is technically impossible must be named up front) —
  // see postVerifyRawBatchApplied above and GUIDE.md.
  // `RawBatchPayload` now lives at module level (see above `registerSheetsTools`).

  server.registerTool(
    "sheets_raw_batch_update",
    {
      title: "Raw batchUpdate (advanced)",
      description:
        "Send raw Sheets API batchUpdate `requests` (formatting, merges, conditional formatting, etc.). Use only " +
        "when other tools are not enough. See the Sheets API Request schema. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with " +
        "`spreadsheetId`/`requests`) to build a plan and return a preview — nothing is applied yet. Show the " +
        "preview to the user verbatim and wait for their reply. Call again with the returned `manifest_id` and " +
        "the user's VERBATIM `user_reply` to actually apply. Post-verify for this tool is always ⚠️ — arbitrary " +
        "requests have no generically checkable target state (honest limit, see GUIDE.md).",
      inputSchema: {
        account,
        spreadsheetId: z.string().optional().describe("Required to build a plan. Ignored on the execute call."),
        requests: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe(
            "Array of Sheets API Request objects. Required to build a plan (first call, no manifest_id/user_reply). " +
              "Ignored on the execute call — the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
        automation_key: z.string().optional().describe(AUTOMATION_KEY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, spreadsheetId, requests, manifest_id, user_reply, automation_key }) => {
      const { consentStore, consentCfg, tg, checkAutomationKey } = ctx;
      if (!consentStore) {
        return fail(
          "Raw batchUpdate недоступен: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<RawBatchPayload>({
        tool: "sheets_raw_batch_update",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        automationKey: automation_key,
        checkAutomationKey,
        plan: async () => {
          if (!spreadsheetId || !requests || !requests.length) {
            throw new Error("Нужны `spreadsheetId` и непустой `requests`, чтобы построить план.");
          }
          const title = await liveSpreadsheetTitle(g, spreadsheetId);
          const payload: RawBatchPayload = { account: accountName, spreadsheetId, requests: requests as object[] };
          const kinds = (requests as object[]).map((r) => Object.keys(r)[0] ?? "?").join(", ");
          const preview =
            `### 📤 План: Raw batchUpdate — ${requests.length} request(s)\n\n` +
            `- **«${safeText(title ?? spreadsheetId, 80)}»** — типы запросов: ${safeText(kinds, 200)}\n` +
            `- ⚠️ произвольный batchUpdate — сервер не может обобщённо показать точное содержимое изменений, только их тип и число`;
          const objectHash = sha256({ spreadsheetId, title, requests: payload.requests });
          return { payload, objectHash, preview, batchSize: requests.length };
        },
        rehash: async (addressing) => {
          const a = addressing as RawBatchPayload;
          const title = await liveSpreadsheetTitle(g, a.spreadsheetId);
          return sha256({ spreadsheetId: a.spreadsheetId, title, requests: a.requests });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      return executeRawBatchCore(g, payload, auditId, consentStore);
    }),
  );

  // ── Read formatting ────────────────────────────────────────────────────────

  server.registerTool(
    "sheets_get_formatting",
    {
      title: "Get cell formatting",
      description:
        "Read cell formatting (fill colour, font, borders, number format, alignment, text style) " +
        "for one or more ranges. Returns a human-readable summary per cell plus the raw " +
        "userEnteredFormat object for precise values.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:C3'."),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);

      const results = await Promise.all(
        items.map(async ({ spreadsheetId, range }) => {
          try {
            const res = await g.sheets.spreadsheets.get({
              spreadsheetId,
              ranges: [range],
              includeGridData: true,
              fields:
                "sheets(data(rowData(values(userEnteredFormat,userEnteredValue,effectiveFormat)),startRow,startColumn))",
            });

            const rows: object[] = [];
            for (const sheet of res.data.sheets ?? []) {
              for (const gridData of sheet.data ?? []) {
                const startRow = gridData.startRow ?? 0;
                const startCol = gridData.startColumn ?? 0;
                for (const [ri, rowData] of (gridData.rowData ?? []).entries()) {
                  for (const [ci, cell] of (rowData.values ?? []).entries()) {
                    const colLetter = colIndexToLetters(startCol + ci);
                    const cellAddr = `${colLetter}${startRow + ri + 1}`;
                    rows.push({
                      cell: cellAddr,
                      value: cell.userEnteredValue ?? null,
                      formatting: summariseFormat(cell.userEnteredFormat),
                      effectiveFormatting: summariseFormat(cell.effectiveFormat),
                    });
                  }
                }
              }
            }

            return { spreadsheetId, range, cells: rows };
          } catch (e: unknown) {
            return { spreadsheetId, range, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );

      return ok({
        summary: `🎨 Formatting for ${items.length} range(s)`,
        results,
      });
    }),
  );

  // ── sheets_find ────────────────────────────────────────────────────────────
  server.registerTool(
    "sheets_find",
    {
      title: "Find cells (no replace)",
      description:
        "Search for text across a spreadsheet WITHOUT changing anything — a read-only alternative " +
        "to sheets_find_replace for locating text and inspecting it. Returns every matching cell " +
        "with its sheet/tab, A1 address, 1-based row, column letter + 1-based index, the cell value, " +
        "and (optionally) its formatting. Supports case-sensitive, whole-cell, and regex matching, " +
        "and can be scoped to a single tab or A1 range.",
      inputSchema: {
        account,
        spreadsheetId: z.string(),
        query: z.string().describe("Text to look for."),
        matchCase: z.boolean().default(false).optional().describe("Case-sensitive match."),
        matchEntireCell: z
          .boolean()
          .default(false)
          .optional()
          .describe("Match only cells whose entire value equals the query (like the Sheets UI 'Match entire cell contents'). Ignored when regex=true."),
        regex: z
          .boolean()
          .default(false)
          .optional()
          .describe("Treat query as a JavaScript regular expression. Overrides matchEntireCell."),
        sheetTitle: z.string().optional().describe("Restrict the search to one tab by name."),
        range: z
          .string()
          .optional()
          .describe("Restrict to an A1 range, e.g. 'Sheet1!A1:D100'. Overrides sheetTitle."),
        includeFormatting: z
          .boolean()
          .default(false)
          .optional()
          .describe("Include each matching cell's formatting (fill, font, number format, borders, etc.)."),
        maxResults: z.number().int().min(1).max(1000).default(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, spreadsheetId, query, matchCase, matchEntireCell, regex, sheetTitle, range, includeFormatting, maxResults }) => {
      const g = clients.resolve(account);
      const cap = maxResults ?? 200;

      // Build the matcher.
      let re: RegExp | null = null;
      if (regex) re = new RegExp(query, matchCase ? "" : "i");
      const needle = matchCase ? query : query.toLowerCase();
      const isMatch = (value: string): boolean => {
        if (re) return re.test(value);
        const hay = matchCase ? value : value.toLowerCase();
        return matchEntireCell ? hay === needle : hay.includes(needle);
      };

      const ranges = range ? [range] : sheetTitle ? [sheetTitle] : undefined;
      const fmtFields = includeFormatting ? ",userEnteredFormat,effectiveFormat" : "";
      const res = await g.sheets.spreadsheets.get({
        spreadsheetId,
        ranges,
        includeGridData: true,
        fields: `spreadsheetUrl,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,effectiveValue,userEnteredValue${fmtFields}))))`,
      });

      const found: Record<string, unknown>[] = [];
      let truncated = false;
      outer: for (const sheet of res.data.sheets ?? []) {
        const tab = sheet.properties?.title ?? null;
        const sheetId = sheet.properties?.sheetId ?? null;
        for (const gd of sheet.data ?? []) {
          const startRow = gd.startRow ?? 0;
          const startCol = gd.startColumn ?? 0;
          for (const [ri, rowData] of (gd.rowData ?? []).entries()) {
            for (const [ci, cell] of (rowData.values ?? []).entries()) {
              const value = cellText(cell);
              if (value === null || value === "") continue;
              if (!isMatch(value)) continue;
              const rowNum = startRow + ri + 1;
              const colIdx = startCol + ci;
              const colLetter = colIndexToLetters(colIdx);
              const entry: Record<string, unknown> = {
                sheet: tab,
                sheetId,
                cell: `${colLetter}${rowNum}`,
                row: rowNum,
                column: colLetter,
                columnIndex: colIdx + 1,
                value,
              };
              if (includeFormatting) {
                entry.formatting = summariseFormat(cell.userEnteredFormat);
                entry.effectiveFormatting = summariseFormat(cell.effectiveFormat);
              }
              found.push(entry);
              if (found.length >= cap) {
                truncated = true;
                break outer;
              }
            }
          }
        }
      }

      const scope = range ? ` in ${range}` : sheetTitle ? ` in tab "${sheetTitle}"` : "";
      return ok({
        summary: `Found ${found.length}${truncated ? "+ (capped)" : ""} match(es) for "${query}"${scope}`,
        spreadsheetUrl: res.data.spreadsheetUrl,
        truncated,
        matches: found,
      });
    }),
  );

  // ── sheets_consent_audit ───────────────────────────────────────────────────
  // "Разбор инцидента без ssh" (limits-audit.md §11) — ported from gmail-mcp's
  // gmail_consent_audit. Read-only path over the same consent_audit table the
  // gate writes to; answers "what did the consent gate actually decide" and
  // "did it block anything today" without reading server logs.

  server.registerTool(
    "sheets_consent_audit",
    {
      title: "Read the consent-gate audit log",
      description:
        "Read-only log of every decision the consent gate has made for the gated sheets_* write tools " +
        "(sheets_write_range/clear_range/append_rows/create/add_tab/find_replace/format_range/raw_batch_update) " +
        "and triage_log_add/triage_log_update: plan built, confirmed, refused, or invalidated, plus — once the " +
        "mutation actually ran — its outcome and post-verify result. This is how to answer \"what actually " +
        "happened to that range\" or \"did the gate block anything today\" without reading server logs. " +
        "Filter by `since`/`until` (ISO 8601), `account`, `tool`, or `outcome` " +
        "(confirmed/refused/invalidated/failed — a manifest that's only been planned and never answered has no " +
        "audit row yet, nothing to show). Results are newest first, capped at 100 per page " +
        "(default 20); use `offset` to page through older rows. External text (the verbatim user_reply and the " +
        "outbound pre-snapshot) is shown neutralised, never as live markdown.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe("Filter to one account label. Omit to show all accounts, not just the default."),
        since: z.string().optional().describe("ISO 8601 datetime — only rows at or after this time."),
        until: z.string().optional().describe("ISO 8601 datetime — only rows at or before this time."),
        tool: z
          .string()
          .optional()
          .describe("Filter to one tool name, e.g. 'sheets_write_range'. Omit to show every gated tool."),
        outcome: z
          .enum(["confirmed", "refused", "invalidated", "failed"])
          .optional()
          .describe("Filter to one outcome. Omit to show all."),
        limit: z.number().int().min(1).max(100).default(20).optional().describe("Max rows to return (1-100, default 20)."),
        offset: z.number().int().min(0).default(0).optional().describe("Skip this many newest-first rows — for paging past the first `limit`."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, since, until, tool, outcome, limit, offset }) => {
      const { auditStore, consentCfg } = ctx;
      if (!auditStore) {
        return ok({
          summary: "Audit log unavailable — DATABASE_URL is not configured, so nothing has been recorded.",
          results: [],
        });
      }
      const parseWhen = (label: string, s?: string): number | undefined => {
        if (!s) return undefined;
        const t = Date.parse(s);
        if (Number.isNaN(t)) throw new Error(`Cannot parse ${label}="${s}". Use ISO 8601, e.g. 2026-08-04T00:00:00-07:00.`);
        return t;
      };
      const filters = {
        server: consentCfg.server,
        since: parseWhen("since", since),
        until: parseWhen("until", until),
        accountLabel: account?.trim() || undefined,
        tool: tool?.trim() || undefined,
        outcome,
      };
      const cap = limit ?? 20;
      const off = offset ?? 0;
      const [rows, total] = await Promise.all([
        auditStore.listConsentAudit(filters, cap, off),
        auditStore.countConsentAudit(filters),
      ]);

      const outcomeIcon = (o: string): string =>
        o === "confirmed" ? "✅" : o === "failed" ? "❌" : o === "refused" || o === "invalidated" ? "🛑" : "•";

      const header = "| Время (PT) | Инструмент | Аккаунт | Actor | Исход | user_reply | post-verify | Детали |";
      const sep = "|---|---|---|---|---|---|---|---|";
      const lines = rows.map((r) => {
        const details = r.error
          ? `ошибка: ${safeText(r.error, 80)}`
          : r.preSnapshot
            ? `снимок: ${safeText(JSON.stringify(r.preSnapshot), 100)}`
            : "—";
        return (
          `| ${formatLaTime(r.ts)} | ${r.tool} | ${r.accountLabel} | ${r.actor} | ` +
          `${outcomeIcon(r.outcome)} ${r.outcome} | ${safeText(r.userReply, 60) || "—"} | ` +
          `${safeText(r.postVerifyResult ?? "", 60) || "—"} | ${details} |`
        );
      });

      const shownNote =
        total > off + rows.length
          ? `Показано ${rows.length} из ${total} (записи ${off + 1}–${off + rows.length}); ` +
            `есть ещё — вызовите снова с offset=${off + rows.length}.`
          : `Показано ${rows.length} из ${total}.`;

      const body = rows.length ? [header, sep, ...lines].join("\n") : "Нет записей, подходящих под фильтры.";

      return ok(`### 🧾 Журнал согласий\n\n${shownNote}\n\n${body}`);
    }),
  );
}
