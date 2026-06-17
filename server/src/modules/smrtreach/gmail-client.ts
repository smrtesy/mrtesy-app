/**
 * smrtReach — Gmail sender.
 *
 * Two sources of "send from Gmail":
 *   1. INDEPENDENT inboxes the org added explicitly for sending
 *      (smrtreach_gmail_accounts + a paired smrtreach_senders row,
 *      provider='gmail'). Their own OAuth grant; refresh token in Vault.
 *      This is the per-campaign-allocatable path — sendViaReachGmail().
 *   2. LEGACY/fallback: the org members' personal Gmail (user_credentials,
 *      service='gmail') round-robined — sendViaGmail(). Used only when a
 *      campaign has no explicit sender allocation.
 *
 * Each account is capped per day via smrtreach_gmail_quota (keyed by the
 * sending address). The per-address ceiling is smrtreach_senders.daily_cap,
 * falling back to DEFAULT_DAILY_CAP.
 */

import { google } from "googleapis";
import { db } from "../../db";
import { getOAuthClient } from "../../services/token-refresh";

/** Default per-account daily send cap when a sender has no explicit daily_cap. */
export const DEFAULT_DAILY_CAP = 2000;
/** @deprecated kept for the legacy round-robin path; prefer per-sender daily_cap. */
const DAILY_CAP = DEFAULT_DAILY_CAP;

export class NoGmailAccountError extends Error {}
export class GmailQuotaExhaustedError extends Error {}

export interface GmailAccount {
  userId: string;
  email: string;
}

/** Connected Gmail accounts for an org = its members who linked Gmail. */
export async function listOrgGmailAccounts(orgId: string): Promise<GmailAccount[]> {
  const { data: members, error: mErr } = await db
    .from("org_members").select("user_id").eq("org_id", orgId);
  if (mErr) throw new Error(`gmail accounts (members): ${mErr.message}`);
  const userIds = (members ?? []).map((m) => m.user_id as string);
  if (userIds.length === 0) return [];

  const { data: creds, error: cErr } = await db
    .from("user_credentials")
    .select("user_id, email")
    .eq("service", "gmail")
    .in("user_id", userIds)
    .not("refresh_token", "is", null)
    .not("email", "is", null);
  if (cErr) throw new Error(`gmail accounts (creds): ${cErr.message}`);

  // De-dupe by email (a user could appear once per service row).
  const seen = new Set<string>();
  const out: GmailAccount[] = [];
  for (const c of creds ?? []) {
    const email = (c.email as string).toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ userId: c.user_id as string, email });
  }
  return out;
}

/** Today's sent-count per account email for the org. */
async function todaysCounts(orgId: string): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db
    .from("smrtreach_gmail_quota")
    .select("email, sent")
    .eq("org_id", orgId)
    .eq("day", today);
  return new Map((data ?? []).map((r) => [(r.email as string).toLowerCase(), r.sent as number]));
}

/** Pick the under-cap connected account with the fewest sends today (load-balance). */
async function pickAccount(orgId: string): Promise<{ account: GmailAccount | null; anyConnected: boolean }> {
  const accounts = await listOrgGmailAccounts(orgId);
  if (accounts.length === 0) return { account: null, anyConnected: false };
  const counts = await todaysCounts(orgId);
  const available = accounts
    .filter((a) => (counts.get(a.email) ?? 0) < DAILY_CAP)
    .sort((a, b) => (counts.get(a.email) ?? 0) - (counts.get(b.email) ?? 0));
  return { account: available[0] ?? null, anyConnected: true };
}

/** RFC2047-encode a header value that may contain UTF-8 (subject / display name). */
function encodeHeader(value: string): string {
  // ASCII-only stays as-is; otherwise base64 per RFC 2047.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Build a base64url-encoded MIME message for the Gmail API. */
function buildRawMessage(from: string, to: string, subject: string, html: string, replyTo: string | null): string {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  const body = Buffer.from(html, "utf8").toString("base64");
  const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Send one email via an org Gmail account. Picks the account, sends, and
 * increments its daily counter. Throws NoGmailAccountError (none connected) or
 * GmailQuotaExhaustedError (all capped today) so the caller can react.
 */
export async function sendViaGmail(
  orgId: string,
  params: { to: string; subject: string; html: string; replyTo: string | null },
): Promise<{ messageId: string | null; from: string }> {
  const { account, anyConnected } = await pickAccount(orgId);
  if (!account) {
    if (anyConnected) throw new GmailQuotaExhaustedError("all connected Gmail accounts hit the daily cap");
    throw new NoGmailAccountError("no connected Gmail account for this org");
  }

  const auth = await getOAuthClient(account.userId, "gmail");
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildRawMessage(account.email, params.to, params.subject, params.html, params.replyTo);
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  // Best-effort atomic increment of the per-account daily counter.
  const { error } = await db.rpc("smrtreach_gmail_quota_inc", { p_org: orgId, p_email: account.email });
  if (error) console.error("[smrtreach.gmail] quota inc:", error.message);

  return { messageId: res.data.id ?? null, from: account.email };
}

// ============================================================
// INDEPENDENT Gmail inboxes (smrtreach_gmail_accounts) — the
// per-campaign-allocatable path with a per-address daily cap.
// ============================================================

interface ReachGmailAccountRow {
  id: string;
  email: string;
  refresh_token_secret_id: string | null;
  access_token: string | null;
  expires_at: string | null;
  disabled: boolean;
}

/** Today's sent count for a single sending address in this org. */
async function todaysCountForEmail(orgId: string, email: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db
    .from("smrtreach_gmail_quota")
    .select("sent")
    .eq("org_id", orgId)
    .eq("email", email.toLowerCase())
    .eq("day", today)
    .maybeSingle();
  return (data?.sent as number) ?? 0;
}

/**
 * Build a refreshed OAuth2 client for an independent Gmail inbox. The refresh
 * token lives in Vault (refresh_token_secret_id); we resolve it, refresh the
 * access token if stale and persist the new one. A permanently-dead grant
 * (invalid_grant) flips the account to disabled so the UI can prompt a
 * reconnect, and re-throws so the caller stops sending from it.
 */
async function getReachGmailOAuthClient(account: ReachGmailAccountRow) {
  if (!account.refresh_token_secret_id) {
    throw new NoGmailAccountError(`Gmail inbox ${account.email} has no stored refresh token`);
  }
  const { data: refreshToken, error: vErr } = await db.rpc("vault_read_secret", {
    secret_id: account.refresh_token_secret_id,
  });
  if (vErr || typeof refreshToken !== "string" || !refreshToken) {
    throw new NoGmailAccountError(`Gmail inbox ${account.email}: could not read stored token`);
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: account.access_token ?? undefined,
    expiry_date: account.expires_at ? new Date(account.expires_at).getTime() : undefined,
  });

  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    try {
      const refreshed = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed.credentials);
      await db
        .from("smrtreach_gmail_accounts")
        .update({
          access_token: refreshed.credentials.access_token ?? null,
          expires_at: refreshed.credentials.expiry_date
            ? new Date(refreshed.credentials.expiry_date).toISOString()
            : null,
          disabled: false,
          last_error: null,
        })
        .eq("id", account.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid_grant/i.test(msg)) {
        // Dead grant — disable the inbox so the org reconnects it, and surface
        // the failure (do NOT keep trying to send from a revoked account).
        await db
          .from("smrtreach_gmail_accounts")
          .update({ disabled: true, last_error: msg.slice(0, 500) })
          .eq("id", account.id);
        throw new NoGmailAccountError(`Gmail inbox ${account.email}: grant revoked, reconnect required`);
      }
      // Transient/config error — leave the row intact for the next tick.
      throw err;
    }
  }
  return oauth2Client;
}

/**
 * Send one email from a SPECIFIC independent Gmail inbox (the sender the
 * campaign allocated this recipient to). Honors the sender's fixed daily_cap
 * (falling back to DEFAULT_DAILY_CAP). Throws NoGmailAccountError when the
 * inbox is missing/disabled and GmailQuotaExhaustedError when it hit its cap
 * today, so the caller can requeue that one row without stopping the batch.
 */
export async function sendViaReachGmail(
  orgId: string,
  sender: { id: string; email: string; daily_cap: number | null },
  params: { to: string; subject: string; html: string; replyTo: string | null },
): Promise<{ messageId: string | null; from: string }> {
  const { data: account } = await db
    .from("smrtreach_gmail_accounts")
    .select("id, email, refresh_token_secret_id, access_token, expires_at, disabled")
    .eq("org_id", orgId)
    .eq("sender_id", sender.id)
    .maybeSingle();
  if (!account || account.disabled) {
    throw new NoGmailAccountError(`Gmail inbox for sender ${sender.email} is not connected`);
  }

  const cap = sender.daily_cap ?? DEFAULT_DAILY_CAP;
  const sentToday = await todaysCountForEmail(orgId, sender.email);
  if (sentToday >= cap) {
    throw new GmailQuotaExhaustedError(`Gmail inbox ${sender.email} hit its daily cap (${cap})`);
  }

  const auth = await getReachGmailOAuthClient(account as ReachGmailAccountRow);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildRawMessage(sender.email, params.to, params.subject, params.html, params.replyTo);
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  const { error } = await db.rpc("smrtreach_gmail_quota_inc", { p_org: orgId, p_email: sender.email });
  if (error) console.error("[smrtreach.gmail] quota inc:", error.message);

  return { messageId: res.data.id ?? null, from: sender.email };
}
