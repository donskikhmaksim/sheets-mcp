import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLegacyOrOnboardingUser } from "./http.js";
import type { User } from "./config.js";

const envUser: User = {
  name: "default",
  token: "tok",
  accounts: [{ name: "default", auth: { mode: "oauth", clientId: "c", clientSecret: "s", refreshToken: "dead" } }],
  defaultAccount: "default",
};
const emptyLegacyUser: User = { name: "onboarding", token: "tok", accounts: [], defaultAccount: "" };
const onboardingUser: User = {
  name: "me@gmail.com",
  accounts: [{ name: "personal", auth: { mode: "oauth", clientId: "c", clientSecret: "s", refreshToken: "live" } }],
  defaultAccount: "personal",
};

test("onboarding disabled => env/legacy user passes through untouched", async () => {
  const result = await selectLegacyOrOnboardingUser(envUser, false, async () => {
    throw new Error("must not be called when onboarding is disabled");
  });
  assert.equal(result, envUser);
});

test("onboarding enabled + Postgres has linked accounts => onboarding user preferred over env/legacy", async () => {
  const result = await selectLegacyOrOnboardingUser(envUser, true, async () => onboardingUser);
  assert.equal(result, onboardingUser);
});

test("onboarding enabled + nothing linked in Postgres => falls back to env/legacy user", async () => {
  const result = await selectLegacyOrOnboardingUser(envUser, true, async () => null);
  assert.equal(result, envUser);
});

test("onboarding enabled + nothing linked + legacy user has no accounts either => fails closed (null)", async () => {
  const result = await selectLegacyOrOnboardingUser(emptyLegacyUser, true, async () => null);
  assert.equal(result, null);
});
