import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOwnerAllowlist } from "./oauthProvider.js";

test("OWNER_EMAILS unset => new account never blocked (fail-open)", () => {
  assert.doesNotThrow(() => checkOwnerAllowlist("new@example.com", false, undefined));
});

test("new account, email NOT in allowlist => rejected", () => {
  assert.throws(() => checkOwnerAllowlist("new@example.com", false, ["owner@example.com"]));
});

test("new account, email in allowlist (case-insensitive) => allowed", () => {
  assert.doesNotThrow(() => checkOwnerAllowlist("Owner@Example.com", false, ["owner@example.com"]));
});

test("ALREADY-linked account, email not in allowlist => never blocked", () => {
  assert.doesNotThrow(() => checkOwnerAllowlist("someone-else@example.com", true, ["owner@example.com"]));
});

test("empty allowlist array => treated as unset (fail-open)", () => {
  assert.doesNotThrow(() => checkOwnerAllowlist("new@example.com", false, []));
});
