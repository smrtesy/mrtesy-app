import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Check if onboarding is completed
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data: settings } = await supabase
          .from("user_settings")
          .select("onboarding_completed")
          .eq("user_id", user.id)
          .single();

        // Create user_settings if not exists
        if (!settings) {
          await supabase.from("user_settings").insert({
            user_id: user.id,
            preferred_language: "he",
          });
          return NextResponse.redirect(`${origin}/he/onboarding`);
        }

        if (!settings.onboarding_completed) {
          return NextResponse.redirect(`${origin}/he/onboarding`);
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Auth error — redirect to login
  return NextResponse.redirect(`${origin}/he/login`);
}
