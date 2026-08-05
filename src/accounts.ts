/**
 * Per-user account resolution. A user can have several named Google accounts;
 * each tool call picks one via the optional `account` argument.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { createGoogleClients, type GoogleClients } from "./google.js";

export interface UserClients {
  names: string[];
  defaultName: string;
  multi: boolean;
  /** Returns clients for the named account, or the default when name is omitted. */
  resolve(name?: string): GoogleClients;
  /** Base Gmail search fragment configured for the named account (or ""). */
  baseGmailQuery(name?: string): string;
}

/**
 * Module-level cache of the most recently resolved `UserClients`, set by
 * http.ts's `runAutoExecutePoller` right before it drives Telegram-button
 * auto-execute for a poll tick (Максим, 2026-08-05 — see consent.ts's
 * `tryAutoExecute` doc-comment).
 *
 * WHY THIS EXISTS: gated tools' `rehash` callbacks close over a per-request
 * `GoogleClients` (resolved from the MCP call's own `account` argument via
 * `clients.resolve(account)`), because they normally only ever run inside
 * `registerSheetsTools`/`registerTriageTools`'s request-scoped closure. The
 * auto-execute registry (`autoExecute.ts`) is different: `registerAutoExecutor`
 * calls happen ONCE at module import time, and `tryAutoExecute()` (consent.ts)
 * invokes the registered `rehash` with ONLY `row.payload` — no request, no
 * `clients`, by design (`RehashFn`'s signature is fixed and portable across
 * all 5 Google MCP servers, see autoExecute.ts's own doc-comment — it must
 * not gain a second parameter just for this).
 *
 * This getter/setter pair is the narrow bridge: `runAutoExecutePoller` is the
 * ONE place outside a real MCP request that legitimately needs a live
 * `UserClients` (it already resolves one, the exact same way a real request
 * would via `userFromGoogleAccounts(config) ?? config.users[0]`), so it
 * publishes it here right before driving the loop. Every gated tool's
 * registered `rehash` in tools/sheets.ts / tools/triage.ts reads it back to
 * resolve the account named in the manifest's own payload — the SAME
 * computation the tool's own request-scoped `rehash` performs, just sourcing
 * `g` from here instead of a request closure. Never read on the normal MCP
 * request path (that path always has a real `clients` in closure already).
 */
let lastAutoExecuteClients: UserClients | null = null;

export function setAutoExecuteClients(c: UserClients): void {
  lastAutoExecuteClients = c;
}

/** Non-null exactly while a poll tick that found candidates is running (set
 * by runAutoExecutePoller before its loop) — see doc-comment above. A gated
 * tool's registered `rehash` calling this outside that window would be a
 * wiring bug (auto-execute's rehash should only ever run from the poller). */
export function getAutoExecuteClients(): UserClients | null {
  return lastAutoExecuteClients;
}

export function buildUserClients(user: User): UserClients {
  const map = new Map<string, GoogleClients>();
  const queries = new Map<string, string>();
  for (const acc of user.accounts) {
    map.set(acc.name, createGoogleClients(acc.auth));
    queries.set(acc.name, acc.gmailQuery ?? "");
  }
  const names = user.accounts.map((a) => a.name);
  const keyFor = (name?: string) =>
    name && name.trim() ? name.trim() : user.defaultAccount;
  return {
    names,
    defaultName: user.defaultAccount,
    multi: names.length > 1,
    resolve(name?: string): GoogleClients {
      const key = keyFor(name);
      const clients = map.get(key);
      if (!clients) {
        throw new Error(
          `Unknown account "${key}". Available accounts: ${names.join(", ")}.`,
        );
      }
      return clients;
    },
    baseGmailQuery(name?: string): string {
      return queries.get(keyFor(name)) ?? "";
    },
  };
}

/** A reusable zod field describing the `account` selector for a user. */
export function accountField(clients: UserClients) {
  const desc = clients.multi
    ? `Which Google account to act on: ${clients.names.join(", ")}. ` +
      `Defaults to "${clients.defaultName}" if omitted.`
    : `Google account to use (only "${clients.defaultName}" is configured).`;
  return z.string().optional().describe(desc);
}

/**
 * Registers a read-only `list_accounts` tool so the model (and user) can see
 * which Google accounts are available and which is the default before choosing
 * an `account` for other tools.
 */
export function registerAccountTools(server: McpServer, clients: UserClients): void {
  server.registerTool(
    "list_accounts",
    {
      description:
        "List the Google accounts available to this server. Use the returned name " +
        "as the `account` argument on other tools to act on a specific account.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const lines = clients.names.map(
        (n) => `- ${n}${n === clients.defaultName ? " (default)" : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              (lines.length ? lines.join("\n") : "No accounts configured.") +
              `\n\nPass \`account\` with one of these names to pick an account; omitted uses "${clients.defaultName}".`,
          },
        ],
      };
    },
  );
}
