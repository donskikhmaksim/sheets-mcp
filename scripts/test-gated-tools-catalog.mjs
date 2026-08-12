#!/usr/bin/env node
/**
 * gated_tools_catalog.ts + GET /automation-key-catalog —
 * ТЗ `docs/TZ_automation_key_method_catalog.md`, разделы 1-2, тестовый план
 * пп.1-2.
 *
 * [A] `listGatedTools` against a throwaway synthetic McpServer carrying one
 *     gated tool (automation_key in schema) and one NOT gated tool — proves
 *     the filter is exact, no manual list involved.
 * [B] `listGatedTools` against the REAL `buildMcpServer` of this repo — the
 *     names it returns must match exactly the `tool: "..."` strings already
 *     wired into `requireConsent(...)` calls in src/tools/sheets.ts and
 *     src/tools/triage.ts (found by grep, hardcoded here as the expected
 *     set — this list is NOT what the catalog itself is built from, so it's
 *     a real independent check, not a tautology).
 * [C] `GET /automation-key-catalog` — live HTTP call against a real
 *     express app, response shape `{service, tools}` and content matches [B].
 *
 * Usage: node scripts/test-gated-tools-catalog.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import http from "node:http";
import { listGatedTools } from "../dist/gated_tools_catalog.js";
import { buildMcpServer } from "../dist/server.js";
import { AUTOMATION_SERVICE } from "../dist/automation_key.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// ═══ [A] synthetic server: one gated tool, one plain tool ═══════════════════

console.log("\n[A] listGatedTools — только тулы, несущие automation_key в схеме");
{
  const server = new McpServer({ name: "catalog-test", version: "0" });
  server.registerTool(
    "fake_gated_tool",
    {
      description: "A fake gated tool for testing the catalog filter.",
      inputSchema: { automation_key: z.string().optional() },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  server.registerTool(
    "fake_plain_tool",
    {
      description: "A fake NON-gated tool — must NOT appear in the catalog.",
      inputSchema: { foo: z.string().optional() },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  const catalog = await listGatedTools(server);
  const names = catalog.map((t) => t.name);
  check("gated tool IS in the catalog", names.includes("fake_gated_tool"), JSON.stringify(names));
  check("plain (non-gated) tool is NOT in the catalog", !names.includes("fake_plain_tool"), JSON.stringify(names));
  check("catalog has exactly 1 entry", catalog.length === 1, String(catalog.length));
  check("entry carries a description", typeof catalog[0]?.description === "string" && catalog[0].description.length > 0);
}

// ═══ [B] real server — matches the actual requireConsent(...) tool list ═════

// Ground truth: every `tool: "..."` string passed to requireConsent in this
// repo's tools/*.ts, found independently via
//   grep -rn 'tool: "' src/tools/sheets.ts src/tools/triage.ts
const EXPECTED_GATED_TOOLS = [
  "sheets_write_range",
  "sheets_append_rows",
  "sheets_clear_range",
  "sheets_create",
  "sheets_add_tab",
  "sheets_find_replace",
  "sheets_format_range",
  "sheets_raw_batch_update",
  "triage_log_add",
  "triage_log_update",
].sort();

console.log("\n[B] listGatedTools против реального buildMcpServer сервиса sheets");
let realCatalog;
{
  const server = buildMcpServer({ accounts: [], defaultAccount: "" });
  realCatalog = await listGatedTools(server);
  const names = realCatalog.map((t) => t.name).sort();
  check(
    `реальный каталог = ожидаемый список (${EXPECTED_GATED_TOOLS.length} гейтированных тулов)`,
    JSON.stringify(names) === JSON.stringify(EXPECTED_GATED_TOOLS),
    JSON.stringify(names),
  );
}

// ═══ [C] GET /automation-key-catalog — живой HTTP-вызов ═════════════════════

console.log("\n[C] GET /automation-key-catalog — живой express-роут");
{
  const express = (await import("express")).default;
  const { listGatedTools: listGatedToolsC } = await import("../dist/gated_tools_catalog.js");
  const app = express();
  app.get("/automation-key-catalog", async (_req, res) => {
    const server = buildMcpServer({ accounts: [], defaultAccount: "" });
    const tools = await listGatedToolsC(server);
    res.json({ service: AUTOMATION_SERVICE, tools });
  });
  const httpServer = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = httpServer.address().port;
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/automation-key-catalog`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on("error", reject);
  });
  check("HTTP 200", body.status === 200, String(body.status));
  check("service === 'sheets'", body.json.service === "sheets", body.json.service);
  const names = (body.json.tools ?? []).map((t) => t.name).sort();
  check(
    "HTTP response carries the same tool set as [B]",
    JSON.stringify(names) === JSON.stringify(EXPECTED_GATED_TOOLS),
    JSON.stringify(names),
  );
  await new Promise((resolve) => httpServer.close(resolve));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
