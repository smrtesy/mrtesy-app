/**
 * web-action — automatic verification-code extraction.
 *
 * Both channels a signup uses to verify already flow INTO this platform, so no
 * human relay is needed:
 *   - email codes/links via the user's Gmail (services/gmail)
 *   - SMS codes via the sms_messages table (the /sms/webhook ingest)
 *
 * We only ever look at RECENT messages (a signup code is fresh), so we never
 * pick up a stale code from an old message. Nothing here is logged.
 */

import { db } from "../../db";
import { searchGmail, getMessage, extractEmailText } from "../../services/gmail";

/** Default freshness window — a verification code older than this is ignored. */
const FRESH_MS = 10 * 60_000;

/**
 * Pull the most likely one-time code out of free text. Prefers a number that
 * sits next to a verification keyword (EN + HE); then a grouped `123-456`; then
 * a lone 4–8 digit run. Returns null when nothing plausible is present.
 */
export function extractOtp(text: string): string | null {
  if (!text) return null;
  const near = text.match(
    /(?:code|verification|verify|one[-\s]?time|otp|pin|password|קוד|אימות|סיסמ)[^\d]{0,24}(\d{4,8})/i,
  );
  if (near) return near[1];
  const grouped = text.match(/\b(\d{3})[-\s](\d{3})\b/);
  if (grouped) return grouped[1] + grouped[2];
  const lone = text.match(/\b(\d{4,8})\b/);
  return lone ? lone[1] : null;
}

/** Find a verification/confirmation link in an email body. */
export function extractVerificationLink(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  const hit = urls.find((u) => /verif|confirm|activate|validate|signup|register|magic|token/i.test(u));
  return hit ?? urls[0] ?? null;
}

export interface SmsCodeResult {
  code: string | null;
  from: string | null;
  body: string | null;
  receivedAt: string | null;
}

/**
 * Latest inbound SMS code for the user. Optionally narrow by the sender or the
 * receiving (device) number, and by a freshness window. Reads only rows newer
 * than `sinceMs` ago, newest first, preferring ones the ingest already tagged
 * as an OTP.
 */
export async function latestSmsCode(
  userId: string,
  opts: { fromPhone?: string; toPhone?: string; sinceMs?: number } = {},
): Promise<SmsCodeResult> {
  const since = new Date(Date.now() - (opts.sinceMs ?? FRESH_MS)).toISOString();
  let q = db
    .from("sms_messages")
    .select("from_phone, to_phone, body_text, is_otp, received_at")
    .eq("user_id", userId)
    .eq("direction", "incoming")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(10);
  if (opts.fromPhone) q = q.eq("from_phone", opts.fromPhone);
  if (opts.toPhone) q = q.eq("to_phone", opts.toPhone);

  const { data, error } = await q;
  if (error || !data?.length) return { code: null, from: null, body: null, receivedAt: null };

  // Prefer a row the ingest flagged as OTP; fall back to newest with a code.
  const ordered = [...data].sort((a, b) => Number(b.is_otp) - Number(a.is_otp));
  for (const row of ordered) {
    const code = extractOtp(row.body_text ?? "");
    if (code) {
      return {
        code,
        from: (row.from_phone as string) ?? null,
        body: (row.body_text as string) ?? null,
        receivedAt: (row.received_at as string) ?? null,
      };
    }
  }
  return { code: null, from: null, body: null, receivedAt: null };
}

export interface EmailCodeResult {
  code: string | null;
  link: string | null;
  subject: string | null;
  from: string | null;
}

/**
 * Latest verification email for the user, via Gmail. Narrow with `fromContains`
 * (sender/domain) and `subjectContains`; both fold into the Gmail `q`. Scans
 * only recent mail (`newer_than`) and returns the extracted code AND any
 * verification link (some providers send a click-link instead of a code).
 */
export async function latestEmailCode(
  userId: string,
  opts: { fromContains?: string; subjectContains?: string; sinceMinutes?: number } = {},
): Promise<EmailCodeResult> {
  const parts = [`newer_than:${Math.max(1, Math.ceil((opts.sinceMinutes ?? 10) / 60)) || 1}h`, "in:anywhere"];
  if (opts.fromContains) parts.push(`from:${opts.fromContains}`);
  if (opts.subjectContains) parts.push(`subject:${opts.subjectContains}`);
  else parts.push("(verify OR verification OR code OR confirm OR אימות OR קוד)");

  const hits = await searchGmail(userId, parts.join(" "), 5).catch(() => []);
  for (const { id } of hits) {
    const msg = await getMessage(userId, id).catch(() => null);
    if (!msg) continue;
    const { subject, from, body } = extractEmailText(msg);
    const code = extractOtp(`${subject}\n${body}`);
    const link = extractVerificationLink(body);
    if (code || link) return { code, link, subject, from };
  }
  return { code: null, link: null, subject: null, from: null };
}
