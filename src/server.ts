import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { loadConsentGateConfig, loadTgApprovalConfig } from "./config.js";
import { buildUserClients, registerAccountTools } from "./accounts.js";
import { registerSheetsTools, type SheetsConsentContext } from "./tools/sheets.js";
import { registerTriageTools } from "./tools/triage.js";
import type { ConsentStore, ConsentConfig } from "./consent.js";
import type { TgApprovalStore, TgApprovalGate } from "./tg_approval.js";
import { createTgApprovalGate } from "./tg_approval.js";
import {
  storeReady,
  createManifest,
  getManifest,
  consumeManifest,
  invalidateManifest,
  appendConsentAudit,
  updateConsentAuditOutcome,
  listConsentAudit,
  countConsentAudit,
  createTgApproval,
  getTgApproval,
  consumeTgDecision,
  consumeTgDecisionAnyServer,
} from "./store.js";

/**
 * store.ts's consent-gate functions (ported from gmail-mcp package A1), typed
 * against consent.ts's `ConsentStore` here — signature-for-signature by
 * construction, but the `: ConsentStore` annotation means a drift fails THIS
 * build, not the tool file's.
 */
export const consentStoreAdapter: ConsentStore = {
  createManifest,
  getManifest,
  consumeManifest,
  invalidateManifest,
  appendConsentAudit,
  updateConsentAuditOutcome,
};

/**
 * Read-only adapter for `sheets_consent_audit` — separate from
 * `consentStoreAdapter` above (the plan/execute gate contract) since this is
 * a different, purely-reading surface: "разбор инцидента без ssh"
 * (limits-audit.md §11).
 */
export const auditStoreAdapter = { listConsentAudit, countConsentAudit };

/** This server's identity ($self = "sheets") in the shared consent_manifests/
 * consent_audit tables, plus the gate's TTL/anti-doublet/batch-cap knobs —
 * env-driven, see `loadConsentGateConfig` in config.ts. `now` is left unset
 * here (real `Date.now`); consent.ts's `now` injection exists for OFFLINE
 * UNIT TESTS only. */
const consentGateEnv = loadConsentGateConfig();
export const consentServerConfig: ConsentConfig = {
  server: consentGateEnv.server,
  consentTtlMs: consentGateEnv.consentTtlMs,
  minConsentGapMs: consentGateEnv.minConsentGapMs,
  sendBatchMax: consentGateEnv.sendBatchMax,
};

/**
 * Optional Telegram-approval layer (plan-tg-approval.md), ported from
 * gmail-mcp per mcp-development-standard. Loaded once at module scope, same
 * as `consentGateEnv`/`consentServerConfig` above — this throws loudly at
 * process start if TG_APPROVAL_ENABLED=true but misconfigured (package P0),
 * rather than silently degrading. Exported so http.ts can mount `/tg/webhook`
 * and call `registerWebhook()` at startup without re-deriving it.
 *
 * KNOWN GAP (not this file's fault — flagged, not worked around): unlike
 * gmail-mcp, THIS server's `consent.ts` does not yet declare a `tg?:
 * TgApprovalGate` field on `RequireConsentParams`, nor an `if (p.tg?.
 * enabledFor(tool))` branch inside `requireConsent()` — the two repos have
 * drifted. That means `tgApprovalGate` below is built and fully functional
 * (webhook, storage, Telegram HTTP calls all work end-to-end and are
 * covered by scripts/test-tg-approval.mjs), but it is NOT YET threaded into
 * `SheetsConsentContext` or any `requireConsent(...)` call in tools/sheets.ts
 * / tools/triage.ts — doing so today would not compile (`tg` is not a known
 * property of `RequireConsentParams`) and, more importantly, would be a
 * no-op even if it did, since requireConsent() itself never reads `p.tg`.
 * Wiring that in requires porting consent.ts's `tg` support from gmail-mcp
 * FIRST (out of scope for this port — see mcp-development-standard's
 * "обсуждение до кода" rule for any change to consent.ts itself).
 */
export const tgApprovalConfig = loadTgApprovalConfig(consentGateEnv.server);

/** store.ts's tg_approvals functions (package P1), typed against
 * tg_approval.ts's `TgApprovalStore` here — signature-for-signature by
 * construction, same discipline as `consentStoreAdapter` above. */
export const tgApprovalStoreAdapter: TgApprovalStore = {
  createTgApproval,
  getTgApproval,
  consumeTgDecision,
  consumeTgDecisionAnyServer,
};

/** Always constructed (even when TG_APPROVAL_ENABLED=false) so `enabledFor()`
 * is simply false for every tool in that case — the compatibility invariant
 * a fork without a configured Telegram bot relies on. See the KNOWN GAP note
 * above: this object is not yet reachable from any gated tool in THIS repo. */
export const tgApprovalGate: TgApprovalGate = createTgApprovalGate(tgApprovalConfig, tgApprovalStoreAdapter);

export function buildMcpServer(user: User): McpServer {
  const clients = buildUserClients(user);
  const accountsHint = clients.multi
    ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
    : `One Google account ("${clients.defaultName}") is configured.`;

  const server = new McpServer(
    { name: "sheets-mcp", version: "1.0.0" },
    { instructions: "Tools to read and edit Google Sheets. Use sheets_list to find spreadsheets, then read or edit by id. " + accountsHint },
  );
  // Honest degradation (gate.md §3.5): `consentStore`/`auditStore` are null
  // exactly when Postgres isn't configured — without it there's nowhere to
  // persist a manifest, so the gated write tools refuse outright rather than
  // mutate unconfirmed.
  const consentCtx: SheetsConsentContext = {
    consentStore: storeReady() ? consentStoreAdapter : null,
    consentCfg: consentServerConfig,
    auditStore: storeReady() ? auditStoreAdapter : null,
  };
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  registerTriageTools(server, clients, consentCtx);
  return server;
}
