import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { buildUserClients, registerAccountTools } from "./accounts.js";
import { registerSheetsTools } from "./tools/sheets.js";
import { registerTriageTools } from "./tools/triage.js";

export function buildMcpServer(user: User): McpServer {
  const clients = buildUserClients(user);
  const accountsHint = clients.multi
    ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
    : `One Google account ("${clients.defaultName}") is configured.`;

  const server = new McpServer(
    { name: "sheets-mcp", version: "1.0.0" },
    { instructions: "Tools to read and edit Google Sheets. Use sheets_list to find spreadsheets, then read or edit by id. " + accountsHint },
  );
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients);
  registerTriageTools(server, clients);
  return server;
}
