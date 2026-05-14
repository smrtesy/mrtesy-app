import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// Validate redirect path to prevent open redirects
function sanitizeRedirect(path: string): string {
  // Must start with / and not start with // (protocol-relative URL)
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    return "/";
  }
  return path;
}

async function redirectUser(supabase: Awaited<ReturnType<typeof createClient>>, origin: string, next: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: settings } = await supabase
    .from("user_settings")
    .select("onboarding_completed, preferred_language")
    .eq("user_id", user.id)
    .single();

  const locale = settings?.preferred_language || "he";

  // Super-admins skip the onboarding funnel entirely — they may be signing in
  // to manage the platform, not to use any product app.
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
    const redirectPath = next === "/" ? `/${locale}/admin` : next;
    return NextResponse.redirect(`${origin}${redirectPath}`);
  }

  // Brand-new user (no user_settings row): create defaults + send to workspace creation step.
  if (!settings) {
    const { error } = await supabase
      .from("user_settings")
      .insert({ user_id: user.id, preferred_language: "he" });
    if (error) console.warn("[auth/callback] user_settings insert (regular path) failed:", error.message);
    return NextResponse.redirect(`${origin}/he/onboarding/organization`);
  }

  // Existing user but onboarding not finished — if they don't yet belong to an org,
  // route through the workspace step first so all subsequent screens have an org context.
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
      // PKCE exchange failed — check if user has a valid existing session
      console.error("[auth/callback] exchangeCodeForSession error:", error.message);
      const redirect = await redirectUser(supabase, origin, next);
      if (redirect) return redirect;
    }
  }

  // No code and no session — back to login
  return NextResponse.redirect(`${origin}/he/login`);
}
