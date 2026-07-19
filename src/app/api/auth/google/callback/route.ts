import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
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
  let stateOrgId: string | null = null;
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
    stateOrgId = stateData.org_id || null;   // smrtReach inbox: the owning org
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
      redirect_uri: `${origin}/api/auth/google/callback`,
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

  // Resolve the Google account that just authorized — this may differ from the
  // Supabase signup email when the user OAuths a different Google account.
  // Falls back to the signup email on any failure so we never block onboarding.
  let connectedEmail: string = user.email ?? "";
  try {
    const uiResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (uiResp.ok) {
      const ui = (await uiResp.json()) as { email?: string };
      if (ui.email) connectedEmail = ui.email;
    }
  } catch (e) {
    console.warn("[google-callback] userinfo lookup failed:", e);
  }

  if (service === "reach_gmail") {
    // Independent smrtReach sending inbox — org-owned, stored via the
    // service-role admin client (smrtreach_gmail_accounts is service-role only).
    const admin = createAdminSupabaseClient();
    const back = (q: string) => NextResponse.redirect(`${origin}/${locale}/reach/settings?${q}`);
    if (!admin) return back("error=server");

    // Resolve the owning org from state (the subdomain cookie), but ONLY trust
    // it if the authenticated user actually belongs to that org — otherwise a
    // forged smrt_org_id cookie could write an inbox into someone else's org
    // (this table is service-role and bypasses RLS). Fall back to the user's
    // first membership.
    let resolvedOrg: string | null = null;
    if (stateOrgId) {
      const { data: mem } = await admin
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .eq("org_id", stateOrgId)
        .maybeSingle();
      if (mem) resolvedOrg = stateOrgId;
    }
    if (!resolvedOrg) {
      const { data: m } = await admin
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .order("joined_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      resolvedOrg = (m?.org_id as string) ?? null;
    }
    if (!resolvedOrg) return back("error=no_org");

    // Without a refresh token we can't send long-term (Google omits it when the
    // user already granted without prompt=consent — we force consent, so this
    // is rare, but guard anyway).
    if (!tokens.refresh_token) return back("error=no_refresh");

    const inbox = connectedEmail.toLowerCase();

    // Master-list sender row (provider gmail), one per org+email.
    const { data: senderRow, error: senderErr } = await admin
      .from("smrtreach_senders")
      .upsert(
        { org_id: resolvedOrg, created_by: user.id, email: inbox, provider: "gmail" },
        { onConflict: "org_id,email" },
      )
      .select("id")
      .single();
    if (senderErr || !senderRow) return back("error=save");

    // Create or rotate the Vault secret holding the refresh token.
    const { data: existingAcct } = await admin
      .from("smrtreach_gmail_accounts")
      .select("refresh_token_secret_id")
      .eq("org_id", resolvedOrg)
      .eq("email", inbox)
      .maybeSingle();

    let secretId: string | null = (existingAcct?.refresh_token_secret_id as string | null) ?? null;
    if (secretId) {
      await admin.rpc("vault_update_secret", { secret_id: secretId, new_secret: tokens.refresh_token });
    } else {
      const { data: created } = await admin.rpc("vault_create_secret", {
        new_secret: tokens.refresh_token,
        new_name: `reach_gmail_refresh:${resolvedOrg}:${inbox}:${Date.now()}`,
        new_description: `smrtReach Gmail refresh token for ${inbox}`,
      });
      secretId = (created as string | null) ?? null;
    }
    if (!secretId) return back("error=save");

    const { error: acctErr } = await admin
      .from("smrtreach_gmail_accounts")
      .upsert(
        {
          org_id: resolvedOrg,
          sender_id: senderRow.id as string,
          created_by: user.id,
          email: inbox,
          refresh_token_secret_id: secretId,
          access_token: tokens.access_token,
          expires_at: expiresAt,
          scopes: ["gmail.send"],
          disabled: false,
          last_error: null,
        },
        { onConflict: "org_id,email" },
      );
    if (acctErr) return back("error=save");

    return back("connected=1");
  }

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
          email: connectedEmail,
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
          email: connectedEmail,
        },
        { onConflict: "user_id,service" }
      );

    if (gmailErr || calErr) {
      console.error("Credential save error:", gmailErr || calErr);
    }
    // Only flag a service as connected when its credential upsert actually
    // succeeded — a failed save must not produce a "connected" account with
    // no tokens. Gmail and Calendar share one grant but are stored as two
    // rows, so a partial failure marks only the surviving service.
    const connectedFlags: Record<string, boolean> = {};
    if (!gmailErr) connectedFlags.gmail_connected = true;
    if (!calErr) connectedFlags.calendar_connected = true;

    // Update settings. my_emails is the set of addresses the user considers
    // "themselves" — used for identity hints, not scan scope. Merge the newly
    // connected Google account into the existing list (case-insensitive
    // dedup) so reconnecting Gmail never wipes manually added aliases.
    const { data: existing } = await supabase
      .from("user_settings")
      .select("my_emails")
      .eq("user_id", user.id)
      .maybeSingle();
    const prior: string[] = Array.isArray(existing?.my_emails)
      ? (existing!.my_emails as unknown[]).filter(
          (e): e is string => typeof e === "string" && e.length > 0,
        )
      : [];
    const merged = connectedEmail
      ? Array.from(
          new Map(
            [...prior, connectedEmail].map((e) => [e.toLowerCase(), e]),
          ).values(),
        )
      : prior;

    const { error: settingsUpdateErr } = await supabase
      .from("user_settings")
      .update({
        ...connectedFlags,
        my_emails: merged,
      })
      .eq("user_id", user.id);
    if (settingsUpdateErr) {
      console.error("[google-callback] gmail_calendar user_settings update failed:", settingsUpdateErr);
    }

    // Surface the failed save to the user instead of redirecting as success.
    if (gmailErr || calErr) {
      const dest =
        redirectTo === "settings" ? "settings" :
        redirectTo === "account" ? "account" :
        "onboarding";
      return NextResponse.redirect(`${origin}/${locale}/${dest}?error=save_failed`);
    }

    // If reconnecting from Settings/Account, return there instead of
    // restarting the onboarding flow.
    if (redirectTo === "settings") {
      return NextResponse.redirect(`${origin}/${locale}/settings`);
    }
    if (redirectTo === "account") {
      return NextResponse.redirect(`${origin}/${locale}/account`);
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
        scopes: ["drive"],
        email: connectedEmail,
      },
      { onConflict: "user_id,service" }
    );

    if (error) {
      // A failed save must not produce a "connected" Drive with no tokens —
      // skip the drive_connected flag and surface the failure to the user.
      console.error("Credential save error:", error);
      const dest =
        redirectTo === "settings" ? "settings" :
        redirectTo === "account" ? "account" :
        "onboarding";
      return NextResponse.redirect(`${origin}/${locale}/${dest}?error=save_failed`);
    }

    const { error: driveSettingsErr } = await supabase
      .from("user_settings")
      .update({ drive_connected: true })
      .eq("user_id", user.id);
    if (driveSettingsErr) {
      console.error("[google-callback] drive user_settings update failed:", driveSettingsErr);
    }

    if (redirectTo === "settings") {
      return NextResponse.redirect(`${origin}/${locale}/settings`);
    }
    if (redirectTo === "account") {
      return NextResponse.redirect(`${origin}/${locale}/account`);
    }
    // First-time onboarding: route to the folder picker so the user
    // actually selects what to scan before WhatsApp. Without this step
    // we'd land them on WhatsApp with an empty drive_folder_ids and
    // never sync anything — silent dead end.
    return NextResponse.redirect(
      `${origin}/${locale}/onboarding/drive/folders`
    );
  }

  if (redirectTo === "settings") {
    return NextResponse.redirect(`${origin}/${locale}/settings`);
  }
  return NextResponse.redirect(`${origin}/${locale}/onboarding`);
}
