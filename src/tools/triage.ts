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
import { ok, fail, guard, safeText } from "../util.js";
import type { UserClients } from "../accounts.js";
import { requireConsent, sha256, USER_REPLY_DOC } from "../consent.js";
import type { SheetsConsentContext } from "./sheets.js";

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

const DEFAULT_TRIAGE_CTX: SheetsConsentContext = {
  consentStore: null,
  consentCfg: { server: "sheets", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10 },
  auditStore: null,
};

export function registerTriageTools(server: McpServer, userClients: UserClients, ctx: SheetsConsentContext = DEFAULT_TRIAGE_CTX) {
  // Use whatever account this instance actually has (the onboarded default),
  // not a hardcoded name — a stale label like "personal" no longer exists and
  // broke logging with "Unknown account". This value is both resolved to a
  // Google client and written into the sheet's "Account" column.
  const ACCOUNT = userClients.defaultName;

  // ── triage_log_add ─────────────────────────────────────────────────────────
  // DEBATABLE (flagged per Maksim's "gate ALL write tools, no exceptions"
  // decision — see the port report): this file's own header comment argues
  // triage_log_add/update are safe to always_allow because the spreadsheetId
  // is a hardcoded constant (can't write anywhere else). That argument is
  // about BLAST RADIUS (can't hit the wrong spreadsheet), not about content —
  // a wrong `claudeSuggested`/`maksimSaid` value can still be logged
  // incorrectly. Gated anyway per the standing rule.
  interface AddRow {
    from: string;
    subject: string;
    claudeSuggested: string;
    maksimSaid?: string;
    whyNotClosed?: string;
    status?: "pending" | "done";
  }
  interface AddPayload {
    rows: AddRow[];
    lastId: number;
    today: string;
  }

  server.registerTool(
    "triage_log_add",
    {
      title: "Add triage log entry",
      description:
        "Append one or more rows to the Email Triage Log spreadsheet. ID and Date are set automatically. " +
        "Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT " +
        "`manifest_id`/`user_reply` (with `rows`) to build a plan and return a preview — nothing is added yet. " +
        "Show the preview to the user verbatim and wait for their reply. Call again with the returned " +
        "`manifest_id` and the user's VERBATIM `user_reply` to actually add.",
      inputSchema: {
        rows: z.array(z.object({
          from:            z.string().describe("Email sender."),
          subject:         z.string().describe("Email subject."),
          claudeSuggested: z.string().describe("What Claude suggested (archive / reply / snooze / task…)."),
          maksimSaid:      z.string().optional().describe("Maksim's response (can be filled later)."),
          whyNotClosed:    z.string().optional().describe("Why it is not resolved yet."),
          status:          z.enum(["pending", "done"]).default("pending").optional(),
        })).optional().describe(
          "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
            "the approved batch is read back from the manifest.",
        ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ rows, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Добавление недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = userClients.resolve(ACCOUNT);

      /** Live last-used ID (real, non-tautological binding: a concurrent
       * triage_log_add between plan and execute bumps this, tripping the
       * binding mismatch — gate.md §3.3(2)).
       *
       * READ-ONLY on purpose: `plan` (gate.md §3.1) and `rehash` (§3.3 p.2) are
       * both called on paths that must not mutate before consent — `plan` runs
       * in the plan phase itself, `rehash` runs for the binding check before the
       * one-shot consume. Header creation used to live here (`ensureHeader`),
       * which meant a `values.update` could fire during `plan()`, i.e. before
       * the user ever confirmed — a write past the gate. Header creation now
       * happens once, explicitly, only after `decision.kind === "confirmed"`
       * (see below), right before the actual `values.append`. */
      const liveLastId = async (): Promise<number> => {
        const all = await readAllRows(g);
        return all.slice(1).reduce((max, row) => {
          const n = parseInt(row[0] ?? "0", 10);
          return isNaN(n) ? max : Math.max(max, n);
        }, 0);
      };

      const decision = await requireConsent<AddPayload>({
        tool: "triage_log_add",
        accountLabel: ACCOUNT,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          if (!rows || !rows.length) {
            throw new Error("Нужен непустой `rows`, чтобы построить план добавления.");
          }
          const lastId = await liveLastId();
          const today = new Date().toISOString().slice(0, 10);
          const payload: AddPayload = { rows, lastId, today };
          const lines = rows.map(
            (r, i) => `- #${lastId + i + 1} от «${safeText(r.from, 60)}»: «${safeText(r.subject, 80)}» — ${safeText(r.claudeSuggested, 100)}`,
          );
          const preview = `### 📤 План: Добавление в Triage Log — ${rows.length}\n\n${lines.join("\n")}`;
          return { payload, objectHash: sha256({ lastId, rows }), preview, batchSize: rows.length };
        },
        rehash: async (addressing) => {
          const a = addressing as AddPayload;
          const lastId = await liveLastId();
          return sha256({ lastId, rows: a.rows });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      // Header write happens here — execute phase, strictly AFTER consent was
      // confirmed (decision.kind === "confirmed") — never during plan().
      await ensureHeader(g);
      const newRows = payload.rows.map((r, i) => [
        String(payload.lastId + i + 1),
        payload.today,
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
      // Post-verify: re-read the log and confirm every added ID is now present
      // with the expected subject (a SEPARATE fresh read, §5.1 p.1).
      const after = await readAllRows(g);
      const verified = addedIds.every((id) => after.some((row) => String(row[0]).trim() === String(id)));
      const icon = verified ? "✅" : "⚠️";
      await consentStore
        .updateConsentAuditOutcome(auditId, {
          outcome: "confirmed",
          postVerify: `${icon} added IDs ${addedIds.join(", ")}${verified ? " — confirmed in sheet" : " — could not re-verify"}`,
        })
        .catch((e) => console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e)));
      return ok({
        summary: `${icon} Added ${newRows.length} row(s) to Triage Log (IDs: ${addedIds.join(", ")})`,
        addedIds,
        date: payload.today,
      });
    }),
  );

  // ── triage_log_update ──────────────────────────────────────────────────────
  interface UpdatePayload {
    id: number;
    status?: "pending" | "done";
    maksimSaid?: string;
    whyNotClosed?: string;
  }

  /** Live snapshot of the target row's identity + current values — real
   * binding (a concurrent edit/reorder between plan and execute changes this
   * and trips the mismatch), and doubles as the pre-snapshot for the audit log. */
  async function liveRowSnapshot(g: ReturnType<UserClients["resolve"]>, id: number) {
    const all = await readAllRows(g);
    const idx = all.findIndex((row, i) => i > 0 && String(row[0]).trim() === String(id));
    if (idx === -1) return null;
    const row = all[idx];
    return { sheetRow: idx + 1, from: row[3] ?? "", subject: row[4] ?? "", maksimSaid: row[6] ?? "", whyNotClosed: row[7] ?? "", status: row[8] ?? "" };
  }

  server.registerTool(
    "triage_log_update",
    {
      title: "Update triage log entry",
      description:
        "Update an existing Triage Log row by its ID (column A). Finds by ID value — stable even if rows are " +
        "reordered. Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT " +
        "`manifest_id`/`user_reply` to build a plan — nothing is changed yet. Show the preview to the user " +
        "verbatim and wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM " +
        "`user_reply` to actually update.",
      inputSchema: {
        id:           z.number().int().min(1).describe("Row ID from column A."),
        status:       z.enum(["pending", "done"]).optional(),
        maksimSaid:   z.string().optional(),
        whyNotClosed: z.string().optional(),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async ({ id, status, maksimSaid, whyNotClosed, manifest_id, user_reply }) => {
      const { consentStore, consentCfg, tg } = ctx;
      if (!consentStore) {
        return fail(
          "Обновление недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      if (status === undefined && maksimSaid === undefined && whyNotClosed === undefined && !manifest_id) {
        return fail("Specify at least one field to update.");
      }
      const g = userClients.resolve(ACCOUNT);

      const decision = await requireConsent<UpdatePayload>({
        tool: "triage_log_update",
        accountLabel: ACCOUNT,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        tg,
        plan: async () => {
          const snap = await liveRowSnapshot(g, id);
          if (!snap) throw new Error(`Triage log entry with ID ${id} not found.`);
          const payload: UpdatePayload = { id, status, maksimSaid, whyNotClosed };
          const changes = [
            status !== undefined ? `статус: «${snap.status}» → «${status}»` : null,
            maksimSaid !== undefined ? `Maksim said: «${safeText(snap.maksimSaid, 60)}» → «${safeText(maksimSaid, 60)}»` : null,
            whyNotClosed !== undefined ? `why not closed: «${safeText(snap.whyNotClosed, 60)}» → «${safeText(whyNotClosed, 60)}»` : null,
          ].filter(Boolean).join("; ");
          const preview = `### 📤 План: Обновление Triage Log #${id}\n\n- **«${safeText(snap.subject, 80)}»** от «${safeText(snap.from, 60)}»: ${changes}`;
          const objectHash = sha256({ id, snap });
          return { payload, objectHash, preview, batchSize: 1 };
        },
        rehash: async (addressing) => {
          const a = addressing as UpdatePayload;
          const snap = await liveRowSnapshot(g, a.id);
          return sha256({ id: a.id, snap });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      const snap = await liveRowSnapshot(g, payload.id);
      if (!snap) return fail(`Triage log entry with ID ${payload.id} not found (изменилось между планом и исполнением).`);

      const data: { range: string; values: string[][] }[] = [];
      if (payload.maksimSaid !== undefined)   data.push({ range: `${SHEET_NAME}!G${snap.sheetRow}`, values: [[payload.maksimSaid]] });
      if (payload.whyNotClosed !== undefined) data.push({ range: `${SHEET_NAME}!H${snap.sheetRow}`, values: [[payload.whyNotClosed]] });
      if (payload.status !== undefined)       data.push({ range: `${SHEET_NAME}!I${snap.sheetRow}`, values: [[payload.status]] });

      await g.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: "RAW", data },
      });

      // Post-verify: SEPARATE fresh read confirming the new values landed.
      const after = await liveRowSnapshot(g, payload.id);
      const mismatches = [
        payload.status !== undefined && after?.status !== payload.status ? "status" : null,
        payload.maksimSaid !== undefined && after?.maksimSaid !== payload.maksimSaid ? "maksimSaid" : null,
        payload.whyNotClosed !== undefined && after?.whyNotClosed !== payload.whyNotClosed ? "whyNotClosed" : null,
      ].filter(Boolean);
      const icon = !after ? "⚠️" : mismatches.length ? "❌" : "✅";
      await consentStore
        .updateConsentAuditOutcome(auditId, {
          outcome: mismatches.length ? "failed" : "confirmed",
          postVerify: `${icon} #${payload.id}${mismatches.length ? ` — расхождение: ${mismatches.join(", ")}` : " — подтверждено"}`,
          preSnapshot: snap,
        })
        .catch((e) => console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e)));

      return ok({
        summary: `${icon} Updated Triage Log #${payload.id}${payload.status ? ` → ${payload.status}` : ""}`,
        id: payload.id,
        sheetRow: snap.sheetRow,
        updated: {
          ...(payload.status !== undefined && { status: payload.status }),
          ...(payload.maksimSaid !== undefined && { maksimSaid: payload.maksimSaid }),
          ...(payload.whyNotClosed !== undefined && { whyNotClosed: payload.whyNotClosed }),
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
