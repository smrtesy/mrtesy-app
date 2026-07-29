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

import { createClient } from "@supabase/supabase-js";

export interface AppAccess {
  token: string;
  url: string;
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

    return { token: session.session.access_token, url: apiUrl };
  } catch (e) {
    console.error("[claude/app-access] mint failed:", e instanceof Error ? e.message : e);
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
