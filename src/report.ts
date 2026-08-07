/**
 * report.ts — renders a gated write tool's structured mutation result
 * (`{summary, results?, verification?, ...}` — see `util.ts`'s `ok()`) as
 * human-readable markdown for the Telegram auto-execute report
 * (`autoExecute.ts`'s `ExecuteFn`, `tg_approval.ts`'s
 * `reportAutoExecutionResult`).
 *
 * WHY THIS EXISTS (bug found live on drive-mcp, 2026-08-06, task #131 —
 * identical byte-for-byte code across all 5 Google MCP servers means the same
 * bug existed here too): pressing "✅ Подтвердить" in Telegram auto-executes
 * the manifest with NO model in the loop (autoExecute.ts's file-top comment —
 * the poller calls `executor.execute()` directly, `http.ts`'s
 * `runAutoExecutePoller`). The old path took whatever `util.ts`'s `ok(data)`
 * put in `content[0].text` — for any object payload that's
 * `JSON.stringify(data, null, 2)` — and sent THAT straight to Telegram via
 * `reportAutoExecutionResult`. Maksim saw literal `{ "summary": "...",
 * "results": [...] }` in his phone. Worse: `results`' sibling `verification`
 * (`tools/sheets.ts`'s `renderVerifyReport`) embeds a line addressed AT A
 * MODEL, not at Maksim — `_[агенту: перепечатай этот отчёт пользователю
 * ДОСЛОВНО …]_` — meant to stop a model from paraphrasing the server's own
 * proof away. With no model reading it, that instruction string leaked into
 * the chat verbatim too.
 *
 * Fix: read `structuredContent` (the same object `ok()` now also attaches to
 * the `CallToolResult`, see `util.ts`) instead of parsing `content[0].text`
 * as JSON, render it as markdown in the same visual language as the plan
 * preview (`consent.ts`'s `renderConsentBlock` / the `### 📤 План: …` bullets
 * built in each tool's `plan()` — header line, then one bullet per object),
 * and strip any agent-directive line as a final, unconditional pass — so a
 * future `verification` string that forgets to omit one still can't reach
 * Telegram. The NORMAL (model-in-the-loop) MCP response is UNCHANGED: it
 * still gets the JSON text in `content[0].text` exactly as before — this
 * module is only ever consulted for the Telegram auto-execute report.
 *
 * GENERIC, PORTABLE module (same discipline as `tg_approval.ts`/
 * `autoExecute.ts`/`consent.ts` — see those files' top comments): meant to be
 * copied byte-for-byte to the other 4 Google MCP servers (gmail/calendar/
 * docs/drive-mcp). Knows nothing about any specific tool's payload shape.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { safeText } from "./util.js";
// `stripAgentDirectives` lives in tg_approval.ts (not here) — it's really a
// Telegram-auto-execute security boundary (the directive only ever matters
// because THAT path runs with no model in the loop), and keeping it there
// means tg_approval.ts gains no new cross-module runtime import, which several
// `scripts/*.mjs` tests depend on to load it directly via Node's native
// TypeScript support without a bundler. See that file's doc-comment for the
// full rationale.
import { stripAgentDirectives } from "./tg_approval.js";

/**
 * One bullet line for a single result-item (or for a flat `structuredContent`
 * object that has no `results[]` array of its own — `find_replace`/
 * `raw_batch_update`/`triage_log_add`/`triage_log_update` all return a flat
 * object with a few named fields instead), in the same visual language as
 * the plan preview's `- **«name»** details` bullets. Deliberately generic —
 * the object shape varies per tool (`write_range` has `range`/`updatedCells`,
 * `sheets_create` has `title`/`spreadsheetUrl`, `add_tab` has `sheetId`, …) —
 * so it picks whichever known field is present and skips the rest, rather
 * than assuming one tool's schema. All text of EXTERNAL origin (object name,
 * error message — see `mcp-development-standard/references/security-
 * checklist.md` §1) goes through `safeText` before being embedded, so a
 * spreadsheet/tab named to look like a status line can't forge one.
 */
function renderResultBullet(r: Record<string, unknown>): string | null {
  // `title` is the name of the object the mutation actually CREATED/TARGETED
  // (a new spreadsheet's title for sheets_create, a new tab's title for
  // add_tab) — it takes priority over `spreadsheetTitle` (the CONTAINER
  // spreadsheet's name, present whenever `buildMutationResult` was called
  // with `g`). Getting this backwards silently drops the one fact the bullet
  // exists to report: for add_tab, `title` = "Новая вкладка" and
  // `spreadsheetTitle` = "Мой файл" are BOTH present and DIFFERENT — showing
  // only the container's name (the old, wrong priority) made the newly
  // created tab's own name vanish from the report entirely.
  const objectTitle = typeof r.title === "string" && r.title ? r.title : undefined;
  const container = typeof r.spreadsheetTitle === "string" && r.spreadsheetTitle ? r.spreadsheetTitle : undefined;
  const idFallback = typeof r.spreadsheetId === "string" && r.spreadsheetId ? r.spreadsheetId : undefined;
  const name = objectTitle ?? container ?? idFallback;
  if (typeof r.error === "string" && r.error) {
    return `- ❌ **«${safeText(name ?? "объект", 80)}»** — ошибка: ${safeText(r.error, 200)}`;
  }
  const details: string[] = [];
  // Container shown as a detail ONLY when it's a distinct fact from the
  // headline name (i.e. `objectTitle` won the name slot above) — otherwise
  // `container` already IS `name` and repeating it would be redundant.
  if (container && container !== name) details.push(`в «${safeText(container, 60)}»`);
  if (typeof r.range === "string") details.push(r.range);
  if (typeof r.updatedRange === "string" && r.updatedRange !== r.range) details.push(r.updatedRange);
  if (typeof r.updatedCells === "number") details.push(`${r.updatedCells} ячеек`);
  if (typeof r.clearedRowCount === "number") details.push(`было заполнено строк: ${r.clearedRowCount}`);
  if (typeof r.applied === "number") details.push(`применено настроек формата: ${r.applied}`);
  if (typeof r.spreadsheetUrl === "string") details.push(r.spreadsheetUrl);
  if (!name && !details.length) return null; // ничего презентабельного — не мусорить пустым буллетом
  const tail = details.length ? ` — ${details.join(", ")}` : "";
  return `- ✅ **«${safeText(name ?? "объект", 80)}»**${tail}`;
}

/**
 * Renders a gated write tool's structured mutation result as one
 * human-readable markdown report — the same 4-block frame as
 * `mcp-development-standard/references/output-format.md` §7.1 (header → one
 * bullet per object → warnings → proof), built entirely from
 * `structuredContent` fields (never `JSON.stringify`'d), with any
 * agent-directive line removed from `verification` before it's appended.
 */
export function renderStructuredReport(sc: Record<string, unknown>): string {
  const { summary, results, verification, ...rest } = sc;
  // `### ` header, same as the plan preview's own `### 📤 План: …` (each
  // tool's `plan()` in tools/sheets.ts/triage.ts) and the proof block's own
  // `### 🧾 …` (renderVerifyReport below) — output-format.md §7.1 p.1: "the
  // header comes first, `###`, one self-contained line."
  const header = typeof summary === "string" && summary ? summary : "Готово.";
  const parts: string[] = [`### ${header}`];

  const bulletSource: Record<string, unknown>[] = Array.isArray(results) && results.length
    ? (results as Record<string, unknown>[])
    : Object.keys(rest).length
      ? [rest]
      : [];
  const bullets = bulletSource
    .map((r) => renderResultBullet(r))
    .filter((b): b is string => b !== null);
  if (bullets.length) parts.push("", bullets.join("\n"));

  if (typeof verification === "string" && verification.trim()) {
    parts.push("", stripAgentDirectives(verification));
  }
  return parts.join("\n");
}

/**
 * Extracts a human-readable Telegram report from a gated tool's execute-phase
 * `CallToolResult`. Prefers `structuredContent` (`util.ts`'s `ok()` now
 * attaches it for every object payload — see that file). Falls back to the
 * plain text content for error results (`util.ts`'s `fail()` already
 * produces a human sentence, "Error: …", never JSON) or for the defensive
 * case `structuredContent` is somehow missing. Always passes the final
 * string through `stripAgentDirectives` regardless of which path was taken —
 * this function's own output is what `autoExecute.ts`'s `ExecuteFn`
 * implementations return, and what `tg_approval.ts`'s
 * `reportAutoExecutionResult` sends to Telegram (which re-applies the same
 * strip once more itself — see that function's doc-comment).
 */
export function renderAutoExecuteReport(result: CallToolResult): string {
  const first = result.content?.[0];
  const text = first && first.type === "text" ? first.text : "";
  if (result.isError) {
    return stripAgentDirectives(text || "🛑 Ошибка при исполнении.");
  }
  const sc = result.structuredContent;
  if (sc && typeof sc === "object") {
    return stripAgentDirectives(renderStructuredReport(sc as Record<string, unknown>));
  }
  // structuredContent missing — shouldn't happen once every mutation result
  // goes through ok(), but a defensive fallback beats throwing. The raw text
  // may still be JSON in this case; sanitizing it is still worthwhile even
  // though it won't make it pretty.
  return stripAgentDirectives(text || "Готово.");
}
