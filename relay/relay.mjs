#!/usr/bin/env node
/**
 * Token-blind Google OAuth relay.
 *
 * WHY: TickTick/Google only allow OAuth redirects to a *pre-registered*
 * redirect_uri. Every person hosts their own MCP server on their own Railway
 * with a different random domain, so we cannot register each one. Instead this
 * single relay owns the ONE registered redirect_uri (registered once, forever)
 * and forwards the one-time authorization `code` back to whichever person's
 * server started the flow.
 *
 * TOKEN-BLIND: this relay NEVER exchanges the code and NEVER sees tokens. It
 * only relays the short-lived, single-use `code`. The person's own server does
 * the code->token exchange itself (it holds the Google client_secret). So the
 * machine running this relay (Maksim's Mac Mini) has zero standing access to
 * anyone's Gmail/Drive — which is the whole point.
 *
 * FLOW:
 *   person-server -> Google authorize
 *        redirect_uri = https://<relay-host>/relay/callback
 *        state        = <b64url(json{r:return_to, n:nonce})>.<hmac-sha256>
 *   Google -> https://<relay-host>/relay/callback?code=..&state=..
 *   relay  -> verify HMAC, 302 -> <return_to>/oauth/google/callback?code=..&state=<nonce>
 *
 * The HMAC (keyed by RELAY_SECRET, shared with every person-server) stops the
 * relay being an open redirector: it only forwards to return_to values a real
 * person-server signed.
 *
 * Env:
 *   RELAY_SECRET  (required)  shared HMAC secret, also baked into each server
 *   PORT          (default 8790)
 *   HOST          (default 127.0.0.1)
 */
import http from "node:http";
import crypto from "node:crypto";

const SECRET = (process.env.RELAY_SECRET || "").trim();
if (!SECRET) {
  console.error("FATAL: RELAY_SECRET is required");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";

/** Verify `<payload>.<sig>` and return the decoded {r, n} or null. */
function verifyState(state) {
  if (typeof state !== "string") return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expect = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof obj.r !== "string" || typeof obj.n !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

function bad(res, msg) {
  res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
  res.end(msg);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return bad(res, "bad request");
  }

  // Accept with or without the `/relay` prefix so it works whether the fronting
  // proxy (Tailscale Funnel / Caddy) strips the mount path or forwards it whole.
  const path = url.pathname.replace(/^\/relay(?=\/|$)/, "") || "/";

  if (path === "/health" || path === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (path === "/callback") {
    const decoded = verifyState(url.searchParams.get("state") || "");
    if (!decoded) return bad(res, "Invalid or unsigned OAuth state — start the connection again.");

    let ret;
    try {
      ret = new URL(decoded.r);
    } catch {
      return bad(res, "Bad return target.");
    }
    if (ret.protocol !== "https:") return bad(res, "return target must be https.");

    const base = decoded.r.replace(/\/+$/, "");
    const fwd = new URL(base + "/oauth/google/callback");
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) fwd.searchParams.set("error", error);
    if (code) fwd.searchParams.set("code", code);
    fwd.searchParams.set("state", decoded.n);

    res.writeHead(302, { Location: fwd.toString() });
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.error(`oauth-relay listening on ${HOST}:${PORT}`);
});
