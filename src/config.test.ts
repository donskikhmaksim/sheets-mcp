import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadTgApprovalConfig } from "./config.js";

// Every env var loadConfig/loadOnboarding might read, so each test starts clean
// regardless of what's exported in the shell running these tests.
const RELEVANT_KEYS = [
  "MCP_TRANSPORT",
  "PORT",
  "DATABASE_URL",
  "PUBLIC_BASE_URL",
  "RAILWAY_PUBLIC_DOMAIN",
  "ONBOARDING_GOOGLE_CLIENT_ID",
  "ONBOARDING_GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "TOKEN_ENC_KEY",
  "OAUTH_RELAY_URL",
  "OAUTH_RELAY_SECRET",
  "DASHBOARD_SECRET",
  "OWNER_EMAILS",
  "MCP_USERS",
  "MCP_AUTH_TOKEN",
  "GOOGLE_ACCOUNTS",
  "GOOGLE_DEFAULT_ACCOUNT",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_BASE64",
  "GMAIL_DEFAULT_QUERY",
  "TG_APPROVAL_ENABLED",
  "TG_BOT_TOKEN",
  "TG_BOT_TOKEN_OVERRIDE",
  "TG_OWNER_CHAT_ID",
  "TG_APPROVAL_WEBHOOK_SECRET",
  "TG_APPROVAL_TOOLS",
  "TG_APPROVAL_TTL_MS",
  "TG_WEBHOOK_OWNER",
];

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of RELEVANT_KEYS) saved.set(key, process.env[key]);
  for (const key of RELEVANT_KEYS) delete process.env[key];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const [key, val] of saved) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

const ONBOARDING_BASE = {
  DATABASE_URL: "postgres://example/db",
  RAILWAY_PUBLIC_DOMAIN: "example.up.railway.app",
  ONBOARDING_GOOGLE_CLIENT_ID: "client-id",
  ONBOARDING_GOOGLE_CLIENT_SECRET: "client-secret",
  TOKEN_ENC_KEY: "enc-key",
};

test("onboarding enabled + MCP_AUTH_TOKEN + no env Google creds => placeholder token-holder user with empty accounts, filled from Postgres later", () => {
  withEnv({ ...ONBOARDING_BASE, MCP_AUTH_TOKEN: "static-token-123" }, () => {
    const config = loadConfig();
    assert.equal(config.onboarding.enabled, true);
    assert.equal(config.users.length, 1);
    assert.equal(config.users[0].token, "static-token-123");
    assert.deepEqual(config.users[0].accounts, []);
    assert.equal(config.requireAuth, true);
  });
});

test("onboarding enabled + no MCP_AUTH_TOKEN + no env Google creds => no env users at all (DB/onboarding covers everyone)", () => {
  withEnv({ ...ONBOARDING_BASE }, () => {
    const config = loadConfig();
    assert.equal(config.onboarding.enabled, true);
    assert.deepEqual(config.users, []);
  });
});

test("onboarding enabled + legacy GOOGLE_ACCOUNTS still present => parses normally (unchanged pre-existing behaviour)", () => {
  withEnv(
    {
      ...ONBOARDING_BASE,
      MCP_AUTH_TOKEN: "static-token-123",
      GOOGLE_ACCOUNTS: JSON.stringify({
        personal: { client_id: "a", client_secret: "b", refresh_token: "c" },
      }),
    },
    () => {
      const config = loadConfig();
      assert.equal(config.users.length, 1);
      assert.equal(config.users[0].accounts.length, 1);
      assert.equal(config.users[0].accounts[0].name, "personal");
    },
  );
});

test("onboarding disabled + no Google creds at all => loadConfig throws (no silent misconfiguration)", () => {
  withEnv({}, () => {
    assert.throws(() => loadConfig());
  });
});

test("OWNER_EMAILS parsed as lowercase, trimmed, comma-separated list", () => {
  withEnv({ ...ONBOARDING_BASE, OWNER_EMAILS: " Alice@Example.com, bob@example.com ,," }, () => {
    const config = loadConfig();
    assert.deepEqual(config.onboarding.ownerEmails, ["alice@example.com", "bob@example.com"]);
  });
});

test("OWNER_EMAILS unset => allowlist disabled (undefined), fail-open for other deployments", () => {
  withEnv({ ...ONBOARDING_BASE }, () => {
    const config = loadConfig();
    assert.equal(config.onboarding.ownerEmails, undefined);
  });
});

// ── loadTgApprovalConfig: TG_BOT_TOKEN_OVERRIDE (own-bot-per-server escape hatch) ──

const TG_APPROVAL_BASE = {
  TG_APPROVAL_ENABLED: "true",
  TG_BOT_TOKEN: "shared-bot-token",
  TG_OWNER_CHAT_ID: "555",
  TG_APPROVAL_WEBHOOK_SECRET: "shared-webhook-secret",
  PUBLIC_BASE_URL: "https://example.test",
};

test("TG_BOT_TOKEN_OVERRIDE unset => byte-for-byte the old shared-bot config (ownBot=false, botToken/webhookSecret from the shared vars)", () => {
  withEnv({ ...TG_APPROVAL_BASE }, () => {
    const cfg = loadTgApprovalConfig("sheets");
    assert.equal(cfg.ownBot, false);
    assert.equal(cfg.botToken, "shared-bot-token");
    assert.equal(cfg.webhookSecret, "shared-webhook-secret");
  });
});

test("TG_BOT_TOKEN_OVERRIDE set => ownBot=true and botToken is the override, even though TG_BOT_TOKEN is also set", () => {
  withEnv({ ...TG_APPROVAL_BASE, TG_BOT_TOKEN_OVERRIDE: "own-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("sheets");
    assert.equal(cfg.ownBot, true);
    assert.equal(cfg.botToken, "own-bot-token");
  });
});

test("TG_BOT_TOKEN_OVERRIDE set alone (no TG_BOT_TOKEN at all) => still resolves, ownBot=true", () => {
  withEnv({ ...TG_APPROVAL_BASE, TG_BOT_TOKEN: undefined, TG_BOT_TOKEN_OVERRIDE: "own-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("sheets");
    assert.equal(cfg.ownBot, true);
    assert.equal(cfg.botToken, "own-bot-token");
  });
});

test("webhookSecret has no own-bot override — always TG_APPROVAL_WEBHOOK_SECRET, even with ownBot=true (consistent with gmail/drive/calendar-mcp: no second flag, Railway's own per-service env namespace already covers per-server secrets)", () => {
  withEnv({ ...TG_APPROVAL_BASE, TG_BOT_TOKEN_OVERRIDE: "own-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("sheets");
    assert.equal(cfg.ownBot, true);
    assert.equal(cfg.webhookSecret, "shared-webhook-secret");
  });
});

test("ownBot=true + missing TG_OWNER_CHAT_ID => still throws loudly (own-bot mode doesn't relax the other required fields)", () => {
  withEnv(
    { ...TG_APPROVAL_BASE, TG_OWNER_CHAT_ID: undefined, TG_BOT_TOKEN_OVERRIDE: "own-bot-token" },
    () => {
      assert.throws(() => loadTgApprovalConfig("sheets"), /TG_OWNER_CHAT_ID/);
    },
  );
});

test("TG_APPROVAL_ENABLED=false => ownBot is still computed from TG_BOT_TOKEN_OVERRIDE alone (independent of the enabled flag)", () => {
  withEnv({ TG_APPROVAL_ENABLED: "false", TG_BOT_TOKEN_OVERRIDE: "own-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("sheets");
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.ownBot, true);
    assert.equal(cfg.botToken, "own-bot-token");
  });
});
