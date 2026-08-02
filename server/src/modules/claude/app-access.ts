/**
 * App access for a Claude run — "גישה לשימוש רגיל באפליקציה".
 *
 * A run gets a REAL, short-lived Supabase session for the user who launched it,
 * injected into the child environment. With it the run can call the platform's own
 * API exactly the way the frontend does (Authorization: Bearer + X-Org-Id), so it
 * can check what actually works instead of reasoning about the code alone.
 *
 * HOW: the dev-login pattern (src/app/api/dev-login/route.ts) — generateLink
 * (magiclink) + verifyOtp with the service role key mints a session server-side
 * with no password involved. The token is a normal user access token: it passes
 * requireAuth like any browser session and expires on its own (Supabase default
 * 1h), which comfortably covers a single run (15-minute ceiling). Every turn mints
 * a fresh one, so long conversations never hold a stale token.
 *
 * SCOPE: the run acts as the launching user — no privilege it doesn't already
 * have. The launch routes are superadmin-gated, so this widens nothing.
 *
 * ISOLATION: a THROWAWAY client per mint, never the shared `db` client —
 * verifyOtp sets the session on the client that called it, and doing that to the
 * shared service-role client would silently downgrade every later query in the
 * process to the minted user's permissions.
 */

import path from "node:path";
import { createClient } from "@supabase/supabase-js";

/**
 * Where the compiled browser helper lives — next to this file in dist. One
 * constant, exported, because THREE places must agree on the LITERAL text:
 * the env var the runner injects, the --allowedTools rule that pre-approves
 * running it (the permission matcher compares literal command text, so the
 * rule and the instruction must use the same absolute path), and the preamble
 * line that tells the agent the exact command to type.
 */
export const BROWSER_HELPER_PATH = path.join(__dirname, "browser-helper.js");

export interface AppAccess {
  token: string;
  url: string;
  /** Auth for a REAL browser session against the Next.js app — null when the
   *  frontend URL isn't known to this deployment. */
  browser: BrowserAccess | null;
}

export interface BrowserAccess {
  /** The Next.js app origin the browser should open (e.g. https://app.smrtesy.com). */
  appUrl: string;
  /** Cookies that log the browser in as the user, in the exact format the app's
   *  own @supabase/ssr client writes and reads. */
  cookies: { name: string; value: string }[];
}

/**
 * Serialize a Supabase session into the cookie(s) the app's browser client
 * reads. The format is pinned to the installed libraries, verified from their
 * source, not from docs:
 *
 *   - cookie name:  `sb-<ref>-auth-token` where <ref> is the first hostname
 *     label of the Supabase URL (@supabase/supabase-js dist/index.cjs:369).
 *   - cookie value: `base64-` + base64url(JSON of the session)
 *     (@supabase/ssr dist/main/cookies.js — BASE64_PREFIX + stringToBase64URL).
 *   - chunking: values whose encodeURIComponent form exceeds 3180 chars are
 *     split into `<name>.0`, `<name>.1`, … (@supabase/ssr utils/chunker.js).
 *     base64url output is URI-safe (no % escapes), so plain slicing at 3180
 *     matches the library's algorithm exactly.
 */
export function sessionCookies(
  supabaseUrl: string,
  session: object,
): { name: string; value: string }[] {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const MAX_CHUNK_SIZE = 3180; // @supabase/ssr utils/chunker.js:8
  if (encodeURIComponent(value).length <= MAX_CHUNK_SIZE) return [{ name, value }];
  const chunks: { name: string; value: string }[] = [];
  for (let i = 0; i * MAX_CHUNK_SIZE < value.length; i++) {
    chunks.push({ name: `${name}.${i}`, value: value.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE) });
  }
  return chunks;
}

/**
 * Where the app frontend lives, from this deployment's own configuration:
 * an explicit SMRTESY_APP_URL wins; otherwise the first https origin of
 * FRONTEND_URL (the CORS allowlist in index.ts — already required to name the
 * app for browsers to talk to this backend at all); otherwise
 * `https://app.<APP_DOMAIN>` (the platform host in the multi-tenant model).
 */
function resolveAppUrl(): string | null {
  const explicit = (process.env.SMRTESY_APP_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit.startsWith("https://") || explicit.startsWith("http://")) return explicit;
  const fromCors = (process.env.FRONTEND_URL ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .find((o) => o.startsWith("https://"));
  if (fromCors) return fromCors;
  const domain = (process.env.APP_DOMAIN ?? process.env.NEXT_PUBLIC_APP_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (domain && !domain.includes("localhost")) return `https://app.${domain}`;
  return null;
}

/** Mint a short-lived app session for `userId`. Returns null on ANY failure —
 *  app access is an enhancement; its absence must never fail the run. */
export async function mintAppAccess(userId: string): Promise<AppAccess | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiUrl = (process.env.SMRTESY_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!supabaseUrl || !serviceKey || !apiUrl) return null;

  try {
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: uErr } = await admin.auth.admin.getUserById(userId);
    const email = userData?.user?.email;
    if (uErr || !email) return null;

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError || !linkData) return null;

    const { data: session, error: verifyError } = await admin.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    if (verifyError || !session.session) return null;

    // Browser login: the SAME session, serialized into the cookie the app's
    // @supabase/ssr client reads. The refresh token rides along inside it — the
    // app's middleware may refresh near expiry, and it is revoked with the rest
    // of the session when the run ends (revokeAppAccess, scope 'local').
    const appUrl = resolveAppUrl();
    const browser: BrowserAccess | null = appUrl
      ? { appUrl, cookies: sessionCookies(supabaseUrl, session.session) }
      : null;

    return { token: session.session.access_token, url: apiUrl, browser };
  } catch (e) {
    console.error("[claude/app-access] mint failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface BrowserSession {
  /** The minted user access token (JWT) — same value carried inside the cookies. */
  token: string;
  /** The app auth cookie(s), ready to install into a browser context. */
  cookies: { name: string; value: string }[];
}

/**
 * Mint a short-lived REAL session for `userId` and serialize it into the app's
 * auth cookie — the same generateLink+verifyOtp path as mintAppAccess, but WITHOUT
 * the `browser`-field gate on resolveAppUrl(). A locally-run copy of the frontend
 * (page-check: driving the *changed* branch as the logged-in user) points the
 * browser at localhost, so the frontend origin the backend happens to know is
 * irrelevant — only the cookie name/value (a project-scoped JWT) matter, and
 * sessionCookies() needs just the Supabase URL. Returns null on ANY failure.
 */
export async function mintSessionCookies(userId: string): Promise<BrowserSession | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  try {
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: uErr } = await admin.auth.admin.getUserById(userId);
    const email = userData?.user?.email;
    if (uErr || !email) return null;

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError || !linkData) return null;

    const { data: session, error: verifyError } = await admin.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    if (verifyError || !session.session) return null;

    return {
      token: session.session.access_token,
      cookies: sessionCookies(supabaseUrl, session.session),
    };
  } catch (e) {
    console.error("[claude/app-access] mintSessionCookies failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Revoke a minted session once its run ended, so long conversations don't
 * accumulate live auth sessions (one per turn, each valid ~1h).
 *
 * Scope 'local' — ONLY the session behind this JWT. The default ('global') would
 * revoke every session the user has, logging them out of their own browser
 * because a chat turn finished. Best-effort: an unrevoked session just expires.
 */
export async function revokeAppAccess(token: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return;
  try {
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.auth.admin.signOut(token, "local");
  } catch {
    // Expires on its own.
  }
}
