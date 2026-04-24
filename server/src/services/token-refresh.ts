import { google } from "googleapis";
import { db } from "../db";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);

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

  oauth2Client.setCredentials({
    access_token: c.access_token,
    refresh_token: c.refresh_token ?? undefined,
    expiry_date: c.expires_at ? new Date(c.expires_at).getTime() : undefined,
  });

  // Refresh proactively if within 5 minutes of expiry
  const expiresAt = c.expires_at ? new Date(c.expires_at).getTime() : 0;
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
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
