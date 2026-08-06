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
  markTgNotified,
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
  markTgNotified,
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
 * БЫЛО ПРОБЕЛОМ, закрыто 2026-08-05 (auto-execute port): `consent.ts`
 * now carries the `tg?: TgApprovalGate` field on `RequireConsentParams` and
 * the `if (p.tg?.enabledFor(tool))` branches inside `requireConsent()` (was
 * drifted from gmail-mcp before, is not any more), AND `tools/sheets.ts` /
 * `tools/triage.ts` already destructure `tg` from `SheetsConsentContext` and
 * pass it into every `requireConsent(...)` call. The one piece that was
 * still missing — `buildMcpServer()`'s `consentCtx` object below never set
 * `tg`, so `ctx.tg` was `undefined` at every call site and the whole
 * Telegram-button layer was silently inert even though every other part of
 * it worked — is fixed by the `tg: tgApprovalGate` field a few lines down.
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
 * a fork without a configured Telegram bot relies on.
 *
 * ⚠️ ИСПРАВЛЕНО 2026-08-06: здесь стояло «this object is not yet reachable
 * from any gated tool in THIS repo». Это неправда с момента, когда
 * `buildMcpServer()` ниже начал класть `tg: tgApprovalGate` в `consentCtx` —
 * гейт достижим из КАЖДОГО гейтованного тула, и с ним же работает
 * button-only-режим (`consent.ts`'s `tgButtonOnly`). Комментарий пережил свою
 * причину и вводил в заблуждение. */
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
    tg: tgApprovalGate,
  };
  registerAccountTools(server, clients);
  registerSheetsTools(server, clients, consentCtx);
  registerTriageTools(server, clients, consentCtx);
  return server;
}
