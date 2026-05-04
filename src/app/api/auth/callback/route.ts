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

  if (!settings) {
    await supabase.from("user_settings").insert({ user_id: user.id, preferred_language: "he" });
    return NextResponse.redirect(`${origin}/he/onboarding`);
  }

  if (!settings.onboarding_completed) {
    return NextResponse.redirect(`${origin}/${locale}/onboarding`);
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
