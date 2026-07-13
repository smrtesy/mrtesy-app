/**
 * requireAuth — verifies the Supabase JWT in `Authorization: Bearer <token>`
 * and attaches `req.user = { id, email }` on success.
 *
 * Verification order (fastest first):
 *   1. Local HS256 signature check against SUPABASE_JWT_SECRET — no network.
 *   2. Short-lived in-process cache of previous getUser() results.
 *   3. db.auth.getUser(token) — the remote GoTrue round-trip (original path).
 *
 * The remote path stays as the fallback, so a missing or rotated secret can
 * never lock users out — it just costs the extra network hop.
 *
 * Revocation trade-off (standard for stateless JWTs): a locally-verified
 * token is accepted until its own exp (Supabase access tokens default to
 * 1 hour), and a cached remote result for up to 5 minutes — sign-out, bans,
 * and user deletion take effect only after that window. Shorten the access
 * token TTL in the Supabase dashboard to narrow it.
 *
 * Use this on any route that needs an authenticated user.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { TtlCache } from "../lib/ttl-cache";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenCache = new TtlCache<{ id: string; email: string | null }>(TOKEN_CACHE_TTL_MS);

function decodeB64urlJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify an HS256 Supabase access token locally. Returns the user shape on a
 * valid signature + unexpired token, null on anything else (wrong alg,
 * malformed, expired, bad signature) — null means "fall through", not 401.
 */
function verifyLocal(token: string): { id: string; email: string | null } | null {
  if (!JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = decodeB64urlJson(parts[0]);
  if (!header || header.alg !== "HS256") return null;

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

  const payload = decodeB64urlJson(parts[1]);
  if (!payload || typeof payload.sub !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  // Only user access tokens — rejects other secret-signed tokens (anon/service
  // keys, storage URL tokens) that would otherwise pass the signature check.
  if (payload.role !== "authenticated") return null;

  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  // 1. Local signature verification — zero round-trips.
  const local = verifyLocal(token);
  if (local) {
    req.user = local;
    return next();
  }

  // 2. A recent successful getUser() for this exact token.
  const cached = tokenCache.get(token);
  if (cached) {
    req.user = cached;
    return next();
  }

  // 3. Remote fallback — the original behavior.
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
  const payload = decodeB64urlJson(token.split(".")[1] ?? "");
  const expMs = typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
  if (expMs === 0 || expMs > Date.now() + TOKEN_CACHE_TTL_MS) {
    tokenCache.set(token, req.user);
  }

  next();
}
