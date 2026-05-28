import { google } from "googleapis";
import { db } from "../db";

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
      // `invalid_grant` is Google's permanent error — refresh_token was
      // revoked (user removed app access, inactivity timeout, scope change,
      // etc.). Wipe the credential row so connection indicators flip to
      // "disconnected" instead of staying green forever. Transient errors
      // (network, 5xx) just bubble up; we leave the row alone.
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid_grant/i.test(msg)) {
        await db.from("user_credentials").delete().eq("id", c.id);
      }
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
  }

  return oauth2Client;
}
