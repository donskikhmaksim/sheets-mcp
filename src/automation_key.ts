/**
 * automation_key.ts (sheets-mcp) — READ-ONLY consumer side of the
 * ecosystem-wide `automation_key` (docs/TZ_automation_key_consent_gate.md).
 *
 * Generation lives EXCLUSIVELY in gmail-mcp (`src/automation_key.ts` there —
 * see its docstring: single Telegram webhook, single writer). This module
 * only ANSWERS "does this key cover the `sheets` service right now?" for
 * `consent.ts`'s `checkAutomationKey` DI slot — it never writes a row, never
 * talks to Telegram, never generates a token.
 *
 * Canonical service names (fixed by the hub ТЗ, `AUTOMATION_SERVICES` in
 * gmail-mcp's automation_key.ts): gmail/calendar/drive/sheets/docs/ticktick.
 * This server's identity in that list is the constant below.
 */

import { createHash } from "node:crypto";

export const AUTOMATION_SERVICE = "sheets";

export function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** true if `scope` (the CSV/"all" column value straight out of
 * `tg_automation_windows`) covers `service`. `"all"` covers everything;
 * otherwise the scope is a comma-separated list of canonical service names
 * and `service` must appear in it verbatim (no substring matching — "docs"
 * must not match a scope entry like "google-docs"). */
export function scopeCovers(scope: string, service: string): boolean {
  const trimmed = scope.trim();
  if (trimmed === "all") return true;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .includes(service);
}

/** Minimal DI surface this module needs from `store.ts` — one read, by token
 * hash (the raw key never carries its own window_id). */
export interface AutomationWindowLookupStore {
  getAutomationWindowByTokenHash(tokenHash: string): Promise<{
    scope: string;
    expiresAt: number;
    revokedAt: number | null;
  } | null>;
}

/**
 * Builds the `checkAutomationKey` callback `consent.ts`'s `requireConsent`
 * expects (`RequireConsentParams.checkAutomationKey`). `{ok: false}` on ANY
 * failure to validate — missing key, revoked, expired, wrong scope — never
 * throws: `requireConsent`'s automation branch treats `{ok:false}` as a
 * silent fallthrough to the normal human path (ТЗ раздел "consent.ts", п.2),
 * not an error a model could learn to probe for.
 */
export function makeCheckAutomationKey(
  store: AutomationWindowLookupStore,
  now: () => number = Date.now,
): (key: string) => Promise<{ ok: boolean; channel?: string }> {
  return async (key: string) => {
    const raw = (key ?? "").trim();
    if (!raw) return { ok: false };
    const tokenHash = sha256Hex(raw);
    const row = await store.getAutomationWindowByTokenHash(tokenHash);
    if (!row) return { ok: false };
    if (row.revokedAt != null) return { ok: false };
    if (row.expiresAt != null && row.expiresAt <= now()) return { ok: false };
    if (!scopeCovers(row.scope, AUTOMATION_SERVICE)) return { ok: false };
    return { ok: true, channel: "window" };
  };
}
