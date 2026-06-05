import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// Validate redirect path to prevent open redirects
function sanitizeRedirect(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    return "/";
  }
  return path;
}

async function redirectUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  origin: string,
  next: string,
) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: settings } = await supabase
    .from("user_settings")
    .select("onboarding_completed, preferred_language")
    .eq("user_id", user.id)
    .single();

  const locale = settings?.preferred_language || "he";

  // Super-admins skip the onboarding funnel entirely.
  const { data: superAdminRow } = await supabase
    .from("super_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const adminEmails = (process.env.ADMIN_EMAIL || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isSuperAdmin = !!superAdminRow || adminEmails.includes(user.email?.toLowerCase() || "");

  if (isSuperAdmin) {
    if (!settings) {
      const { error } = await supabase
        .from("user_settings")
        .insert({ user_id: user.id, preferred_language: "he" });
      if (error) console.warn("[auth/callback] user_settings insert (admin path) failed:", error.message);
    }
    // Land super-admins on /tasks like everyone else — /admin is reachable
    // from the sidebar. Daily working surface > ops dashboard on every device.
    const redirectPath = next === "/" ? `/${locale}/tasks` : next;
    return NextResponse.redirect(`${origin}${redirectPath}`);
  }

  // Apply any pending invites for this user atomically — joins each org and
  // grants the per-user apps the inviter chose. SECURITY DEFINER fn, because the
  // web session can't INSERT org_members under RLS. Tolerate its absence so a
  // pre-migration deploy still lets existing users log in.
  const { error: rpcErr } = await supabase.rpc("accept_my_invites");
  if (rpcErr) console.error("[auth/callback] accept_my_invites failed:", rpcErr.message);

  // Membership is authorization: a user is allowed in if they belong to any org
  // — via an invite just accepted above, or added directly by an admin.
  const { data: membership, error: membershipErr } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  // Fail safe: if the membership lookup itself errored we can't tell whether the
  // user is a legitimate member — bounce to a retryable system error rather than
  // wrongly telling a real member "no invite".
  if (membershipErr) {
    console.error("[auth/callback] membership lookup failed:", membershipErr.message);
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/he/login?error=system_error`);
  }

  // Brand-new user (no user_settings row): allowed in only if they belong to an org.
  if (!settings) {
    if (!membership) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/he/login?error=no_invite`);
    }

    const { error: settingsErr } = await supabase
      .from("user_settings")
      .insert({ user_id: user.id, preferred_language: "he" });
    if (settingsErr) {
      console.error("[auth/callback] user_settings insert failed:", settingsErr.message);
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/he/login?error=system_error`);
    }

    return NextResponse.redirect(`${origin}/${locale}/onboarding`);
  }

  // Existing user but onboarding not finished.
  if (!settings.onboarding_completed) {
    const target = membership ? "onboarding" : "onboarding/organization";
    return NextResponse.redirect(`${origin}/${locale}/${target}`);
  }

  const redirectPath = next === "/" ? `/${locale}` : next;
  return NextResponse.redirect(`${origin}${redirectPath}`);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = sanitizeRedirect(searchParams.get("next") ?? "/");

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const redirect = await redirectUser(supabase, origin, next);
      if (redirect) return redirect;
    } else {
      console.error("[auth/callback] exchangeCodeForSession error:", error.message);
      const redirect = await redirectUser(supabase, origin, next);
      if (redirect) return redirect;
    }
  }

  return NextResponse.redirect(`${origin}/he/login`);
}
