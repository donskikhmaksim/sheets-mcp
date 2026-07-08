# oauth-relay

A tiny, **token-blind** Google OAuth relay. It exists so that many people can each
run their own MCP server (on their own Railway, with their own tokens) while the
Google OAuth client needs **only one** registered `redirect_uri`, forever.

## Why

Google only redirects to a pre-registered `redirect_uri`. Every person hosts
their own server on a different random domain, so we can't register each one.
This relay owns the single registered URI and forwards the one-time
authorization `code` back to whichever person's server started the flow.

It **never exchanges the code and never sees any tokens** — the person's own
server does the `code → token` exchange (it holds the Google `client_secret`).
So the machine running the relay has zero standing access to anyone's data.

## Flow

```
person-server ──▶ Google authorize
     redirect_uri = https://<relay-host>/relay/callback
     state        = <b64url(json{r:return_to, n:nonce})>.<hmac-sha256>
Google ──▶ https://<relay-host>/relay/callback?code&state
relay  ──▶ 302 <return_to>/oauth/google/callback?code&state=<nonce>
```

The HMAC (keyed by `RELAY_SECRET`, shared with every person-server) stops the
relay being an open redirector.

## Run

```
RELAY_SECRET=<shared-secret> PORT=8790 node relay.mjs
```

Zero dependencies (Node built-ins only). On the Mac Mini it runs under launchd
(`ai.mcp.oauth-relay.plist`) and is exposed by Tailscale Funnel at
`https://<host>/relay`.

Env:
- `RELAY_SECRET` (required) — shared HMAC secret; also set as `OAUTH_RELAY_SECRET`
  on every person's MCP server.
- `PORT` (default 8790), `HOST` (default 127.0.0.1).
