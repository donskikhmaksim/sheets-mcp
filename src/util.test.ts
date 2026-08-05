import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithLimit, safeText } from "./util.js";

// Covers the throttle fix: sheets_create's Promise.all fan-out was replaced
// with mapWithLimit(items, fn, limit) so a large batch can't fire every
// Sheets API call at once. These tests exercise the shared helper directly
// rather than sheets_create's full consent-gate plumbing (mocked elsewhere in
// scripts/test-sheets-gate.mjs), since the concurrency cap and retry are
// generic behaviour of the helper, not specific to any one tool.

test("mapWithLimit: never runs more than `limit` calls concurrently", async () => {
  const limit = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await mapWithLimit(
    items,
    async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i * 2;
    },
    limit,
  );
  assert.ok(maxInFlight <= limit, `max concurrent calls was ${maxInFlight}, expected <= ${limit}`);
  assert.deepEqual(results, items.map((i) => i * 2), "results preserve input order despite concurrent execution");
});

test("mapWithLimit: default limit is 8 when not specified", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 30 }, (_, i) => i);
  await mapWithLimit(items, async (i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return i;
  });
  assert.ok(maxInFlight <= 8, `max concurrent calls was ${maxInFlight}, expected <= 8 (default)`);
});

test("mapWithLimit: retries a call that throws a 429-shaped error, then succeeds", async () => {
  let calls = 0;
  const results = await mapWithLimit([1], async () => {
    calls++;
    if (calls < 3) {
      const err: { code: number; message: string } = { code: 429, message: "rate limit exceeded" };
      throw err;
    }
    return "ok";
  }, 1);
  assert.equal(calls, 3, "should have retried twice before succeeding on the 3rd attempt");
  assert.deepEqual(results, ["ok"]);
});

test("mapWithLimit: does NOT retry a non-retriable error (e.g. 400)", async () => {
  let calls = 0;
  await assert.rejects(
    mapWithLimit([1], async () => {
      calls++;
      const err: { code: number; message: string } = { code: 400, message: "invalid request" };
      throw err;
    }, 1),
  );
  assert.equal(calls, 1, "a non-retriable error must not be retried");
});

test("mapWithLimit: gives up after 3 attempts on a persistently retriable error", async () => {
  let calls = 0;
  await assert.rejects(
    mapWithLimit([1], async () => {
      calls++;
      const err: { code: number; message: string } = { code: 503, message: "service unavailable" };
      throw err;
    }, 1),
  );
  assert.equal(calls, 3, "should attempt exactly 3 times (1 + 2 retries) before giving up");
});

test("safeText: still strips legend emoji and clamps length (regression guard, unrelated to this change)", () => {
  assert.equal(safeText("✅ done", 20), "done");
  assert.equal(safeText("x".repeat(200), 10), "xxxxxxxxx…");
});
