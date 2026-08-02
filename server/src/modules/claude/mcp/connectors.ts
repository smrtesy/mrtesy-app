/**
 * Connector wiring for the in-app Claude console: Google Drive + Canva as MCP
 * servers the run can call, each fed a fresh access token per turn.
 *
 * Both official remote MCP servers (drivemcp.googleapis.com, mcp.canva.com)
 * require an INTERACTIVE browser OAuth on first connect and document no
 * bearer-token/header path — unusable from this headless, non-interactive
 * (`claude -p`) runner. So we run our own small stdio MCP servers
 * (gdrive-server.ts / canva-server.ts) and hand each one a token we mint here:
 *
 *   - Drive : reuse the Google OAuth the launching user already granted the
 *             platform (user_credentials, service google_drive) — full
 *             `auth/drive` scope, so read+write. Per-user, zero new setup.
 *   - Canva : one shared Canva Connect account. A refresh token lives in
 *             app_secrets (slug smrtstudio); we exchange it for an access token,
 *             cached process-wide (~4h) to avoid churning Canva's ROTATING
 *             refresh tokens on every run.
 *
 * Every mint is best-effort and returns null on any failure — a connector the
 * operator hasn't set up (or a user who never connected Drive) just means that
 * server isn't registered for the run, never a failed turn.
 */

import path from "node:path";
import { db, getAppSecret, invalidateAppSecretCache } from "../../../db";
import { getOAuthClient } from "../../../services/token-refresh";

export const GDRIVE_TOKEN_ENV = "SMRTESY_GDRIVE_TOKEN";
export const CANVA_TOKEN_ENV = "SMRTESY_CANVA_TOKEN";

export type ConnectorName = "gdrive" | "canva";

/** Compiled server entrypoints, resolved next to this file in dist (same trick
 *  as BROWSER_HELPER_PATH). The Claude engine launches these with `node`. */
export const GDRIVE_SERVER_PATH = path.join(__dirname, "gdrive-server.js");
export const CANVA_SERVER_PATH = path.join(__dirname, "canva-server.js");

/** The app slug under which Canva's shared credentials live in app_secrets. */
const CANVA_SLUG = "smrtstudio";

/**
 * Mint a Google Drive access token for `userId` by reusing the OAuth grant they
 * already gave the platform. getOAuthClient refreshes proactively and persists,
 * so the returned token is valid for at least the next few minutes (runs are
 * ≤15 min). Returns null if the user never connected Drive.
 */
export async function mintDriveToken(userId: string): Promise<string | null> {
  try {
    const client = await getOAuthClient(userId, "drive");
    const token = client.credentials.access_token ?? null;
    return token || null;
  } catch {
    // "No credentials found …" (user hasn't connected Drive) or a refresh
    // failure — either way the connector is simply unavailable this turn.
    return null;
  }
}

// Process-wide cache of the Canva access token. The backend is a single
// long-lived Railway process, so caching here means we hit Canva's token
// endpoint (and rotate its refresh token) only ~once per token lifetime instead
// of once per run — which also sidesteps the concurrent-refresh race that
// rotating refresh tokens are prone to.
let canvaCache: { token: string; expiresAt: number } | null = null;
let canvaInFlight: Promise<string | null> | null = null;
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const SKEW_MS = 5 * 60 * 1000;

/**
 * Mint (or return a cached) Canva Connect access token from the shared refresh
 * token in app_secrets. Returns null when Canva isn't configured yet.
 */
export async function mintCanvaToken(): Promise<string | null> {
  if (canvaCache && canvaCache.expiresAt - Date.now() > SKEW_MS) return canvaCache.token;
  if (canvaInFlight) return canvaInFlight;
  canvaInFlight = refreshCanvaToken().finally(() => {
    canvaInFlight = null;
  });
  return canvaInFlight;
}

async function refreshCanvaToken(): Promise<string | null> {
  let clientId: string | null;
  let clientSecret: string | null;
  let refreshToken: string | null;
  try {
    [clientId, clientSecret, refreshToken] = await Promise.all([
      getAppSecret(CANVA_SLUG, "CANVA_CLIENT_ID", "CANVA_CLIENT_ID"),
      getAppSecret(CANVA_SLUG, "CANVA_CLIENT_SECRET", "CANVA_CLIENT_SECRET"),
      getAppSecret(CANVA_SLUG, "CANVA_REFRESH_TOKEN"),
    ]);
  } catch (e) {
    // Fail closed like mintDriveToken — a secret-read error means "Canva not
    // available this turn", never a thrown mint that fails the whole run.
    console.error("[claude/connectors] reading Canva secrets failed:", e instanceof Error ? e.message : e);
    return null;
  }
  if (!clientId || !clientSecret || !refreshToken) return null;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  let res: Response;
  try {
    res = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (e) {
    console.error("[claude/connectors] Canva token request failed:", e instanceof Error ? e.message : e);
    return null;
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`[claude/connectors] Canva token exchange HTTP ${res.status}: ${text.slice(0, 500)}`);
    return null;
  }
  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("[claude/connectors] Canva token response was not JSON");
    return null;
  }
  if (!parsed.access_token) return null;

  const expiresInMs = (parsed.expires_in && parsed.expires_in > 0 ? parsed.expires_in : 3600) * 1000;
  canvaCache = { token: parsed.access_token, expiresAt: Date.now() + expiresInMs };

  // Canva rotates refresh tokens: the response carries a NEW one and invalidates
  // the old. Persisting it is REQUIRED — miss it and the connector breaks on the
  // next token lifetime. Best-effort with a loud error if it fails.
  if (parsed.refresh_token && parsed.refresh_token !== refreshToken) {
    try {
      await persistCanvaRefreshToken(parsed.refresh_token);
    } catch (e) {
      // A failed persist BRICKS the shared connector: Canva already invalidated
      // the old refresh token when it issued this one, so the next refresh
      // (~4h) gets invalid_grant until someone re-runs canva-connect.mjs. That
      // is exactly the kind of silent invariant break the repo says to put a
      // detector on — so surface it as a level='error' log row (the
      // error-notification trigger alerts super-admins, and the daily
      // health-check groups level='error' by category), not a lone stderr line.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[claude/connectors] failed to persist rotated Canva refresh token:", msg);
      const { error: logErr } = await db.from("log_entries").insert({
        level: "error",
        category: "canva_connector",
        status: "failed",
        error_message: `Canva refresh-token rotation not persisted — the connector will break until re-authorized: ${msg}`.slice(0, 1000),
      });
      if (logErr) console.error("[claude/connectors] log_entries insert failed:", logErr.message);
    }
  }
  return parsed.access_token;
}

/**
 * Store the rotated Canva refresh token back into app_secrets (Vault-encrypted),
 * mirroring the admin writeAppSecret secret path (vault_update/create + upsert).
 */
async function persistCanvaRefreshToken(newToken: string): Promise<void> {
  const { data: app } = await db.from("apps").select("id").eq("slug", CANVA_SLUG).maybeSingle();
  if (!app) {
    console.error(`[claude/connectors] cannot persist Canva refresh token: no app row for slug ${CANVA_SLUG}`);
    return;
  }
  const appId = (app as { id: string }).id;
  const { data: existing, error: lookupErr } = await db
    .from("app_secrets")
    .select("value_secret_id")
    .eq("app_id", appId)
    .eq("key", "CANVA_REFRESH_TOKEN")
    .maybeSingle();
  if (lookupErr) throw new Error(`lookup: ${lookupErr.message}`);

  const existingId = (existing?.value_secret_id as string | null | undefined) ?? null;
  let secretId: string | null = existingId;
  if (existingId) {
    const { error } = await db.rpc("vault_update_secret", { secret_id: existingId, new_secret: newToken });
    if (error) throw new Error(`vault update: ${error.message}`);
  } else {
    const { data: created, error } = await db.rpc("vault_create_secret", {
      new_secret: newToken,
      new_name: `app_secret:${CANVA_SLUG}:CANVA_REFRESH_TOKEN`,
      new_description: `Canva Connect refresh token for ${CANVA_SLUG}`,
    });
    if (error) throw new Error(`vault create: ${error.message}`);
    secretId = (created as string | null) ?? null;
  }
  const { error: upsertErr } = await db
    .from("app_secrets")
    .upsert(
      { app_id: appId, key: "CANVA_REFRESH_TOKEN", is_secret: true, value_secret_id: secretId, value_text: null },
      { onConflict: "app_id,key" },
    );
  if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
  invalidateAppSecretCache(CANVA_SLUG, "CANVA_REFRESH_TOKEN");
}

/**
 * Build the `--mcp-config` object and the `--allowedTools` entries for the
 * connector servers that have a token this turn. Server-level allow
 * (`mcp__<name>`) permits all of that server's tools, matching how WebSearch/
 * WebFetch are allowed for plain (non-repo) threads.
 */
export function buildConnectorMcpConfig(servers: ConnectorName[]): {
  config: { mcpServers: Record<string, { command: string; args: string[] }> };
  allow: string[];
} {
  const pathFor: Record<ConnectorName, string> = {
    gdrive: GDRIVE_SERVER_PATH,
    canva: CANVA_SERVER_PATH,
  };
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const s of servers) mcpServers[s] = { command: "node", args: [pathFor[s]] };
  return { config: { mcpServers }, allow: servers.map((s) => `mcp__${s}`) };
}
