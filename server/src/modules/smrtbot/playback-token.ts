/**
 * smrtBot — playback token (HMAC-signed, dependency-free).
 *
 * A short-lived token appended to the /watch link so a verified subscriber's
 * video plays directly with no login. The same secret (app_secrets slug
 * "smrtbot", key VIDEO_TOKEN_SECRET) verifies it on the player / stream route.
 * Uses Node's built-in crypto so it works identically on the Express server
 * and a Next.js route — no extra dependency.
 *
 * Format:  base64url(payloadJson) "." base64url(HMAC_SHA256(payloadB64))
 */
import crypto from "crypto";
import { getAppSecret } from "../../db";

export interface PlaybackClaims {
  v: string; // video number / id
  e: string; // subscriber email (lowercased)
  c: string | null; // external customer id
  j: string; // unique token id (jti) — for the per-link use limit
  o: string; // org id — to attribute the view
  b: string | null; // bot id
  iat: number; // issued-at (epoch seconds)
  exp: number; // expiry (epoch seconds)
}

const DEFAULT_TTL_SEC = 60 * 60 * 6; // 6h

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function secret(): Promise<string | null> {
  return getAppSecret("smrtbot", "VIDEO_TOKEN_SECRET", "VIDEO_TOKEN_SECRET");
}

function sign(payloadB64: string, key: string): string {
  return b64url(crypto.createHmac("sha256", key).update(payloadB64).digest());
}

/** Build a signed token. Returns null if no signing secret is configured. */
export async function signPlaybackToken(
  claims: Pick<PlaybackClaims, "v" | "e" | "c" | "o" | "b">,
  ttlSec = DEFAULT_TTL_SEC,
): Promise<string | null> {
  const key = await secret();
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  const full: PlaybackClaims = { ...claims, j: crypto.randomUUID(), iat: now, exp: now + ttlSec };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  return `${payloadB64}.${sign(payloadB64, key)}`;
}

/** Verify a token. Returns claims if the signature is valid and unexpired. */
export async function verifyPlaybackToken(token: string): Promise<PlaybackClaims | null> {
  const key = await secret();
  if (!key || !token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64, key);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const claims = JSON.parse(fromB64url(payloadB64).toString("utf8")) as PlaybackClaims;
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
