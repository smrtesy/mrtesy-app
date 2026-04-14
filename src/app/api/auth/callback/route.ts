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

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = sanitizeRedirect(searchParams.get("next") ?? "/");

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data: settings } = await supabase
          .from("user_settings")
          .select("onboarding_completed, preferred_language")
          .eq("user_id", user.id)
          .single();

        const locale = settings?.preferred_language || "he";

        // Create user_settings if not exists
        if (!settings) {
          await supabase.from("user_settings").insert({
            user_id: user.id,
            preferred_language: "he",
          });
          return NextResponse.redirect(`${origin}/he/onboarding`);
        }

        if (!settings.onboarding_completed) {
          return NextResponse.redirect(`${origin}/${locale}/onboarding`);
        }

        // Use locale-aware redirect
        const redirectPath = next === "/" ? `/${locale}` : next;
        return NextResponse.redirect(`${origin}${redirectPath}`);
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/he/login`);
}
