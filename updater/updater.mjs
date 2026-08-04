#!/usr/bin/env node
/**
 * Token-only auto-updater. Runs on a Railway cron schedule (see railway.json),
 * does its work, and exits — Railway restarts it on the next tick.
 *
 * WHY THIS EXISTS: Railway's native GitHub-webhook auto-deploy requires its
 * GitHub App to be explicitly authorized (a multi-click, per-account,
 * sometimes-flaky flow — see "GitHub Repo not found" in the dashboard when
 * it isn't). Forking each repo per person to make that work added its own
 * pile of problems (self-fork bugs, gh account juggling, sync workflows).
 * This sidesteps all of it: no fork, no GitHub App, no webhook. It just
 * POLLS the public upstream repo for its latest commit and, if the deployed
 * service is behind, redeploys it itself via `railway up` — the exact same
 * mechanism setup.sh already uses and that's already proven to work.
 *
 * The two tokens below are the ONLY manual, one-time, unautomatable step
 * (verified: neither Railway nor GitHub expose an API to mint a NEW token —
 * both are dashboard-only, no way around it):
 *   RAILWAY_TOKEN  - Railway account/workspace token (railway.com/account/tokens)
 *   GITHUB_TOKEN   - GitHub PAT, zero scopes needed, just for the 5000/hr
 *                    quota (public-repo reads need no scope at all) since
 *                    unauthenticated requests are capped at 60/hr PER IP,
 *                    and Railway's free-tier egress IPs are shared across
 *                    many unrelated users/projects — collisions are real.
 *
 * SERVICES env var: JSON array of {"service": "<railway service name>",
 * "repo": "owner/repo"} — one entry per service this updater watches.
 */

const PROJECT_ID = process.env.PROJECT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SERVICES = JSON.parse(process.env.SERVICES || "[]");

if (!PROJECT_ID) { console.error("Missing PROJECT_ID"); process.exit(1); }
if (!GITHUB_TOKEN) { console.error("Missing GITHUB_TOKEN"); process.exit(1); }
if (!SERVICES.length) { console.error("Missing/empty SERVICES"); process.exit(1); }
// RAILWAY_TOKEN itself isn't read directly here — the `railway` CLI picks it
// up from the environment on its own (confirmed: it recognizes RAILWAY_TOKEN
// as a project-scoped credential natively, no --token flag needed).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

async function latestUpstreamSha(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "mcp-updater",
      Accept: "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`GitHub ${repo} -> HTTP ${r.status}`);
  const json = await r.json();
  if (!json.sha) throw new Error(`GitHub ${repo}: no sha in response`);
  return json.sha;
}

function currentDeployedSha(service) {
  let out;
  try {
    out = sh("railway", ["variables", "--service", service, "--kv", "-p", PROJECT_ID, "-e", "production"]);
  } catch (e) {
    console.error(`${service}: couldn't read variables (${e.message}) — treating as unknown, will redeploy.`);
    return null;
  }
  const m = out.match(/^LAST_DEPLOYED_SHA=(.+)$/m);
  return m ? m[1].trim() : null;
}

function deployFreshCode(service, repo) {
  const tmp = mkdtempSync(join(tmpdir(), `${service}-`));
  try {
    sh("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, "."], { cwd: tmp, stdio: "inherit" });
    const sha = sh("git", ["rev-parse", "HEAD"], { cwd: tmp }).trim();
    sh("railway", ["up", "--service", service, "-p", PROJECT_ID, "-e", "production", "--detach"], { cwd: tmp, stdio: "inherit" });
    // Stamp AFTER a successful up — если деплой упал, следующий тик снова попробует.
    sh("railway", [
      "variables", "set", `LAST_DEPLOYED_SHA=${sha}`,
      "--service", service, "-p", PROJECT_ID, "-e", "production", "--skip-deploys",
    ]);
    return sha;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`updater: checking ${SERVICES.length} service(s)...`);
  let updated = 0, failed = 0;
  for (const { service, repo } of SERVICES) {
    try {
      const upstream = await latestUpstreamSha(repo);
      const deployed = currentDeployedSha(service);
      if (deployed === upstream) {
        console.log(`${service}: up to date (${upstream.slice(0, 12)})`);
        continue;
      }
      console.log(`${service}: ${deployed ? deployed.slice(0, 12) : "unknown"} -> ${upstream.slice(0, 12)}, deploying...`);
      deployFreshCode(service, repo);
      console.log(`${service}: deployed ${upstream.slice(0, 12)}`);
      updated++;
    } catch (e) {
      console.error(`${service}: ERROR ${e.message}`);
      failed++;
    }
  }
  console.log(`updater: done — ${updated} updated, ${failed} failed, ${SERVICES.length - updated - failed} already current.`);
  if (failed > 0) process.exitCode = 1;
}

main();
