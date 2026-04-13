import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state"); // 'gmail_calendar' | 'drive'

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/he/onboarding?error=no_code`);
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/he/login`);
  }

  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error("Token exchange failed:", err);
    return NextResponse.redirect(
      `${origin}/he/onboarding?error=token_exchange`
    );
  }

  const tokens = await tokenResp.json();
  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  if (state === "gmail_calendar") {
    // Save Gmail credentials
    await supabase.from("user_credentials").upsert(
      {
        user_id: user.id,
        service: "gmail",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        scopes: ["gmail.modify"],
        email: user.email,
      },
      { onConflict: "user_id,service" }
    );

    // Save Calendar credentials (same token)
    await supabase.from("user_credentials").upsert(
      {
        user_id: user.id,
        service: "google_calendar",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        scopes: ["calendar"],
        email: user.email,
      },
      { onConflict: "user_id,service" }
    );

    // Update settings
    await supabase
      .from("user_settings")
      .update({
        gmail_connected: true,
        calendar_connected: true,
        my_emails: [user.email],
      })
      .eq("user_id", user.id);

    return NextResponse.redirect(`${origin}/he/onboarding/drive`);
  }

  if (state === "drive") {
    await supabase.from("user_credentials").upsert(
      {
        user_id: user.id,
        service: "google_drive",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        scopes: ["drive.readonly"],
        email: user.email,
      },
      { onConflict: "user_id,service" }
    );

    await supabase
      .from("user_settings")
      .update({ drive_connected: true })
      .eq("user_id", user.id);

    return NextResponse.redirect(`${origin}/he/onboarding/whatsapp`);
  }

  return NextResponse.redirect(`${origin}/he/onboarding`);
}
