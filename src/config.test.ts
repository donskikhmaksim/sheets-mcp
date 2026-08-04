import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

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
