import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

// This route sets auth cookies and must never be cached or statically evaluated.
export const dynamic = "force-dynamic";

/**
 * GET /api/preview?token=<uuid>&locale=<he|en>
 *
 * Consumes a one-time member-preview token (created by the owner/admin-gated
 * backend route POST /api/org/members/:userId/preview-link) and signs THIS
 * browser window in as that member — a faithful preview of what the employee
 * will see. Designed to be opened in an incognito window so it does not clobber
 * the manager's own session (cookies are per-browser-profile).
 *
 * Security: the token is unguessable, single-use, expires in 5 minutes, and was
 * only ever issued to an owner/admin for a member of their own org. Possessing
 * it authorizes the session mint — the same trust model as a magic link. The
 * mint runs here (not the backend) because the frontend already holds the
 * service-role key, and the cookies must be set on the app's own origin.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token") ?? "";
  const locale = searchParams.get("locale") === "en" ? "en" : "he";
  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/${locale}/login?error=${reason}`);

  if (!token) return fail("preview_missing");

  const admin = createAdminSupabaseClient();
  if (!admin) {
    console.error("[api/preview] service-role key not configured");
    return fail("preview_unavailable");
  }

  // Consume the token atomically: the `used_at is null` + `expires_at > now`
  // predicates mean a second click, an expired link, or an unknown token all
  // update zero rows and land here as invalid.
  const { data: consumed, error: consumeErr } = await admin
    .from("member_preview_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("token", token)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("target_user_id")
    .maybeSingle();
  if (consumeErr) {
    console.error("[api/preview] token consume failed:", consumeErr.message);
    return fail("preview_error");
  }
  if (!consumed) return fail("preview_invalid");

  const targetUserId = consumed.target_user_id as string;

  // Mint a real session for the target user with no password: generateLink
  // (magiclink) yields a hashed token, verifyOtp exchanges it for a session.
  // Same pattern as the Claude console's app-access mint. `admin` is a throwaway
  // per-request client; verifyOtp binds the session to it and it is discarded.
  const { data: userData, error: uErr } = await admin.auth.admin.getUserById(targetUserId);
  const email = userData?.user?.email;
  if (uErr || !email) {
    console.error("[api/preview] target user has no email / lookup failed:", uErr?.message);
    return fail("preview_error");
  }

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData) {
    console.error("[api/preview] generateLink failed:", linkErr?.message);
    return fail("preview_error");
  }

  const { data: verified, error: verifyErr } = await admin.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyErr || !verified.session) {
    console.error("[api/preview] verifyOtp failed:", verifyErr?.message);
    return fail("preview_error");
  }

  // Write the session into the app's own auth cookies on THIS response, exactly
  // like /api/auth/callback does after exchangeCodeForSession. In an incognito
  // window this is a clean, isolated login as the employee.
  const supabase = await createClient();
  const { error: setErr } = await supabase.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  if (setErr) {
    console.error("[api/preview] setSession failed:", setErr.message);
    return fail("preview_error");
  }

  // Land on the locale home; the app routes on from there (onboarding vs /tasks)
  // exactly as it would for the employee's real first sign-in.
  return NextResponse.redirect(`${origin}/${locale}`);
}
