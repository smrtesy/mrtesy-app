/**
 * requireAuth — verifies the Supabase JWT in `Authorization: Bearer <token>`
 * and attaches `req.user = { id, email }` on success.
 *
 * Verification order (fastest first):
 *   1. Local asymmetric check (ES256/RS256) against the project's public
 *      JWKS — fetched once and cached 10 minutes, so verification itself
 *      costs no network. This is the active path: the Supabase project uses
 *      JWT signing keys (ES256), so no shared secret is needed.
 *   2. Local HS256 check against SUPABASE_JWT_SECRET (legacy projects only).
 *   3. Short-lived in-process cache of previous getUser() results.
 *   4. db.auth.getUser(token) — the remote GoTrue round-trip (original path).
 *
 * The remote path stays as the fallback, so an unreachable JWKS endpoint or
 * a rotated key can never lock users out — it just costs the network hop.
 *
 * Revocation trade-off (standard for stateless JWTs): a locally-verified
 * token is accepted until its own exp (Supabase access tokens default to
 * 1 hour), and a cached remote result for up to 5 minutes — sign-out, bans,
 * and user deletion take effect only after that window. Shorten the access
 * token TTL in the Supabase dashboard to narrow it.
 *
 * Use this on any route that needs an authenticated user.
 */

import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { TtlCache } from "../lib/ttl-cache";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenCache = new TtlCache<{ id: string; email: string | null }>(TOKEN_CACHE_TTL_MS);

type AuthedUser = { id: string; email: string | null };

function decodeB64urlJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Shared claim checks for every locally-verified token. */
function claimsToUser(payload: Record<string, unknown> | null): AuthedUser | null {
  if (!payload || typeof payload.sub !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  // Only user access tokens — rejects other project-signed tokens (anon/service
  // keys, storage URL tokens) that would otherwise pass the signature check.
  if (payload.role !== "authenticated") return null;
  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

// ── JWKS (asymmetric signing keys) ──────────────────────────────────────────
// The public keys live at /auth/v1/.well-known/jwks.json. Cached in-process;
// refreshed every 10 minutes, or once per minute at most when a token names an
// unknown kid (covers key rotation without letting bad tokens spam refetches).

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_FORCE_MIN_INTERVAL_MS = 60 * 1000;
// Back-off between attempts while the endpoint is failing, so an outage past
// the TTL doesn't turn into a fetch per request.
const JWKS_RETRY_INTERVAL_MS = 60 * 1000;
let jwksKeys = new Map<string, KeyObject>();
let jwksFetchedAt = 0;
let jwksLastAttemptAt = 0;
let jwksLastForceAt = 0;
let jwksInflight: Promise<void> | null = null;

function fetchJwks(): Promise<void> {
  if (jwksInflight) return jwksInflight;
  jwksLastAttemptAt = Date.now();
  jwksInflight = (async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid !== "string") continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
        } catch {
          // skip unsupported key types
        }
      }
      if (next.size) {
        jwksKeys = next;
        jwksFetchedAt = Date.now();
      }
    } catch {
      // network hiccup — keep whatever keys we have; remote fallback covers us
    } finally {
      jwksInflight = null;
    }
  })();
  return jwksInflight;
}

async function getJwksKey(kid: string): Promise<KeyObject | null> {
  if (SUPABASE_URL === "") return null;
  if (
    Date.now() - jwksFetchedAt >= JWKS_TTL_MS &&
    Date.now() - jwksLastAttemptAt >= JWKS_RETRY_INTERVAL_MS
  ) {
    await fetchJwks();
  }
  const hit = jwksKeys.get(kid);
  if (hit) return hit;
  // Unknown kid — maybe the key just rotated. Refetch, rate-limited.
  if (Date.now() - jwksLastForceAt >= JWKS_FORCE_MIN_INTERVAL_MS) {
    jwksLastForceAt = Date.now();
    await fetchJwks();
    return jwksKeys.get(kid) ?? null;
  }
  return null;
}

/**
 * Verify an ES256/RS256 Supabase access token against the cached JWKS.
 * Returns the user on success, null on anything else — null means "fall
 * through to the next verification tier", not 401.
 */
async function verifyAsymmetric(parts: string[], header: Record<string, unknown>): Promise<AuthedUser | null> {
  const alg = header.alg;
  if ((alg !== "ES256" && alg !== "RS256") || typeof header.kid !== "string") return null;
  const key = await getJwksKey(header.kid);
  if (!key) return null;

  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  let ok = false;
  try {
    ok =
      alg === "ES256"
        ? // JWT ES256 signatures are raw r||s, not DER.
          cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
        : cryptoVerify("sha256", data, key, signature);
  } catch {
    return null;
  }
  if (!ok) return null;

  return claimsToUser(decodeB64urlJson(parts[1]));
}

/** Verify a legacy HS256 token against SUPABASE_JWT_SECRET. */
function verifyHs256(parts: string[], header: Record<string, unknown>): AuthedUser | null {
  if (!JWT_SECRET || header.alg !== "HS256") return null;

  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }

  return claimsToUser(decodeB64urlJson(parts[1]));
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const parts = token.split(".");
  const header = parts.length === 3 ? decodeB64urlJson(parts[0]) : null;

  if (header) {
    // 1. Asymmetric signing keys (the project's active setup) — local verify.
    const asym = await verifyAsymmetric(parts, header);
    if (asym) {
      req.user = asym;
      return next();
    }

    // 2. Legacy shared-secret projects.
    const hs = verifyHs256(parts, header);
    if (hs) {
      req.user = hs;
      return next();
    }
  }

  // 3. A recent successful getUser() for this exact token.
  const cached = tokenCache.get(token);
  if (cached) {
    req.user = cached;
    return next();
  }

  // 4. Remote fallback — the original behavior.
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = {
    id: data.user.id,
    email: data.user.email ?? null,
  };

  // Cache until the token's own exp, capped at TOKEN_CACHE_TTL_MS. TtlCache
  // applies the cap; skip caching entirely if the token expires sooner.
  const payload = decodeB64urlJson(parts[1] ?? "");
  const expMs = typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
  if (expMs === 0 || expMs > Date.now() + TOKEN_CACHE_TTL_MS) {
    tokenCache.set(token, req.user);
  }

  next();
}
