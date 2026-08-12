#!/usr/bin/env node
/**
 * Route-level gate on `GET /pending-consents` / `POST /pending-consents/decide`
 * (`src/http.ts`, `TZ_consent_web_hub.md` §2 п.3). Covers the ТЗ test-plan
 * items 7/8: without a `CONSENT_HUB_SECRET`, or with a wrong one, both routes
 * must answer 404 (not 401/403 — don't confirm the route exists), and no
 * store call happens; with the correct secret the guard passes through to
 * the real handler (which then fails on "Store not initialised" here, since
 * this test never calls `initStore()` — that failure IS the proof the guard
 * let the request through, same technique `test-tg-webhook-gate.mjs` uses
 * for `/tg/webhook`).
 *
 * Real process + real `fetch()`, no mocked store: this test is specifically
 * about the AUTH GATE in front of the routes, which the offline
 * `test-consent-hub.mjs` (pure `decideConsentHubItem`/`listPendingConsentsCore`
 * logic) cannot exercise since it never touches Express/http.ts at all.
 *
 * Usage: node scripts/test-consent-hub-gate.mjs  (after `npm run build`)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REAL_SECRET = "hub-secret-abc123xyz";

async function runWorker() {
  const scenario = process.env.CH_TEST_WORKER; // "no-secret" | "wrong-secret" | "right-secret"
  const port = Number(process.env.CH_TEST_PORT);

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

  const headerFor = {
    "no-secret": {},
    "wrong-secret": { "x-consent-hub-secret": "totally-wrong" },
    "right-secret": { "x-consent-hub-secret": REAL_SECRET },
  }[scenario];

  const getRes = await fetch(`http://127.0.0.1:${port}/pending-consents`, { headers: headerFor });
  const postRes = await fetch(`http://127.0.0.1:${port}/pending-consents/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headerFor },
    body: JSON.stringify({ manifestId: "fake-gate-test", decision: "confirm" }),
  });

  console.error = origConsoleError;

  // "Guard let it through" is proven by the handler REACHING store.getManifest
  // and throwing "Store not initialised" (no initStore() call in this worker),
  // logged by http.ts's try/catch as "GET /pending-consents error:" /
  // "POST /pending-consents/decide error:". Absence of those lines is the
  // "guard blocked it, handler body never ran" proof for the 404 scenarios.
  const reachedHandler =
    loggedErrors.some((l) => l.includes("GET /pending-consents error:")) ||
    loggedErrors.some((l) => l.includes("POST /pending-consents/decide error:"));

  process.stdout.write(
    JSON.stringify({ scenario, getStatus: getRes.status, postStatus: postRes.status, reachedHandler }) + "\n",
  );
  process.exit(0);
}

function runOrchestrator() {
  let failures = 0;
  const check = (label, cond, extra = "") => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
    if (!cond) failures++;
  };

  function spawnScenario(scenario, port, hubSecretEnv) {
    const result = spawnSync(process.execPath, [THIS_FILE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CH_TEST_WORKER: scenario,
        CH_TEST_PORT: String(port),
        DATABASE_URL: "",
        ...(hubSecretEnv === null ? { CONSENT_HUB_SECRET: "" } : { CONSENT_HUB_SECRET: hubSecretEnv }),
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

  console.log("\n[Тест 8] CONSENT_HUB_SECRET не задан → 404 на ОБОИХ роутах, handler не вызывается");
  {
    const r = spawnScenario("no-secret", 35010, null);
    check("worker вернул результат", !!r, "worker crashed or printed no JSON");
    if (r) {
      check("GET /pending-consents → 404", r.getStatus === 404, r.getStatus);
      check("POST /pending-consents/decide → 404", r.postStatus === 404, r.postStatus);
      check("handler НЕ вызывался (стор не тронут)", r.reachedHandler === false, r.reachedHandler);
    }
  }

  console.log("\n[Тест 7] CONSENT_HUB_SECRET задан, но заголовок неверный → 404 (не 401/403 — не подтверждаем существование роута)");
  {
    const r = spawnScenario("wrong-secret", 35011, REAL_SECRET);
    check("worker вернул результат", !!r, "worker crashed or printed no JSON");
    if (r) {
      check("GET /pending-consents → 404", r.getStatus === 404, r.getStatus);
      check("POST /pending-consents/decide → 404", r.postStatus === 404, r.postStatus);
      check("handler НЕ вызывался", r.reachedHandler === false, r.reachedHandler);
    }
  }

  console.log("\n[контроль] верный секрет → гейт пропускает, handler РЕАЛЬНО вызывается (не сломан навсегда)");
  {
    const r = spawnScenario("right-secret", 35012, REAL_SECRET);
    check("worker вернул результат", !!r, "worker crashed or printed no JSON");
    if (r) {
      check("GET /pending-consents НЕ 404 (дошло до стора, упало на 'Store not initialised')", r.getStatus !== 404, r.getStatus);
      check("POST /pending-consents/decide НЕ 404", r.postStatus !== 404, r.postStatus);
      check("handler РЕАЛЬНО вызывался (стор дошёл до реальной попытки чтения)", r.reachedHandler === true, r.reachedHandler);
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

if (process.env.CH_TEST_WORKER) {
  await runWorker();
} else {
  runOrchestrator();
}
