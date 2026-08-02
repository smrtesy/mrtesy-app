#!/usr/bin/env node
/**
 * One-time Canva Connect authorization helper for the in-app Claude connector.
 *
 * The in-app Claude Canva connector uses ONE shared Canva account. Canva's
 * refresh token comes from a standard OAuth2 authorization-code + PKCE flow that
 * needs a human to consent in a browser exactly once. This script runs that flow
 * locally and prints the refresh token to store in app_secrets — after which the
 * backend mints access tokens on its own (server/src/modules/claude/mcp/
 * connectors.ts), and no human is in the loop again until the grant is revoked.
 *
 * PREREQUISITES (do these once, in the Canva Developer portal —
 * https://www.canva.com/developers/integrations):
 *   1. Create an integration. Copy its Client ID and generate a Client secret.
 *   2. Add this exact Redirect URL:  http://127.0.0.1:8910/callback
 *      (or set PORT below and register the matching URL).
 *   3. Grant the integration these scopes:
 *        design:content:read design:content:write design:meta:read
 *        asset:read asset:write folder:read folder:write
 *        brandtemplate:meta:read brandtemplate:content:read profile:read
 *
 * RUN:
 *   CANVA_CLIENT_ID=xxx CANVA_CLIENT_SECRET=yyy node server/scripts/canva-connect.mjs
 *
 * Then open the printed URL, approve, and copy the printed CANVA_REFRESH_TOKEN
 * into  /admin/apps/smrtstudio/secrets  (also store CANVA_CLIENT_ID and
 * CANVA_CLIENT_SECRET there). Requires no dependencies — Node 18+ built-ins only.
 */

import http from "node:http";
import crypto from "node:crypto";

const CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 8910);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  "design:content:read",
  "design:content:write",
  "design:meta:read",
  "asset:read",
  "asset:write",
  "folder:read",
  "folder:write",
  "brandtemplate:meta:read",
  "brandtemplate:content:read",
  "profile:read",
].join(" ");

const AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing CANVA_CLIENT_ID / CANVA_CLIENT_SECRET in the environment.");
  console.error("Run: CANVA_CLIENT_ID=xxx CANVA_CLIENT_SECRET=yyy node server/scripts/canva-connect.mjs");
  process.exit(1);
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const codeVerifier = b64url(crypto.randomBytes(96));
const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl =
  `${AUTHORIZE_URL}?response_type=code` +
  `&client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&code_challenge=${codeChallenge}` +
  `&code_challenge_method=S256` +
  `&state=${state}`;

async function exchange(code) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}): ${text}`);
  return JSON.parse(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(`Canva returned an error: ${error}`);
    console.error("\n❌ Canva returned an error:", error);
    server.close();
    process.exit(1);
  }
  if (!code || returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("State mismatch or missing code.");
    console.error("\n❌ State mismatch or missing code — start over.");
    server.close();
    process.exit(1);
  }

  try {
    const tokens = await exchange(code);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(
      "Canva connected. You can close this tab and return to the terminal.",
    );
    console.log("\n✅ Canva authorized. Store these in /admin/apps/smrtstudio/secrets :\n");
    console.log("CANVA_CLIENT_ID     =", CLIENT_ID);
    console.log("CANVA_CLIENT_SECRET =", "(the secret you already have)");
    console.log("CANVA_REFRESH_TOKEN =", tokens.refresh_token);
    console.log("\n(access_token expires in", tokens.expires_in, "seconds — the backend refreshes it automatically.)");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(e));
    console.error("\n❌", e instanceof Error ? e.message : e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Canva Connect — one-time authorization");
  console.log("Redirect URL (must be registered in the Canva integration):", REDIRECT_URI);
  console.log("\n1) Open this URL in your browser and approve:\n");
  console.log(authUrl);
  console.log("\n2) After approving, the token prints here automatically.\n");
});
