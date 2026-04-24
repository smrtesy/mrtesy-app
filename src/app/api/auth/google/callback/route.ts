import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");

  if (!code || !stateParam) {
    return NextResponse.redirect(`${origin}/he/onboarding?error=no_code`);
  }

  // Validate CSRF nonce
  let service: string;
  let redirectTo: string | null = null;
  try {
    const stateData = JSON.parse(
      Buffer.from(stateParam, "base64url").toString()
    );
    const cookieStore = await cookies();
    const storedNonce = cookieStore.get("oauth_state_nonce")?.value;
    if (!storedNonce || storedNonce !== stateData.nonce) {
      return NextResponse.redirect(
        `${origin}/he/onboarding?error=invalid_state`
      );
    }
    service = stateData.service;
    redirectTo = stateData.redirect || null; // 'settings' when reconnecting
    // Clear the nonce cookie
    cookieStore.delete("oauth_state_nonce");
  } catch {
    return NextResponse.redirect(
      `${origin}/he/onboarding?error=invalid_state`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/he/login`);
  }

  // Determine locale from user settings
  const { data: settings } = await supabase
    .from("user_settings")
    .select("preferred_language")
    .eq("user_id", user.id)
    .single();
  const locale = settings?.preferred_language || "he";

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
    console.error("Token exchange failed:", await tokenResp.text());
    return NextResponse.redirect(
      `${origin}/${locale}/onboarding?error=token_exchange`
    );
  }

  const tokens = await tokenResp.json();
  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  if (service === "gmail_calendar") {
    // Save Gmail credentials
    const { error: gmailErr } = await supabase
      .from("user_credentials")
      .upsert(
        {
          user_id: user.id,
          service: "gmail",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt,
          scopes: ["gmail.modify", "spreadsheets.readonly"],
          email: user.email,
        },
        { onConflict: "user_id,service" }
      );

    // Save Calendar credentials (same token)
    const { error: calErr } = await supabase
      .from("user_credentials")
      .upsert(
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

    if (gmailErr || calErr) {
      console.error("Credential save error:", gmailErr || calErr);
    }

    // Update settings
    await supabase
      .from("user_settings")
      .update({
        gmail_connected: true,
        calendar_connected: true,
        my_emails: [user.email],
      })
      .eq("user_id", user.id);

    // If reconnecting from Settings, go back to Settings
    if (redirectTo === "settings") {
      return NextResponse.redirect(`${origin}/${locale}/settings`);
    }
    return NextResponse.redirect(`${origin}/${locale}/onboarding/drive`);
  }

  if (service === "drive") {
    const { error } = await supabase.from("user_credentials").upsert(
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

    if (error) {
      console.error("Credential save error:", error);
    }

    await supabase
      .from("user_settings")
      .update({ drive_connected: true })
      .eq("user_id", user.id);

    if (redirectTo === "settings") {
      return NextResponse.redirect(`${origin}/${locale}/settings`);
    }
    return NextResponse.redirect(
      `${origin}/${locale}/onboarding/whatsapp`
    );
  }

  if (redirectTo === "settings") {
    return NextResponse.redirect(`${origin}/${locale}/settings`);
  }
  return NextResponse.redirect(`${origin}/${locale}/onboarding`);
}
