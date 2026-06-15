/**
 * smrtReach — Gmail sender (botsite parity).
 *
 * Sends email through the org's CONNECTED Gmail accounts, reusing the platform's
 * existing per-user Google OAuth (user_credentials, service='gmail', scope
 * gmail.modify — which permits messages.send) and the auto-refreshing
 * getOAuthClient helper. No new OAuth flow is introduced.
 *
 * Multiple connected accounts are round-robined and each is capped per day
 * (botsite used 2000/account/day) via smrtreach_gmail_quota.
 */

import { google } from "googleapis";
import { db } from "../../db";
import { getOAuthClient } from "../../services/token-refresh";

/** Per-account daily send cap (botsite: 2000/account/day Workspace limit). */
const DAILY_CAP = 2000;

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
