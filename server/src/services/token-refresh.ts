import { google } from "googleapis";
import { db } from "../db";
import { notify } from "../lib/platform/notify";

interface Credentials {
  id: string;
  user_id: string;
  service: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scopes: string[] | null;
  email: string | null;
}

/**
 * Returns a refreshed OAuth2 client for the given user and service.
 * Automatically refreshes the access token if it has expired and persists
 * the new token back to user_credentials.
 */
// Service name mapping: our internal names → DB column values
const SERVICE_MAP: Record<string, string> = {
  gmail_calendar: "gmail",    // gmail + calendar share the same OAuth token
  gmail:          "gmail",
  calendar:       "google_calendar",
  google_calendar: "google_calendar",
  drive:          "google_drive",
  google_drive:   "google_drive",
};

export async function getOAuthClient(userId: string, service: string) {
  const dbService = SERVICE_MAP[service] ?? service;
  const { data: cred, error } = await db
    .from("user_credentials")
    .select("*")
    .eq("user_id", userId)
    .eq("service", dbService)
    .single();

  if (error || !cred) {
    throw new Error(`No credentials found for user ${userId} service ${service}`);
  }

  const c = cred as Credentials;

  // A fresh OAuth2 client per call. A module-level singleton would be
  // shared across concurrent requests (different users AND different
  // services for the same user), and `setCredentials` would race —
  // service B's tokens could overwrite service A's mid-refresh, Google
  // would reject the inconsistent request with `invalid_grant`, and the
  // catch below would DELETE a perfectly valid credential row. That race
  // is exactly how calendar/drive/gmail mysteriously "disconnect" while
  // their refresh_tokens are still good.
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );

  oauth2Client.setCredentials({
    access_token: c.access_token,
    refresh_token: c.refresh_token ?? undefined,
    expiry_date: c.expires_at ? new Date(c.expires_at).getTime() : undefined,
  });

  // Refresh proactively if within 5 minutes of expiry
  const expiresAt = c.expires_at ? new Date(c.expires_at).getTime() : 0;
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    let credentials;
    try {
      const refreshed = await oauth2Client.refreshAccessToken();
      credentials = refreshed.credentials;
    } catch (err) {
      // Log every refresh failure so we can see WHY a service appears
      // disconnected. Without this, non-invalid_grant errors (network
      // blips, Google 5xx, scope mismatches) leave the row intact and
      // the UI silently shows "disconnected" with no breadcrumb.
      const msg = err instanceof Error ? err.message : String(err);
      // Two FAILURE classes that must be handled DIFFERENTLY — conflating them
      // is what made services "disconnect by themselves":
      //
      //   • invalid_grant  — the refresh_token itself is permanently dead
      //     (revoked, expired, or unused too long). Only a fresh OAuth grant
      //     fixes it, so we wipe the row and tell the USER to reconnect.
      //
      //   • invalid_client — the GOOGLE_CLIENT_ID/SECRET *this environment*
      //     sent is not a valid pair for the token's issuing client (a
      //     mismatched/rotated secret across Vercel/Railway/Supabase, a deleted
      //     OAuth client, or a stray newline in the env var). This is OUR
      //     misconfiguration, NOT a dead grant: the user's refresh_token is
      //     still good and resumes the instant the env is corrected. Deleting it
      //     would burn a valid credential and force a pointless reconnect that
      //     breaks again on the very next refresh. So we KEEP the row and let
      //     the level='error' log below alert the platform operators (via the
      //     notify_superadmins_on_error trigger) to fix the config at the source.
      const isRevoked     = /invalid_grant/i.test(msg);
      const isClientConfig = /invalid_client/i.test(msg);
      try {
        await db.from("log_entries").insert({
          user_id: userId,
          level: (isRevoked || isClientConfig) ? "error" : "warning",
          category: "token_refresh",
          status: "failed",
          error_message: `${dbService}: ${msg}`.slice(0, 1000),
        });
      } catch { /* logging is best-effort */ }

      if (isRevoked) {
        // Permanently dead grant → wipe the row so the indicator flips to
        // "disconnected" instead of staying green forever, and notify the user
        // so they actually know to reconnect.
        await db.from("user_credentials").delete().eq("id", c.id);
        await notifyServiceDisconnected(userId, dbService).catch(() => {
          /* notification is best-effort; never block the throw */
        });
      }
      // invalid_client and transient errors (network blips, Google 5xx): leave
      // the credential intact and let the caller's retry / next cron tick try
      // again once the underlying issue clears.
      throw err;
    }
    oauth2Client.setCredentials(credentials);

    await db
      .from("user_credentials")
      .update({
        access_token: credentials.access_token!,
        expires_at: credentials.expiry_date
          ? new Date(credentials.expiry_date).toISOString()
          : null,
      })
      .eq("id", c.id);

    // gmail + google_calendar share the same OAuth grant (issued together
    // in the gmail_calendar callback). When we refresh one, propagate the
    // new access_token to the other so the google_calendar row doesn't
    // drift stale — only the health endpoint refreshes it directly, and
    // historically that path lost the singleton race and never updated
    // the row. Best-effort: a sibling-update failure must not block the
    // primary refresh's success.
    if (dbService === "gmail") {
      try {
        await db
          .from("user_credentials")
          .update({
            access_token: credentials.access_token!,
            expires_at: credentials.expiry_date
              ? new Date(credentials.expiry_date).toISOString()
              : null,
          })
          .eq("user_id", userId)
          .eq("service", "google_calendar");
      } catch { /* sibling sync is best-effort */ }
    }
  }

  return oauth2Client;
}

const SERVICE_LABEL_HE: Record<string, string> = {
  gmail:           "Gmail",
  google_calendar: "Google Calendar",
  google_drive:    "Google Drive",
};

async function notifyServiceDisconnected(userId: string, dbService: string) {
  // Resolve the user's primary org. Mirrors the lookup used by the cron
  // webhook in smrttask/routes/sync.ts.
  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return;

  const label = SERVICE_LABEL_HE[dbService] ?? dbService;
  await notify(membership.org_id as string, userId, {
    app_slug: "smrttask",
    type:     "action_required",
    title:    `${label} התנתק`,
    body:     `החיבור ל-${label} פג תוקף. לחץ כדי להתחבר מחדש — סנכרון לא ירוץ עד שתעשה את זה.`,
    link:     "/account",
  });
}
