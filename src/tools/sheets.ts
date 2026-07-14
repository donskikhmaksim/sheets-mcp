/**
 * Google Sheets tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { sheets_v4 } from "googleapis";
import { ok, fail, guard } from "../util.js";
import { accountField, type UserClients } from "../accounts.js";

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

export function registerSheetsTools(server: McpServer, clients: UserClients) {
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
  server.registerTool(
    "sheets_write_range",
    {
      title: "Write range(s)",
      description:
        "Overwrite cell values in one or more A1 ranges. " +
        "Items for the same spreadsheet are batched into one API call. " +
        "Items for different spreadsheets run sequentially. " +
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
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);

      // Group by spreadsheetId
      const byId = new Map<string, typeof items>();
      for (const item of items) {
        const list = byId.get(item.spreadsheetId) ?? [];
        list.push(item);
        byId.set(item.spreadsheetId, list);
      }

      const results: Array<{ spreadsheetId: string; range?: string; updatedRange?: string; updatedCells?: number | null; error?: string }> = [];

      for (const [spreadsheetId, group] of byId) {
        if (group.length === 1) {
          // Single range — use values.update
          const { range, values, valueInputOption } = group[0];
          try {
            const res = await g.sheets.spreadsheets.values.update({
              spreadsheetId,
              range,
              valueInputOption: valueInputOption ?? "USER_ENTERED",
              requestBody: { values },
            });
            results.push({
              spreadsheetId,
              updatedRange: res.data.updatedRange ?? range,
              updatedCells: res.data.updatedCells,
            });
          } catch (e: unknown) {
            results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
          }
        } else {
          // Multiple ranges — use values.batchUpdate
          const vio = group[0].valueInputOption ?? "USER_ENTERED";
          try {
            const res = await g.sheets.spreadsheets.values.batchUpdate({
              spreadsheetId,
              requestBody: {
                valueInputOption: vio,
                data: group.map(({ range, values }) => ({ range, values })),
              },
            });
            for (const resp of res.data.responses ?? []) {
              results.push({
                spreadsheetId,
                updatedRange: resp.updatedRange ?? undefined,
                updatedCells: resp.updatedCells,
              });
            }
          } catch (e: unknown) {
            results.push({ spreadsheetId, error: String(e instanceof Error ? e.message : e) });
          }
        }
      }

      const ok_count = results.filter((r) => !r.error).length;
      return ok({
        summary: `Wrote ${ok_count}/${items.length} range(s)`,
        results,
      });
    }),
  );

  // ── sheets_append_rows ─────────────────────────────────────────────────────
  server.registerTool(
    "sheets_append_rows",
    {
      title: "Append rows",
      description:
        "Append rows to the end of data in one or more sheets. Items run sequentially per spreadsheet.",
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
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{ spreadsheetId: string; range?: string; updatedRange?: string; error?: string }> = [];

      for (const { spreadsheetId, range, values, valueInputOption } of items) {
        try {
          const res = await g.sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: valueInputOption ?? "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values },
          });
          results.push({
            spreadsheetId,
            updatedRange: res.data.updates?.updatedRange ?? range,
          });
        } catch (e: unknown) {
          results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
        }
      }

      const ok_count = results.filter((r) => !r.error).length;
      return ok({
        summary: `Appended to ${ok_count}/${items.length} range(s)`,
        results,
      });
    }),
  );

  // ── sheets_clear_range ─────────────────────────────────────────────────────
  server.registerTool(
    "sheets_clear_range",
    {
      title: "Clear range",
      description:
        "Clear values from one or more A1 ranges (keeps formatting). Items run sequentially.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D20'."),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{ spreadsheetId: string; range?: string; clearedRange?: string; clearedRowCount?: number; error?: string }> = [];

      for (const { spreadsheetId, range } of items) {
        try {
          let clearedValues: unknown[][] = [];
          try {
            const before = await g.sheets.spreadsheets.values.get({ spreadsheetId, range });
            clearedValues = before.data.values ?? [];
          } catch {
            // If the read fails, still proceed with the clear.
          }
          const res = await g.sheets.spreadsheets.values.clear({ spreadsheetId, range });
          results.push({
            spreadsheetId,
            clearedRange: res.data.clearedRange ?? range,
            clearedRowCount: clearedValues.length,
          });
        } catch (e: unknown) {
          results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
        }
      }

      const ok_count = results.filter((r) => !r.error).length;
      return ok({
        summary: `Cleared ${ok_count}/${items.length} range(s)`,
        results,
      });
    }),
  );

  // ── sheets_create ──────────────────────────────────────────────────────────
  server.registerTool(
    "sheets_create",
    {
      title: "Create spreadsheet",
      description: "Create one or more new spreadsheets. Returns per-item results.",
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
          .min(1),
      },
    },
    guard(async ({ account, spreadsheets }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        spreadsheets.map(async ({ title, sheetTitles }) => {
          try {
            const res = await g.sheets.spreadsheets.create({
              requestBody: {
                properties: { title },
                sheets: sheetTitles?.length
                  ? sheetTitles.map((t) => ({ properties: { title: t } }))
                  : undefined,
              },
              fields: "spreadsheetId,spreadsheetUrl,properties.title",
            });
            return {
              spreadsheetId: res.data.spreadsheetId,
              title: res.data.properties?.title ?? title,
              spreadsheetUrl: res.data.spreadsheetUrl,
            };
          } catch (e: unknown) {
            return { title, error: String(e instanceof Error ? e.message : e) };
          }
        }),
      );
      const ok_count = results.filter((r) => !("error" in r)).length;
      return ok({
        summary: `Created ${ok_count}/${spreadsheets.length} spreadsheet(s)`,
        results,
      });
    }),
  );

  // ── sheets_add_tab ─────────────────────────────────────────────────────────
  server.registerTool(
    "sheets_add_tab",
    {
      title: "Add a tab/sheet",
      description: "Add one or more new tabs to existing spreadsheets. Items run sequentially.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              spreadsheetId: z.string(),
              title: z.string().describe("Name of the new tab."),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{ spreadsheetId: string; sheetId?: number; title?: string; error?: string }> = [];

      for (const { spreadsheetId, title } of items) {
        try {
          const res = await g.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title } } }] },
          });
          const props = res.data.replies?.[0]?.addSheet?.properties;
          results.push({
            spreadsheetId,
            sheetId: props?.sheetId ?? undefined,
            title: props?.title ?? title,
          });
        } catch (e: unknown) {
          results.push({ spreadsheetId, title, error: String(e instanceof Error ? e.message : e) });
        }
      }

      const ok_count = results.filter((r) => !r.error).length;
      return ok({
        summary: `Added ${ok_count}/${items.length} tab(s)`,
        results,
      });
    }),
  );

  // ── sheets_find_replace ────────────────────────────────────────────────────
  server.registerTool(
    "sheets_find_replace",
    {
      title: "Find & replace",
      description:
        "Find and replace text across a spreadsheet (or a single sheet if sheetId is provided).",
      inputSchema: {
        account,
        spreadsheetId: z.string(),
        find: z.string(),
        replace: z.string(),
        matchCase: z.boolean().default(false).optional(),
        sheetId: z
          .number()
          .int()
          .optional()
          .describe("Restrict to one sheet (numeric sheetId from sheets_get_info)."),
      },
    },
    guard(async ({ account, spreadsheetId, find, replace, matchCase, sheetId }) => {
      const g = clients.resolve(account);
      const res = await g.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              findReplace: {
                find,
                replacement: replace,
                matchCase: matchCase ?? false,
                allSheets: sheetId === undefined ? true : undefined,
                sheetId,
              },
            },
          ],
        },
      });
      const fr = res.data.replies?.[0]?.findReplace ?? {};
      return ok({
        summary: `Replaced "${find}" -> "${replace}" — ${fr.occurrencesChanged ?? 0} occurrence(s)${sheetId !== undefined ? ` (sheet ${sheetId})` : " (all sheets)"}`,
        findReplace: fr,
      });
    }),
  );

  // ── sheets_format_range ────────────────────────────────────────────────────
  server.registerTool(
    "sheets_format_range",
    {
      title: "Format a range",
      description:
        "Apply common cell formatting to one or more A1 ranges without hand-writing batchUpdate JSON: " +
        "bold/italic, font size, text & background colour (#RRGGBB), alignment, number format, text wrap. " +
        "Pass only the options you want to change. Items run sequentially.",
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
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{ spreadsheetId: string; range: string; applied?: number; error?: string }> = [];

      for (const item of items) {
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

          const meta = await g.sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets.properties(sheetId,title)",
          });
          const titleToId = new Map<string, number>();
          for (const s of meta.data.sheets ?? []) {
            if (s.properties?.title && typeof s.properties.sheetId === "number") {
              titleToId.set(s.properties.title, s.properties.sheetId);
            }
          }
          const firstSheetId = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
          const gridRange = a1ToGridRange(range, titleToId, firstSheetId);

          await g.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                { repeatCell: { range: gridRange, cell: { userEnteredFormat: fmt }, fields: fields.join(",") } },
              ],
            },
          });
          results.push({ spreadsheetId, range, applied: fields.length });
        } catch (e: unknown) {
          results.push({ spreadsheetId, range, error: String(e instanceof Error ? e.message : e) });
        }
      }

      const ok_count = results.filter((r) => !r.error).length;
      return ok({
        summary: `Formatted ${ok_count}/${items.length} range(s)`,
        results,
      });
    }),
  );

  // ── sheets_raw_batch_update ────────────────────────────────────────────────
  server.registerTool(
    "sheets_raw_batch_update",
    {
      title: "Raw batchUpdate (advanced)",
      description:
        "Send raw Sheets API batchUpdate `requests` (formatting, merges, conditional formatting, etc.). Use only when other tools are not enough. See the Sheets API Request schema.",
      inputSchema: {
        account,
        spreadsheetId: z.string(),
        requests: z
          .array(z.record(z.string(), z.any()))
          .describe("Array of Sheets API Request objects."),
      },
    },
    guard(async ({ account, spreadsheetId, requests }) => {
      const g = clients.resolve(account);
      const res = await g.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: requests as object[] },
      });
      return ok({
        summary: `Applied ${requests.length} raw request(s) to spreadsheet`,
        spreadsheetId: res.data.spreadsheetId,
        replies: res.data.replies,
      });
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
}
