#!/usr/bin/env node
/**
 * TG_WEBHOOK_OWNER route-level gate on `/tg/webhook` (src/http.ts).
 *
 * Ported from gmail-mcp/scripts/test-tg-webhook-gate.mjs per
 * mcp-development-standard (the module + webhook route are copied
 * byte-for-byte-in-shape; only imports/config field names differ between
 * repos). sheets-mcp is NEVER the webhook owner in production (gmail-mcp is
 * — see TG_WEBHOOK_OWNER's doc-comment in src/config.ts) — this test proves
 * the DEFAULT (owner unset/false) refuses the route outright, and (as a
 * control) that flipping the env var on would still work if a deployer ever
 * needed sheets-mcp to be the owner instead.
 *
 * Context: `consumeTgDecisionAnyServer` (store.ts) made webhook *consume*
 * server-agnostic across every MCP server that may eventually share one
 * Telegram bot token, because `manifest_id` is `tg_approvals`' globally-
 * unique PRIMARY KEY. That by itself would leave a hole if `/tg/webhook` were
 * mounted unconditionally: leaking `TG_APPROVAL_WEBHOOK_SECRET` on ANY ONE
 * server would let an attacker decide approvals for every other server too.
 * This test proves the route-level gate: a server that isn't the designated
 * webhook owner (`TG_WEBHOOK_OWNER` unset/false) must refuse the route
 * entirely, even with the CORRECT secret, before the handler runs.
 *
 * Why this file spawns two CHILD PROCESSES instead of just calling
 * `startHttpServer` twice with different config objects: `TG_WEBHOOK_OWNER`
 * is NOT threaded through the `Config` object passed to `startHttpServer` —
 * the route handler closes over the module-level singleton `tgApprovalConfig`
 * (`src/server.ts`), computed ONCE from `process.env` at import time. A
 * single process can only ever observe one value of it. So each scenario
 * below gets its own `node` process with its own env, self-invoking this
 * same file with `TG_TEST_WORKER` set (worker mode), and the parent
 * (orchestrator mode, no env var set) collects + checks the JSON result line
 * each worker prints.
 *
 * Proving "the handler was never called" (not just "got a 404"): the worker
 * never calls `initStore()` (that only happens in `src/index.ts`'s real
 * startup, bypassed here), so `store.ts`'s internal pg Pool is never
 * constructed. If `handleWebhook` -> `consumeTgDecisionAnyServer` is ever
 * actually invoked, it throws "Store not initialised", caught by http.ts's
 * `try { await handleWebhook(...) } catch (err) { console.error("TG
 * approval webhook error:", err); }` -- a distinctive, capturable log line
 * that only exists if execution reached past the gate into the real
 * handler. Absence of that line (owner=false) is the "handler not called"
 * proof; presence of it exactly once (owner=true) is the "handler WAS
 * called" regression proof.
 *
 * Usage: node scripts/test-tg-webhook-gate.mjs  (after `npm run build`)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const BOT_TOKEN = "TESTTOKEN";
const OWNER_CHAT_ID = "555";
const WEBHOOK_SECRET = "wh-secret-xyz";

// ── worker mode: run ONE scenario in this (child) process, print result JSON ──
async function runWorker() {
  const scenario = process.env.TG_TEST_WORKER; // "owner-false" | "owner-true"
  const port = Number(process.env.TG_TEST_PORT);

  const { MockAgent, setGlobalDispatcher } = await import("undici");
  const agent = new MockAgent();
  // Block any un-mocked network call from reaching the real internet (in
  // particular the real api.telegram.org), EXCEPT loopback -- the test's own
  // fetch() to the local server it just started also goes through this same
  // global dispatcher (Node's fetch uses undici under the hood), so 127.0.0.1
  // must stay allowed or the test can't talk to its own server at all.
  agent.disableNetConnect();
  agent.enableNetConnect(/^127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  let setWebhookCalls = 0;
  agent
    .get("https://api.telegram.org")
    .intercept({ path: `/bot${BOT_TOKEN}/setWebhook`, method: "POST" })
    .reply(() => {
      setWebhookCalls++;
      return { statusCode: 200, data: { ok: true, result: true }, headers: { "content-type": "application/json" } };
    })
    .persist();

  const loggedErrors = [];
  const origConsoleError = console.error;
  console.error = (...args) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const { startHttpServer } = await import(new URL("../dist/http.js", import.meta.url));

  const fakeAccount = {
    name: "default",
    auth: { mode: "oauth", clientId: "test-cid", clientSecret: "test-secret", refreshToken: "test-refresh" },
  };
  await startHttpServer({
    transport: "http",
    port,
    requireAuth: false,
    users: [{ name: "default", token: undefined, accounts: [fakeAccount], defaultAccount: "default" }],
    onboarding: { enabled: false },
  });

  // A callback_query that WOULD be processed if the gate let it through:
  // from.id matches TG_OWNER_CHAT_ID and data matches the "a:<manifestId>"
  // regex `handleWebhook` expects (src/tg_approval.ts) -- so if the gate is
  // bypassed, execution reaches consumeTgDecisionAnyServer.
  const res = await fetch(`http://127.0.0.1:${port}/tg/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      callback_query: {
        id: "cbq-gate-test",
        from: { id: Number(OWNER_CHAT_ID) },
        data: "a:fake-manifest-id-gate-test",
        message: { message_id: 1, chat: { id: Number(OWNER_CHAT_ID) } },
      },
    }),
  });

  console.error = origConsoleError;

  const handlerErrorLines = loggedErrors.filter((l) => l.includes("TG approval webhook error:"));
  const reachedStoreNotInitialised = handlerErrorLines.some((l) => l.includes("Store not initialised"));

  process.stdout.write(
    JSON.stringify({
      scenario,
      status: res.status,
      handlerErrorLineCount: handlerErrorLines.length,
      reachedStoreNotInitialised,
      setWebhookCalls,
    }) + "\n",
  );
  process.exit(0);
}

// ── orchestrator mode: spawn both scenarios as children, check their results ──
function runOrchestrator() {
  let failures = 0;
  const check = (label, cond, extra = "") => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
    if (!cond) failures++;
  };

  function spawnScenario(scenario, port, webhookOwnerEnv) {
    const result = spawnSync(process.execPath, [THIS_FILE], {
      encoding: "utf8",
      env: {
        ...process.env,
        TG_TEST_WORKER: scenario,
        TG_TEST_PORT: String(port),
        TG_APPROVAL_ENABLED: "true",
        TG_BOT_TOKEN: BOT_TOKEN,
        TG_OWNER_CHAT_ID: OWNER_CHAT_ID,
        TG_APPROVAL_WEBHOOK_SECRET: WEBHOOK_SECRET,
        PUBLIC_BASE_URL: "https://example.test",
        ...(webhookOwnerEnv === null ? {} : { TG_WEBHOOK_OWNER: webhookOwnerEnv }),
        DATABASE_URL: "",
      },
      timeout: 15_000,
    });
    if (result.status !== 0) {
      console.error(`worker[${scenario}] exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      return null;
    }
    const lastLine = result.stdout.trim().split("\n").filter(Boolean).pop();
    try {
      return JSON.parse(lastLine);
    } catch {
      console.error(`worker[${scenario}] did not print JSON. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      return null;
    }
  }

  // ═══ [a] TG_WEBHOOK_OWNER unset (default false) + CORRECT secret → 404, handler never runs ═══
  console.log("\n[a] webhookOwner НЕ задан (default false) + верный секрет → 404, handler не вызывается");
  {
    const r = spawnScenario("owner-false-default", 34970, null);
    check("worker завершился и вернул результат", !!r, "worker crashed or printed no JSON");
    if (r) {
      check("статус 404", r.status === 404, r.status);
      check(
        "handleWebhook НЕ вызывался (нет ни одной строки 'TG approval webhook error:')",
        r.handlerErrorLineCount === 0,
        r.handlerErrorLineCount,
      );
      check("setWebhook при старте не вызывался (registerWebhook тоже не-owner)", r.setWebhookCalls === 0, r.setWebhookCalls);
    }
  }

  // ═══ [b] TG_WEBHOOK_OWNER=false explicitly + CORRECT secret → 404, handler never runs ═══
  console.log("\n[b] webhookOwner=false ЯВНО + верный секрет → 404, handler не вызывается");
  {
    const r = spawnScenario("owner-false-explicit", 34971, "false");
    check("worker завершился и вернул результат", !!r, "worker crashed or printed no JSON");
    if (r) {
      check("статус 404", r.status === 404, r.status);
      check(
        "handleWebhook НЕ вызывался (нет ни одной строки 'TG approval webhook error:')",
        r.handlerErrorLineCount === 0,
        r.handlerErrorLineCount,
      );
    }
  }

  // ═══ [c] control: TG_WEBHOOK_OWNER=true + CORRECT secret → 200, handler DOES run ═══
  // sheets-mcp is never configured this way in production (gmail-mcp owns
  // the webhook) -- this is a control to prove the gate GATES rather than
  // permanently breaking the route, not a claim about deployed behaviour.
  console.log("\n[c] контроль: webhookOwner=true + верный секрет → 200, handler ВЫЗЫВАЕТСЯ (гейт не сломан навсегда)");
  {
    const r = spawnScenario("owner-true", 34972, "true");
    check("worker завершился и вернул результат", !!r, "worker crashed or printed no JSON");
    if (r) {
      check("статус 200", r.status === 200, r.status);
      check(
        "handleWebhook РЕАЛЬНО вызывался ровно один раз (ровно одна строка 'TG approval webhook error:')",
        r.handlerErrorLineCount === 1,
        r.handlerErrorLineCount,
      );
      check(
        "вызов дошёл до consumeTgDecisionAnyServer (упал на 'Store not initialised', а не раньше)",
        r.reachedStoreNotInitialised === true,
        r,
      );
      check("registerWebhook по-прежнему вызывает setWebhook ровно один раз при старте (happy path не сломан)", r.setWebhookCalls === 1, r.setWebhookCalls);
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

if (process.env.TG_TEST_WORKER) {
  await runWorker();
} else {
  runOrchestrator();
}
