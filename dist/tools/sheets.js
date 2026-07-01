/**
 * Google Sheets tools.
 */
import { z } from "zod";
import { ok, fail, guard } from "../util.js";
import { accountField } from "../accounts.js";
/** "#RRGGBB" (or "RRGGBB") -> Sheets API color object. */
function hexToColor(hex) {
    const h = hex.replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h))
        throw new Error(`Bad color "${hex}", expected #RRGGBB.`);
    return {
        red: parseInt(h.slice(0, 2), 16) / 255,
        green: parseInt(h.slice(2, 4), 16) / 255,
        blue: parseInt(h.slice(4, 6), 16) / 255,
    };
}
/** Column letters -> 0-based index (A->0, B->1, ... AA->26). Exported for tests. */
export function colToIndex(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase())
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}
/**
 * Parses an A1 range (optionally "Sheet1!A1:C10") into a Sheets GridRange.
 * Resolves the sheet title to a numeric sheetId via the provided lookup.
 */
export function a1ToGridRange(range, sheetIdByTitle, firstSheetId) {
    const trimmed = range.trim();
    let sheetPart;
    let cells;
    const bang = trimmed.lastIndexOf("!");
    if (bang >= 0) {
        sheetPart = trimmed.slice(0, bang).replace(/^'|'$/g, "");
        cells = trimmed.slice(bang + 1).trim();
    }
    else if (/^[A-Za-z]+\d/.test(trimmed)) {
        // Looks like a cell reference (e.g. A1) on the default sheet.
        cells = trimmed;
    }
    else {
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
    if (!cells)
        return { sheetId }; // whole sheet
    const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(cells);
    if (!m)
        throw new Error(`Cannot parse range "${cells}". Use e.g. A1 or A1:C10.`);
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
export function registerSheetsTools(server, clients) {
    const account = accountField(clients);
    server.registerTool("sheets_list", {
        title: "List spreadsheets",
        description: "List Google Spreadsheets the account can access. Optionally filter by a name substring.",
        inputSchema: {
            account,
            nameContains: z
                .string()
                .optional()
                .describe("Only return spreadsheets whose name contains this text."),
            maxResults: z.number().int().min(1).max(200).default(50).optional(),
        },
    }, guard(async ({ account, nameContains, maxResults }) => {
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
            summary: `📋 ${files.length} spreadsheet(s)${nameContains ? ` matching "${nameContains}"` : ""} on account "${account ?? "default"}"`,
            files,
        });
    }));
    server.registerTool("sheets_get_info", {
        title: "Get spreadsheet info",
        description: "Get a spreadsheet's title and the list of its sheets/tabs (with sheetId, index, row/column counts).",
        inputSchema: {
            account,
            spreadsheetId: z.string().describe("The spreadsheet ID."),
        },
    }, guard(async ({ account, spreadsheetId }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.get({
            spreadsheetId,
            fields: "spreadsheetId,properties.title,spreadsheetUrl,sheets(properties(sheetId,title,index,gridProperties))",
        });
        const tabCount = res.data.sheets?.length ?? 0;
        const tabNames = (res.data.sheets ?? []).map((s) => s.properties?.title ?? "?").join(", ");
        return ok({
            summary: `ℹ️ "${res.data.properties?.title ?? spreadsheetId}" — ${tabCount} tab(s): ${tabNames}`,
            spreadsheetId: res.data.spreadsheetId,
            title: res.data.properties?.title,
            spreadsheetUrl: res.data.spreadsheetUrl,
            sheets: res.data.sheets,
        });
    }));
    server.registerTool("sheets_read_range", {
        title: "Read range",
        description: "Read cell values from an A1 range, e.g. 'Sheet1!A1:D20'. Returns a 2D array of values.",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D20' or 'Sheet1'."),
        },
    }, guard(async ({ account, spreadsheetId, range }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.values.get({ spreadsheetId, range });
        const values = res.data.values ?? [];
        const cols = values.reduce((n, row) => Math.max(n, row.length), 0);
        return ok({
            summary: `📖 Read ${res.data.range ?? range} — ${values.length} row(s), ${cols} col(s)`,
            range: res.data.range,
            values,
        });
    }));
    server.registerTool("sheets_write_range", {
        title: "Write range",
        description: "Overwrite cell values in an A1 range with a 2D array. `valueInputOption` USER_ENTERED parses formulas/numbers like the UI; RAW stores text verbatim.",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            range: z.string().describe("A1 notation of the top-left target, e.g. 'Sheet1!A1'."),
            values: z
                .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
                .describe("2D array of rows × columns."),
            valueInputOption: z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED").optional(),
        },
    }, guard(async ({ account, spreadsheetId, range, values, valueInputOption }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: valueInputOption ?? "USER_ENTERED",
            requestBody: { values },
        });
        return ok({
            summary: `✏️ Wrote ${values.length} row(s) to ${res.data.updatedRange ?? range}`,
            updatedRange: res.data.updatedRange,
            updatedRows: res.data.updatedRows,
            updatedColumns: res.data.updatedColumns,
            updatedCells: res.data.updatedCells,
        });
    }));
    server.registerTool("sheets_append_rows", {
        title: "Append rows",
        description: "Append rows to the end of the data in a sheet. `range` is used to find the table (e.g. 'Sheet1').",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            range: z.string().describe("Sheet/table to append to, e.g. 'Sheet1'."),
            values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
            valueInputOption: z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED").optional(),
        },
    }, guard(async ({ account, spreadsheetId, range, values, valueInputOption }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: valueInputOption ?? "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values },
        });
        return ok({
            summary: `➕ Appended ${values.length} row(s) to ${res.data.updates?.updatedRange ?? range}`,
            updates: res.data.updates,
        });
    }));
    server.registerTool("sheets_clear_range", {
        title: "Clear range",
        description: "Clear the values from an A1 range (keeps formatting). " +
            "Returns the values that were cleared so it's clear what was removed. " +
            "Pass `_sheetTitle` if known — it appears in the approval dialog.",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D20'."),
            _sheetTitle: z.string().optional().describe("Spreadsheet title (for the approval dialog — fill from context if known)."),
        },
    }, guard(async ({ account, spreadsheetId, range }) => {
        const g = clients.resolve(account);
        let clearedValues = [];
        try {
            const before = await g.sheets.spreadsheets.values.get({ spreadsheetId, range });
            clearedValues = before.data.values ?? [];
        }
        catch {
            // If the read fails, still proceed with the clear.
        }
        const res = await g.sheets.spreadsheets.values.clear({ spreadsheetId, range });
        const cellCount = clearedValues.reduce((n, row) => n + (row?.length ?? 0), 0);
        return ok({
            summary: `🧹 Cleared ${res.data.clearedRange ?? range} — ${clearedValues.length} row(s), ${cellCount} non-empty cell(s)`,
            clearedRange: res.data.clearedRange,
            clearedRowCount: clearedValues.length,
            clearedValues,
        });
    }));
    server.registerTool("sheets_create", {
        title: "Create spreadsheet",
        description: "Create a new spreadsheet and return its id and URL.",
        inputSchema: {
            account,
            title: z.string().describe("Title of the new spreadsheet."),
            sheetTitles: z
                .array(z.string())
                .optional()
                .describe("Optional list of tab names to create."),
        },
    }, guard(async ({ account, title, sheetTitles }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.create({
            requestBody: {
                properties: { title },
                sheets: sheetTitles?.length
                    ? sheetTitles.map((t) => ({ properties: { title: t } }))
                    : undefined,
            },
            fields: "spreadsheetId,spreadsheetUrl,properties.title",
        });
        return ok({
            summary: `📊 Created spreadsheet "${res.data.properties?.title ?? title}"`,
            spreadsheetId: res.data.spreadsheetId,
            spreadsheetUrl: res.data.spreadsheetUrl,
            title: res.data.properties?.title,
        });
    }));
    server.registerTool("sheets_add_tab", {
        title: "Add a tab/sheet",
        description: "Add a new tab (sheet) to an existing spreadsheet.",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            title: z.string().describe("Name of the new tab."),
        },
    }, guard(async ({ account, spreadsheetId, title }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title } } }] },
        });
        return ok({
            summary: `📄 Added tab "${title}" to spreadsheet`,
            addedSheet: res.data.replies?.[0]?.addSheet?.properties,
        });
    }));
    server.registerTool("sheets_find_replace", {
        title: "Find & replace",
        description: "Find and replace text across a spreadsheet (or a single sheet if sheetId is provided).",
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
    }, guard(async ({ account, spreadsheetId, find, replace, matchCase, sheetId }) => {
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
            summary: `🔄 Replaced "${find}" → "${replace}" — ${fr.occurrencesChanged ?? 0} occurrence(s)${sheetId !== undefined ? ` (sheet ${sheetId})` : " (all sheets)"}`,
            findReplace: fr,
        });
    }));
    server.registerTool("sheets_raw_batch_update", {
        title: "Raw batchUpdate (advanced)",
        description: "Send raw Sheets API batchUpdate `requests` (formatting, merges, conditional formatting, etc.). Use only when other tools are not enough. See the Sheets API Request schema.",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            requests: z
                .array(z.record(z.string(), z.any()))
                .describe("Array of Sheets API Request objects."),
        },
    }, guard(async ({ account, spreadsheetId, requests }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: requests },
        });
        return ok({
            summary: `⚙️ Applied ${requests.length} raw request(s) to spreadsheet`,
            spreadsheetId: res.data.spreadsheetId,
            replies: res.data.replies,
        });
    }));
    server.registerTool("sheets_batch_write", {
        title: "Write several ranges at once",
        description: "Write multiple non-contiguous ranges in one call. Each item is { range, values } (2D array). " +
            "More efficient than several sheets_write_range calls.",
        inputSchema: {
            account,
            spreadsheetId: z.string(),
            data: z
                .array(z.object({
                range: z.string().describe("A1 notation, e.g. 'Sheet1!A1' or 'Sheet1!B2:C3'."),
                values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
            }))
                .min(1),
            valueInputOption: z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED").optional(),
        },
    }, guard(async ({ account, spreadsheetId, data, valueInputOption }) => {
        const g = clients.resolve(account);
        const res = await g.sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: valueInputOption ?? "USER_ENTERED",
                data: data.map((d) => ({ range: d.range, values: d.values })),
            },
        });
        const totalCells = data.reduce((n, d) => n + d.values.reduce((m, row) => m + row.length, 0), 0);
        return ok({
            summary: `✏️ Wrote ${data.length} range(s), ${totalCells} cell(s) total`,
            totalUpdatedCells: res.data.totalUpdatedCells,
            totalUpdatedRows: res.data.totalUpdatedRows,
            responses: res.data.responses?.map((r) => r.updatedRange),
        });
    }));
    server.registerTool("sheets_format_range", {
        title: "Format a range",
        description: "Apply common cell formatting to an A1 range without hand-writing batchUpdate JSON: " +
            "bold/italic, font size, text & background colour (#RRGGBB), alignment, number format, text wrap. " +
            "Pass only the options you want to change.",
        inputSchema: {
            account,
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
        },
    }, guard(async (args) => {
        const { account, spreadsheetId, range, bold, italic, fontSize, textColor, backgroundColor, horizontalAlignment, verticalAlignment, wrapStrategy, numberFormatType, numberFormatPattern, } = args;
        const g = clients.resolve(account);
        const fmt = {};
        const fields = [];
        const textFormat = {};
        if (bold !== undefined) {
            textFormat.bold = bold;
            fields.push("userEnteredFormat.textFormat.bold");
        }
        if (italic !== undefined) {
            textFormat.italic = italic;
            fields.push("userEnteredFormat.textFormat.italic");
        }
        if (fontSize !== undefined) {
            textFormat.fontSize = fontSize;
            fields.push("userEnteredFormat.textFormat.fontSize");
        }
        if (textColor) {
            textFormat.foregroundColor = hexToColor(textColor);
            fields.push("userEnteredFormat.textFormat.foregroundColor");
        }
        if (Object.keys(textFormat).length)
            fmt.textFormat = textFormat;
        if (backgroundColor) {
            fmt.backgroundColor = hexToColor(backgroundColor);
            fields.push("userEnteredFormat.backgroundColor");
        }
        if (horizontalAlignment) {
            fmt.horizontalAlignment = horizontalAlignment;
            fields.push("userEnteredFormat.horizontalAlignment");
        }
        if (verticalAlignment) {
            fmt.verticalAlignment = verticalAlignment;
            fields.push("userEnteredFormat.verticalAlignment");
        }
        if (wrapStrategy) {
            fmt.wrapStrategy = wrapStrategy;
            fields.push("userEnteredFormat.wrapStrategy");
        }
        if (numberFormatPattern || numberFormatType) {
            fmt.numberFormat = { type: numberFormatType ?? "NUMBER", pattern: numberFormatPattern };
            fields.push("userEnteredFormat.numberFormat");
        }
        if (!fields.length)
            return fail("Specify at least one formatting option.");
        const meta = await g.sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets.properties(sheetId,title)",
        });
        const titleToId = new Map();
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
        return ok({
            summary: `🎨 Applied ${fields.length} format(s) to ${range}`,
            formatted: range,
            applied: fields.length,
        });
    }));
}
