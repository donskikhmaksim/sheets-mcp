/**
 * Triage log tools — hardcoded to a single Google Spreadsheet.
 *
 * Sheet structure (tab "Triage Log"):
 *   A: ID  B: Date  C: Account  D: From  E: Subject
 *   F: Claude Suggested  G: Maksim Said  H: Why Not Closed  I: Status
 *
 * The spreadsheetId is a constant — these tools physically cannot write to any
 * other spreadsheet, making them safe to mark as always_allow.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, guard } from "../util.js";
import type { UserClients } from "../accounts.js";

const SPREADSHEET_ID = "1o40fK-fF5Yh-y-iIGbYdvj8hiCKWzJ1yuJcBCA3NlYk";
const SHEET_NAME = "Triage Log";
const RANGE = `${SHEET_NAME}!A:I`;
const HEADER = ["ID", "Date", "Account", "From", "Subject", "Claude Suggested", "Maksim Said", "Why Not Closed", "Status"];

async function ensureHeader(g: ReturnType<UserClients["resolve"]>): Promise<void> {
  try {
    const r = await g.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:I1` });
    if (!r.data.values?.length) {
      await g.sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:I1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
    }
  } catch { /* tab may not exist yet — first append will surface the error */ }
}

async function readAllRows(g: ReturnType<UserClients["resolve"]>): Promise<string[][]> {
  const res = await g.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: RANGE });
  return res.data.values ?? [];
}

export function registerTriageTools(server: McpServer, userClients: UserClients) {
  // Use whatever account this instance actually has (the onboarded default),
  // not a hardcoded name — a stale label like "personal" no longer exists and
  // broke logging with "Unknown account". This value is both resolved to a
  // Google client and written into the sheet's "Account" column.
  const ACCOUNT = userClients.defaultName;

  // ── triage_log_add ─────────────────────────────────────────────────────────
  server.registerTool(
    "triage_log_add",
    {
      title: "Add triage log entry",
      description:
        "Append one or more rows to the Email Triage Log spreadsheet. " +
        "ID and Date are set automatically. always_allow — no confirmation needed.",
      inputSchema: {
        rows: z.array(z.object({
          from:            z.string().describe("Email sender."),
          subject:         z.string().describe("Email subject."),
          claudeSuggested: z.string().describe("What Claude suggested (archive / reply / snooze / task…)."),
          maksimSaid:      z.string().optional().describe("Maksim's response (can be filled later)."),
          whyNotClosed:    z.string().optional().describe("Why it is not resolved yet."),
          status:          z.enum(["pending", "done"]).default("pending").optional(),
        })).min(1),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ rows }) => {
      const g = userClients.resolve(ACCOUNT);
      await ensureHeader(g);

      const all = await readAllRows(g);
      const dataRows = all.slice(1); // skip header
      const lastId = dataRows.reduce((max, row) => {
        const n = parseInt(row[0] ?? "0", 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 0);

      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const newRows = rows.map((r, i) => [
        String(lastId + i + 1),
        today,
        ACCOUNT,
        r.from,
        r.subject,
        r.claudeSuggested,
        r.maksimSaid ?? "",
        r.whyNotClosed ?? "",
        r.status ?? "pending",
      ]);

      await g.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: RANGE,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: newRows },
      });

      const addedIds = newRows.map(r => Number(r[0]));
      return ok({
        summary: `📋 Added ${newRows.length} row(s) to Triage Log (IDs: ${addedIds.join(", ")})`,
        addedIds,
        date: today,
      });
    }),
  );

  // ── triage_log_update ──────────────────────────────────────────────────────
  server.registerTool(
    "triage_log_update",
    {
      title: "Update triage log entry",
      description:
        "Update an existing Triage Log row by its ID (column A). " +
        "Finds by ID value — stable even if rows are reordered. always_allow.",
      inputSchema: {
        id:           z.number().int().min(1).describe("Row ID from column A."),
        status:       z.enum(["pending", "done"]).optional(),
        maksimSaid:   z.string().optional(),
        whyNotClosed: z.string().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async ({ id, status, maksimSaid, whyNotClosed }) => {
      if (status === undefined && maksimSaid === undefined && whyNotClosed === undefined) {
        return fail("Specify at least one field to update.");
      }

      const g = userClients.resolve(ACCOUNT);
      const all = await readAllRows(g);

      // Find row index (0-based in array, but sheet row = index + 1 because of header at row 1)
      const idx = all.findIndex((row, i) => i > 0 && String(row[0]).trim() === String(id));
      if (idx === -1) return fail(`Triage log entry with ID ${id} not found.`);

      const sheetRow = idx + 1; // 1-based sheet row
      const data: { range: string; values: string[][] }[] = [];
      if (maksimSaid !== undefined)   data.push({ range: `${SHEET_NAME}!G${sheetRow}`, values: [[maksimSaid]] });
      if (whyNotClosed !== undefined) data.push({ range: `${SHEET_NAME}!H${sheetRow}`, values: [[whyNotClosed]] });
      if (status !== undefined)       data.push({ range: `${SHEET_NAME}!I${sheetRow}`, values: [[status]] });

      await g.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: "RAW", data },
      });

      return ok({
        summary: `✏️ Updated Triage Log #${id}${status ? ` → ${status}` : ""}`,
        id,
        sheetRow,
        updated: {
          ...(status !== undefined && { status }),
          ...(maksimSaid !== undefined && { maksimSaid }),
          ...(whyNotClosed !== undefined && { whyNotClosed }),
        },
      });
    }),
  );

  // ── triage_log_get_pending ─────────────────────────────────────────────────
  server.registerTool(
    "triage_log_get_pending",
    {
      title: "Get pending triage entries",
      description:
        "Return all rows from the Triage Log where Status = pending. " +
        "Call at the start of each email session to surface unresolved threads. always_allow.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const g = userClients.resolve(ACCOUNT);
      const all = await readAllRows(g);

      if (all.length <= 1) {
        return ok({ summary: "📋 Triage log is empty — no pending items.", pending: [] });
      }

      const pending = all.slice(1)
        .filter(row => (row[8] ?? "").trim().toLowerCase() === "pending")
        .map(row => ({
          id:              Number(row[0]) || null,
          date:            row[1] ?? "",
          account:         row[2] ?? "",
          from:            row[3] ?? "",
          subject:         row[4] ?? "",
          claudeSuggested: row[5] ?? "",
          maksimSaid:      row[6] ?? "",
          whyNotClosed:    row[7] ?? "",
        }));

      return ok({
        summary: pending.length
          ? `📋 ${pending.length} pending item(s) in Triage Log`
          : "📋 No pending items — all clear.",
        pending,
      });
    }),
  );
}
