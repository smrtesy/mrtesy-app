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

  // Brand-new user (no user_settings row): must have a valid invite.
  if (!settings) {
    const { data: invites } = await supabase
      .from("org_invites")
      .select("id, org_id, role")
      .eq("email", user.email?.toLowerCase() ?? "")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1);

    const invite = invites?.[0] ?? null;

    if (!invite) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/he/login?error=no_invite`);
    }

    // Valid invite: create settings, join org, mark invite accepted.
    const { error: settingsErr } = await supabase
      .from("user_settings")
      .insert({ user_id: user.id, preferred_language: "he" });
    if (settingsErr) {
      console.error("[auth/callback] user_settings insert failed:", settingsErr.message);
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/he/login?error=system_error`);
    }

    const { error: memberErr } = await supabase
      .from("org_members")
      .insert({ org_id: invite.org_id, user_id: user.id, role: invite.role, invited_by: null });
    if (memberErr && memberErr.code !== "23505") {
      // 23505 = duplicate key: user was already added to this org manually, treat as success
      console.error("[auth/callback] org_members insert failed:", memberErr.message);
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/he/login?error=system_error`);
    }

    const { error: acceptErr } = await supabase
      .from("org_invites")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invite.id);
    if (acceptErr) console.warn("[auth/callback] invite accept failed:", acceptErr.message);

    return NextResponse.redirect(`${origin}/${locale}/onboarding`);
  }

  // Existing user: check for a pending invite (they may be joining a new org).
  const { data: pendingInvites } = await supabase
    .from("org_invites")
    .select("id, org_id, role")
    .eq("email", user.email?.toLowerCase() ?? "")
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  const pendingInvite = pendingInvites?.[0] ?? null;

  if (pendingInvite) {
    const { error: memberErr } = await supabase
      .from("org_members")
      .insert({ org_id: pendingInvite.org_id, user_id: user.id, role: pendingInvite.role, invited_by: null });
    if (memberErr && memberErr.code !== "23505") {
      console.error("[auth/callback] org_members insert (existing user) failed:", memberErr.message);
    }
    const { error: acceptErr } = await supabase
      .from("org_invites")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", pendingInvite.id);
    if (acceptErr) console.warn("[auth/callback] invite accept (existing user) failed:", acceptErr.message);
  }

  // Existing user but onboarding not finished.
  if (!settings.onboarding_completed) {
    const { data: membership } = await supabase
      .from("org_members")
      .select("org_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
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
