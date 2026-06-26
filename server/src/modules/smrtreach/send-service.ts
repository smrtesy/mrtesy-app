/**
 * smrtReach — email send service.
 *
 * Two phases, so a long broadcast never blocks a request and the pg_cron
 * processor (build plan §H) can drive sending later:
 *   1. enqueueCampaignEmail — resolves recipients (from smrtCRM, deliverability
 *      + frequency/cooldown + country filtered), validates the sender, computes
 *      each row's scheduled_at (campaign schedule and/or send-time-optimization)
 *      and writes one smrtreach_queue row per recipient.
 *   2. processEmailQueue   — sends a bounded batch of *due* pending rows via SES,
 *      honoring each campaign's send-hours window, Shabbat rule and rate limit,
 *      writing per-recipient logs and flipping campaign status when drained.
 *
 * Region is resolved per content language (en → us-east-1, he → il-central-1
 * by default), editable per org in smrtreach_settings.
 */

import { db } from "../../db";
import { emitEvent } from "../../lib/platform";
import { resolveAudience } from "./audience-service";
import type { AudienceRef } from "./audience-service";
import { sendEmail, SesNotConfiguredError } from "./ses-client";
import { sendViaGmail, sendViaReachGmail, listOrgGmailAccounts, NoGmailAccountError, GmailQuotaExhaustedError } from "./gmail-client";
import { filterDeliverableEmails } from "./email-validator";
import {
  withinSendWindow,
  filterEmailByFrequency,
  optimalSendHours,
  nextOccurrenceOfHour,
  matchesCountry,
  type SendHours,
} from "./send-window";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

const MAX_SEND_ATTEMPTS = 3;

/**
 * Reset rows orphaned in 'sending' (process crashed/timed out after claiming but
 * before the terminal status write) back to 'pending' so the next pass retries —
 * incrementing attempts, and failing rows that have exhausted the cap so a
 * poison row can never loop forever.
 * @returns the number of rows requeued.
 */
export async function reapStuckSending(orgId: string, olderThanMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  // NULL claimed_at (pre-migration rows) is skipped by `lt` — safe default.
  const { data: stuck, error } = await db
    .from("smrtreach_queue")
    .select("id, attempts")
    .eq("org_id", orgId)
    .eq("channel", "email")
    .eq("status", "sending")
    .lt("claimed_at", cutoff);
  if (error) {
    console.error("[smrtreach.reap]", orgId, error.message);
    return 0;
  }
  if (!stuck || stuck.length === 0) return 0;

  let requeued = 0;
  for (const row of stuck) {
    const attempts = (row.attempts as number) ?? 0;
    if (attempts + 1 >= MAX_SEND_ATTEMPTS) {
      await db.from("smrtreach_queue")
        .update({ status: "failed", error: "exceeded max send attempts", attempts: attempts + 1 })
        .eq("id", row.id);
    } else {
      await db.from("smrtreach_queue")
        .update({ status: "pending", claimed_at: null, attempts: attempts + 1 })
        .eq("id", row.id);
      requeued++;
    }
  }
  return requeued;
}

/** Resolve the SES region for a content language from the org's settings. */
export async function resolveRegion(orgId: string, language: string): Promise<string> {
  const { data } = await db
    .from("smrtreach_settings")
    .select("default_region, region_by_language")
    .eq("org_id", orgId)
    .maybeSingle();

  const map = (data?.region_by_language as Record<string, string> | undefined) ?? {
    en: "us-east-1",
    he: "il-central-1",
  };
  return map[language] ?? data?.default_region ?? "us-east-1";
}

/**
 * {{var}} / {{var|fallback}} / {{custom.field}} substitution (botsite
 * templateEngine.js parity). Missing/empty values render the fallback (or "").
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)(?:\s*\|\s*([^}]*?))?\s*\}\}/g, (_m, key: string, fallback?: string) => {
    const v = vars[key];
    if (v !== undefined && v !== null && v !== "") return String(v);
    return (fallback ?? "").trim();
  });
}

/** Build the substitution vars for a contact, including flattened custom fields. */
function contactVars(
  contact: { first_name?: unknown; last_name?: unknown; phone?: unknown; email?: unknown; custom_fields?: unknown } | null,
  toAddress: string,
): Record<string, string> {
  const first = (contact?.first_name as string) ?? "";
  const last = (contact?.last_name as string) ?? "";
  const vars: Record<string, string> = {
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`.trim(),
    email: (contact?.email as string) ?? toAddress,
    phone: (contact?.phone as string) ?? "",
  };
  const custom = (contact?.custom_fields as Record<string, unknown> | null) ?? null;
  if (custom && typeof custom === "object") {
    for (const [k, val] of Object.entries(custom)) {
      vars[`custom.${k}`] = val == null ? "" : String(val);
    }
  }
  return vars;
}

function unsubscribeFooter(orgId: string, contactId: string): string {
  if (!PUBLIC_BASE_URL) return "";
  const url = `${PUBLIC_BASE_URL}/api/reach/unsubscribe?c=${encodeURIComponent(contactId)}&o=${encodeURIComponent(orgId)}`;
  const prefs = `${PUBLIC_BASE_URL}/api/reach/preferences?c=${encodeURIComponent(contactId)}&o=${encodeURIComponent(orgId)}`;
  return `<hr><p style="font-size:12px;color:#888;text-align:center">` +
    `<a href="${url}">להסרה מרשימת התפוצה</a> · <a href="${prefs}">ניהול העדפות דיוור</a></p>`;
}

/** Hidden preheader so the inbox preview shows intended text, not body leakage. */
function preheader(text: string): string {
  if (!text) return "";
  const pad = "&nbsp;&zwnj;".repeat(60);
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${text}${pad}</div>`;
}

/** 1x1 open-tracking pixel (Reach-3: open tracking is built-in). */
function openPixel(campaignId: string, contactId: string): string {
  if (!PUBLIC_BASE_URL) return "";
  const url = `${PUBLIC_BASE_URL}/api/reach/track/open?c=${encodeURIComponent(campaignId)}&u=${encodeURIComponent(contactId)}`;
  return `<img src="${url}" width="1" height="1" alt="" style="display:none">`;
}

/**
 * Rewrite http(s) links to route through the click tracker, which 302-redirects
 * to the ORIGINAL deep URL (preserved verbatim as the `url` param) — honoring
 * the platform's "preserve deep links" rule while recording the click.
 */
function wrapLinks(html: string, campaignId: string, contactId: string): string {
  if (!PUBLIC_BASE_URL) return html;
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, target: string) => {
    const tracked = `${PUBLIC_BASE_URL}/api/reach/track/click?c=${encodeURIComponent(campaignId)}` +
      `&u=${encodeURIComponent(contactId)}&url=${encodeURIComponent(target)}`;
    return `href="${tracked}"`;
  });
}

/**
 * Email body typography. Applied identically here (sent HTML) and in the
 * editor surface (RichEmailEditor) so the compose view is a faithful preview
 * of what lands in the inbox — same font, size and line spacing. "Google Sans"
 * is the intended face; email clients that lack it fall back down the stack.
 * Keep this list in sync with EMAIL_FONT_STACK in RichEmailEditor.tsx.
 */
export const EMAIL_FONT_STACK =
  "'Google Sans','Product Sans',Roboto,'Helvetica Neue',Arial,sans-serif";
export const DEFAULT_EMAIL_FONT_SIZE = 14;

/**
 * Wrap a rendered email body in the base typography container so every send
 * carries the chosen font/size/spacing (recipients' clients otherwise impose
 * their own default font and collapse the spacing the author saw). Child inline
 * styles (footer, etc.) still override per-element.
 */
export function wrapEmailBody(inner: string, fontSize: number | null): string {
  const size = fontSize && fontSize > 0 ? fontSize : DEFAULT_EMAIL_FONT_SIZE;
  return (
    `<div style="font-family:${EMAIL_FONT_STACK};font-size:${size}px;line-height:1.6">` +
    inner +
    `</div>`
  );
}

/** A campaign sender with its effective per-campaign budget (alloc). */
interface AllocSender {
  id: string;
  email: string;
  provider: string;
  daily_cap: number | null;
  alloc: number;
}

/**
 * Split `total` recipients across the allocated senders proportionally to each
 * sender's budget, never exceeding a sender's own alloc. Returns a per-sender
 * count whose sum == total (total is assumed ≤ Σ alloc). The rounding
 * remainder is handed out to senders that still have spare capacity.
 */
function distributeAcrossSenders(allocations: AllocSender[], total: number): number[] {
  const totalAlloc = allocations.reduce((s, a) => s + a.alloc, 0);
  if (totalAlloc <= 0 || total <= 0) return allocations.map(() => 0);
  const targets = allocations.map((a) => Math.min(a.alloc, Math.floor((a.alloc / totalAlloc) * total)));
  let assigned = targets.reduce((s, n) => s + n, 0);
  // Distribute the remainder round-robin to senders with remaining capacity.
  let guard = 0;
  while (assigned < total && guard < total + allocations.length) {
    let progressed = false;
    for (let i = 0; i < allocations.length && assigned < total; i++) {
      if (targets[i] < allocations[i].alloc) { targets[i]++; assigned++; progressed = true; }
    }
    if (!progressed) break;
    guard++;
  }
  return targets;
}

/**
 * Resolve recipients for a campaign's email channel and enqueue them, honoring
 * country filter, frequency/cooldown gating, the campaign schedule and (when
 * enabled) per-contact send-time-optimization.
 * @returns the number of rows queued.
 */
export async function enqueueCampaignEmail(orgId: string, campaignId: string): Promise<number> {
  const { data: campaign, error: cErr } = await db
    .from("smrtreach_campaigns")
    .select("audience, channel, status, scheduled_at, country_filter, ignore_send_window")
    .eq("org_id", orgId)
    .eq("id", campaignId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!campaign) throw new Error("campaign not found");
  if (campaign.channel !== "email" && campaign.channel !== "both") {
    throw new Error("campaign channel is not email");
  }
  // Guard against re-enqueuing a campaign that's already in flight or finished,
  // which would re-send to everyone (the queue has no per-recipient uniqueness).
  if (campaign.status === "sending" || campaign.status === "done") {
    throw new Error(`campaign already ${campaign.status} — cannot send again`);
  }

  const { data: detail, error: dErr } = await db
    .from("smrtreach_campaign_email")
    .select("sender, priority, sto_enabled, cooldown_seconds, provider")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (dErr) throw new Error(dErr.message);
  if (!detail) throw new Error("campaign has no email content");

  // Per-campaign sender allocation (the master-list subset + "how many from
  // each"). When present it supersedes the single detail.sender / provider:
  // recipients are partitioned across these senders, each capped by its
  // daily_cap, and the proportional split clamps gracefully when the resolved
  // audience is smaller than the total allocated budget.
  const { data: allocRows, error: aErr } = await db
    .from("smrtreach_campaign_senders")
    .select("send_count, sender:smrtreach_senders(id, email, provider, daily_cap)")
    .eq("campaign_id", campaignId)
    .eq("org_id", orgId);
  if (aErr) throw new Error(aErr.message);

  const allocations: AllocSender[] = [];
  for (const r of allocRows ?? []) {
    const s = r.sender as unknown as { id: string; email: string; provider: string; daily_cap: number | null } | null;
    if (!s) continue;
    const cap = s.daily_cap ?? null;
    const want = (r.send_count as number) ?? 0;
    const alloc = cap != null ? Math.min(want, cap) : want;
    if (alloc > 0) allocations.push({ id: s.id, email: s.email, provider: s.provider, daily_cap: cap, alloc });
  }
  const useAllocation = allocations.length > 0;

  if (!useAllocation) {
    // Fallback: single-sender / provider path (no explicit allocation).
    const provider = (detail.provider as string) ?? "ses";
    if (provider === "gmail") {
      // Gmail provider: the org must have at least one connected Gmail account.
      const accounts = await listOrgGmailAccounts(orgId);
      if (accounts.length === 0) {
        throw new Error("no connected Gmail account — connect Gmail in settings before sending via Gmail");
      }
    } else {
      if (!detail.sender) throw new Error("campaign has no sender set");
      // The sender must be one of the org's managed verified senders.
      const { data: sender } = await db
        .from("smrtreach_senders")
        .select("email")
        .eq("org_id", orgId)
        .eq("email", detail.sender)
        .maybeSingle();
      if (!sender) throw new Error(`sender "${detail.sender}" is not a verified sender for this org`);
    }
  }

  let recipients = await resolveAudience(orgId, (campaign.audience ?? {}) as AudienceRef, "email");
  // Drop empty / syntactically-invalid / no-MX addresses before they reach the
  // sender (botsite emailValidator parity — syntax + DNS MX per domain, cached).
  const deliverable = await filterDeliverableEmails(recipients.map((r) => r.email as string).filter(Boolean));
  recipients = recipients.filter((r) => r.email && deliverable.has(r.email));

  // Country filter (campaignBroadcast.js parity) — matches by phone prefix.
  const countryFilter = campaign.country_filter as string | null;
  if (countryFilter && countryFilter !== "all") {
    recipients = recipients.filter((r) => matchesCountry(r.phone, countryFilter));
  }

  // Frequency / cooldown gating. cooldown_seconds set on the campaign forces a
  // skip of the tier-cooldown only when explicitly 0 (botsite skip_cooldown).
  const skipCooldown = detail.cooldown_seconds === 0;
  const contactIds = recipients.map((r) => r.contact_id).filter(Boolean) as string[];
  const { keep } = await filterEmailByFrequency(orgId, contactIds, detail.priority as string | null, skipCooldown);
  recipients = recipients.filter((r) => !r.contact_id || keep.has(r.contact_id));
  if (recipients.length === 0) return 0;

  // Allocation: assign each recipient to one of the allocated senders. The
  // allocation IS the send budget — when the audience exceeds Σ alloc only the
  // budgeted number are enqueued; when it's smaller, the split clamps
  // proportionally so every recipient is covered.
  let assignment: AllocSender[] = [];
  if (useAllocation) {
    const totalAlloc = allocations.reduce((s, a) => s + a.alloc, 0);
    const effectiveTotal = Math.min(recipients.length, totalAlloc);
    const targets = distributeAcrossSenders(allocations, effectiveTotal);
    for (let s = 0; s < allocations.length; s++) {
      for (let k = 0; k < targets[s]; k++) assignment.push(allocations[s]);
    }
    recipients = recipients.slice(0, assignment.length);
  }

  // "Send now" (ignore_send_window): blast immediately — no per-row schedule,
  // no STO. Otherwise base = campaign.scheduled_at (or now); STO overrides per
  // contact with the soonest occurrence of their best open hour.
  const ignoreWindow = campaign.ignore_send_window === true;
  const base = !ignoreWindow && campaign.scheduled_at ? new Date(campaign.scheduled_at as string) : new Date();
  const baseIso = !ignoreWindow && campaign.scheduled_at ? base.toISOString() : null;
  let optimal = new Map<string, number>();
  if (detail.sto_enabled && !ignoreWindow) {
    optimal = await optimalSendHours(orgId, contactIds);
  }

  // For the fallback (no allocation) SES path, record the single sender on each
  // row for traceability; Gmail fallback leaves it null (round-robin at send).
  const fallbackFrom = detail.provider === "gmail" ? null : (detail.sender as string | null) ?? null;

  const rows = recipients.map((r, idx) => {
    let scheduledAt = baseIso;
    if (!ignoreWindow && detail.sto_enabled && r.contact_id && optimal.has(r.contact_id)) {
      scheduledAt = nextOccurrenceOfHour(optimal.get(r.contact_id)!, base).toISOString();
    }
    const a = useAllocation ? assignment[idx] : null;
    return {
      org_id: orgId,
      campaign_id: campaignId,
      channel: "email",
      contact_id: r.contact_id,
      to_address: r.email as string,
      status: "pending",
      scheduled_at: scheduledAt,
      sender_id: a ? a.id : null,
      from_address: a ? a.email : fallbackFrom,
    };
  });

  // Insert in batches. The "already sending/done" guard above is what prevents
  // duplicate enqueues (the queue table has no per-recipient unique index).
  let queued = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("smrtreach_queue").insert(chunk);
    if (error) throw new Error(`enqueue: ${error.message}`);
    queued += chunk.length;
  }

  await db.from("smrtreach_campaigns").update({ status: "sending" }).eq("org_id", orgId).eq("id", campaignId);
  await emitEvent(orgId, "smrtreach", "campaign.sending", "campaign", campaignId, { queued });
  return queued;
}

interface ProcessResult {
  sent: number;
  failed: number;
  remaining: number;
}

interface EmailDetail {
  subject: string;
  preview: string;
  html: string;
  from: string;
  replyTo: string | null;
  region: string;
  sendHours: SendHours;
  excludeShabbat: boolean;
  rateLimit: number | null;
  provider: string;
  fontSize: number | null;
}

/**
 * Send a bounded batch of *due* pending email-queue rows via SES. Safe to call
 * repeatedly (pg_cron will). Respects each campaign's status (only 'sending'
 * campaigns send — so pause/test-batch hold), per-row scheduled_at, the
 * send-hours window, the Shabbat rule and the per-campaign hourly rate limit.
 *
 * Concurrency-safe: rows are claimed via a conditional UPDATE (status pending →
 * sending) and only the claimed rows are sent, so overlapping runs never
 * double-send.
 */
export async function processEmailQueue(orgId: string, limit = 100): Promise<ProcessResult> {
  const nowIso = new Date().toISOString();
  // 1. Candidate rows: pending, this org/channel, and DUE (no schedule, or
  //    scheduled_at in the past). Over-fetch so per-campaign gating/rate-capping
  //    still fills the batch.
  const { data: candidates, error: candErr } = await db
    .from("smrtreach_queue")
    .select("id, campaign_id")
    .eq("org_id", orgId)
    .eq("channel", "email")
    .eq("status", "pending")
    .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit * 3);
  if (candErr) throw new Error(candErr.message);
  if (!candidates || candidates.length === 0) return { sent: 0, failed: 0, remaining: 0 };

  // Per-campaign caches.
  const detailCache = new Map<string, EmailDetail | null>();
  const statusOk = new Map<string, boolean>();
  const windowOk = new Map<string, boolean>();
  const perCampaignCap = new Map<string, number>(); // remaining sends allowed this tick
  const touchedCampaigns = new Set<string>();

  async function getDetail(campaignId: string): Promise<EmailDetail | null> {
    if (detailCache.has(campaignId)) return detailCache.get(campaignId)!;
    const { data } = await db
      .from("smrtreach_campaign_email")
      .select("subject, preview, html_body, sender, reply_to, language, send_hours, exclude_shabbat, rate_limit, provider, font_size")
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (!data) { detailCache.set(campaignId, null); return null; }
    const region = await resolveRegion(orgId, (data.language as string) ?? "he");
    const detail: EmailDetail = {
      subject: (data.subject as string) ?? "",
      preview: (data.preview as string) ?? "",
      html: (data.html_body as string) ?? "",
      from: (data.sender as string) ?? "",
      replyTo: (data.reply_to as string | null) ?? null,
      region,
      sendHours: (data.send_hours as SendHours | null) ?? {},
      excludeShabbat: (data.exclude_shabbat as boolean | null) ?? true,
      rateLimit: (data.rate_limit as number | null) ?? null,
      provider: (data.provider as string) ?? "ses",
      fontSize: (data.font_size as number | null) ?? null,
    };
    detailCache.set(campaignId, detail);
    return detail;
  }

  // Decide, per campaign, whether it may send right now (status + window) and
  // cap how many of its rows we'll claim this tick (rate limit / hour → /minute).
  async function campaignSendable(campaignId: string): Promise<boolean> {
    if (statusOk.has(campaignId)) return statusOk.get(campaignId)! && (windowOk.get(campaignId) ?? false);
    const { data: c } = await db
      .from("smrtreach_campaigns").select("status, ignore_send_window").eq("org_id", orgId).eq("id", campaignId).maybeSingle();
    const sendable = c?.status === "sending";
    statusOk.set(campaignId, sendable);
    const detail = await getDetail(campaignId);
    // "Send now" bypasses the send-window/Shabbat rule and the rate limit.
    const ignoreWindow = c?.ignore_send_window === true;
    const w = ignoreWindow ? { ok: true } : detail ? withinSendWindow(detail.sendHours, detail.excludeShabbat) : { ok: false };
    windowOk.set(campaignId, w.ok);
    // Initialize the per-tick rate cap. cron runs ~every minute, so the per-tick
    // budget is rate_limit/60 (≈ rate_limit emails/hour overall). Unlimited when
    // "send now".
    const cap = !ignoreWindow && detail?.rateLimit && detail.rateLimit > 0 ? Math.max(1, Math.ceil(detail.rateLimit / 60)) : Infinity;
    perCampaignCap.set(campaignId, cap);
    return sendable && w.ok;
  }

  // 2. Pick claimable ids, respecting per-campaign sendability + rate cap + overall limit.
  const claimIds: string[] = [];
  for (const row of candidates) {
    if (claimIds.length >= limit) break;
    const cid = row.campaign_id as string;
    if (!(await campaignSendable(cid))) continue;
    const cap = perCampaignCap.get(cid) ?? Infinity;
    if (cap <= 0) continue;
    perCampaignCap.set(cid, cap - 1);
    claimIds.push(row.id as string);
  }
  if (claimIds.length === 0) return { sent: 0, failed: 0, remaining: 0 };

  // 3. Atomically claim only those rows.
  const { data: pending, error } = await db
    .from("smrtreach_queue")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .in("id", claimIds)
    .select("id, campaign_id, contact_id, to_address, sender_id, from_address");
  if (error) throw new Error(error.message);
  if (!pending || pending.length === 0) return { sent: 0, failed: 0, remaining: 0 };

  // Per-sender cache (the allocated send identity for a row).
  const senderCache = new Map<string, { id: string; email: string; provider: string; daily_cap: number | null } | null>();
  async function resolveSender(id: string) {
    if (senderCache.has(id)) return senderCache.get(id)!;
    const { data } = await db
      .from("smrtreach_senders")
      .select("id, email, provider, daily_cap")
      .eq("org_id", orgId).eq("id", id).maybeSingle();
    const v = data
      ? { id: data.id as string, email: data.email as string, provider: (data.provider as string) ?? "ses", daily_cap: (data.daily_cap as number | null) ?? null }
      : null;
    senderCache.set(id, v);
    return v;
  }

  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    touchedCampaigns.add(row.campaign_id as string);
    const detail = await getDetail(row.campaign_id as string);
    if (!detail) {
      await db.from("smrtreach_queue").update({ status: "failed", error: "missing email detail" }).eq("id", row.id);
      failed++;
      continue;
    }
    // Resolve the sender this row was allocated to (if any). It overrides the
    // campaign-level provider/from so a single campaign can fan out across
    // SES + several Gmail inboxes per the allocation.
    const allocSender = row.sender_id ? await resolveSender(row.sender_id as string) : null;
    const provider = allocSender ? allocSender.provider : detail.provider;
    const fromAddress = allocSender ? allocSender.email : ((row.from_address as string | null) ?? detail.from);
    if (provider !== "gmail" && !fromAddress) {
      await db.from("smrtreach_queue").update({ status: "failed", error: "missing sender" }).eq("id", row.id);
      failed++;
      continue;
    }

    // Fetch contact fields for variable substitution.
    const { data: contact } = row.contact_id
      ? await db.from("smrtcrm_contacts").select("first_name, last_name, phone, email, custom_fields").eq("org_id", orgId).eq("id", row.contact_id).maybeSingle()
      : { data: null };
    const vars = contactVars(contact, row.to_address as string);

    const campaignId = row.campaign_id as string;
    const contactId = (row.contact_id as string) ?? "";
    const subject = render(detail.subject, vars);
    const html =
      preheader(render(detail.preview, vars)) +
      wrapEmailBody(
        wrapLinks(render(detail.html, vars), campaignId, contactId),
        detail.fontSize,
      ) +
      unsubscribeFooter(orgId, contactId) +
      openPixel(campaignId, contactId);

    try {
      const to = row.to_address as string;
      let messageId: string | null;
      if (provider === "gmail") {
        messageId = allocSender
          ? (await sendViaReachGmail(orgId, allocSender, { to, subject, html, replyTo: detail.replyTo })).messageId
          : (await sendViaGmail(orgId, { to, subject, html, replyTo: detail.replyTo })).messageId;
      } else {
        messageId = (await sendEmail({ region: detail.region, from: fromAddress!, to, subject, html, replyTo: detail.replyTo })).messageId;
      }
      // Check the terminal status write: if it silently failed the row would
      // stick at 'sending' and wedge the campaign's drain check.
      const { error: markErr } = await db
        .from("smrtreach_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", row.id);
      if (markErr) console.error("[smrtreach.queue] mark sent failed:", row.id, markErr.message);
      await db.from("smrtreach_logs").insert({
        org_id: orgId,
        campaign_id: row.campaign_id,
        contact_id: row.contact_id,
        channel: "email",
        status: "sent",
        wa_message_id: messageId || null,
        sent_at: new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      // Gmail daily cap reached: release the row back to pending (retry later,
      // e.g. tomorrow) WITHOUT logging a failure. With a per-sender allocation,
      // one capped inbox must not stop the others — skip just this row;
      // otherwise (legacy round-robin) every account is capped, so stop.
      if (e instanceof GmailQuotaExhaustedError) {
        await db.from("smrtreach_queue").update({ status: "pending", claimed_at: null }).eq("id", row.id);
        if (allocSender) continue;
        break;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const { error: markErr } = await db
        .from("smrtreach_queue")
        .update({ status: "failed", error: msg })
        .eq("id", row.id);
      if (markErr) console.error("[smrtreach.queue] mark failed failed:", row.id, markErr.message);
      await db.from("smrtreach_logs").insert({
        org_id: orgId,
        campaign_id: row.campaign_id,
        contact_id: row.contact_id,
        channel: "email",
        status: "failed",
        error: msg,
      });
      failed++;
      // Stop early on a config error — every row would fail the same way.
      // Exception: a dead ALLOCATED Gmail inbox (NoGmailAccountError) only
      // affects rows bound to that inbox, so keep processing the rest.
      if (e instanceof SesNotConfiguredError) break;
      if (e instanceof NoGmailAccountError && !allocSender) break;
    }
  }

  // Flip campaigns whose queue is now drained.
  for (const campaignId of touchedCampaigns) {
    await maybeCompleteCampaign(orgId, campaignId);
  }

  const { count: remaining } = await db
    .from("smrtreach_queue")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("channel", "email")
    .eq("status", "pending");

  return { sent, failed, remaining: remaining ?? 0 };
}

/**
 * Flip a campaign to 'done' once it has no pending/sending rows left (either
 * channel), emitting campaign.done with the sent count and auto-tagging the
 * recipients in smrtCRM (botsite "קמפיין: <name>" tag). Shared by both channel
 * processors so a 'both' campaign only completes when BOTH queues drain.
 */
export async function maybeCompleteCampaign(orgId: string, campaignId: string): Promise<void> {
  const { count } = await db
    .from("smrtreach_queue")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "sending"]);
  if ((count ?? 0) !== 0) return;

  // Only complete a campaign that was actually sending (not paused/draft).
  const { data: c } = await db
    .from("smrtreach_campaigns")
    .select("name, status, created_by")
    .eq("org_id", orgId)
    .eq("id", campaignId)
    .maybeSingle();
  if (!c || c.status !== "sending") return;

  await db.from("smrtreach_campaigns").update({ status: "done" }).eq("org_id", orgId).eq("id", campaignId);
  const { count: sentCount } = await db
    .from("smrtreach_logs")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "sent");
  await emitEvent(orgId, "smrtreach", "campaign.done", "campaign", campaignId, {
    name: c.name ?? "",
    sent: sentCount ?? 0,
  });
  await autoTagRecipients(orgId, campaignId, (c.name as string) ?? "", (c.created_by as string) ?? null);
}

/**
 * Tag every contact that was sent this campaign with "קמפיין: <name>" so the
 * audience is reusable (botsite auto-tag on completion). Org-scoped writes to
 * the smrtCRM tag tables (the same tables audience-service reads); best-effort.
 */
async function autoTagRecipients(orgId: string, campaignId: string, name: string, createdBy: string | null): Promise<void> {
  try {
    const tagName = `קמפיין: ${name}`.slice(0, 200);
    // Find or create the tag (UNIQUE(org_id, name)).
    let tagId: string | null = null;
    const { data: existing } = await db
      .from("smrtcrm_tags").select("id").eq("org_id", orgId).eq("name", tagName).maybeSingle();
    if (existing) {
      tagId = existing.id as string;
    } else {
      const { data: created, error: tagErr } = await db
        .from("smrtcrm_tags")
        .insert({ org_id: orgId, name: tagName, kind: "source", created_by: createdBy })
        .select("id")
        .single();
      if (tagErr) { console.error("[smrtreach.autotag] create tag:", tagErr.message); return; }
      tagId = created.id as string;
    }
    if (!tagId) return;

    const { data: logs } = await db
      .from("smrtreach_logs")
      .select("contact_id")
      .eq("org_id", orgId)
      .eq("campaign_id", campaignId)
      .eq("status", "sent")
      .not("contact_id", "is", null);
    const contactIds = [...new Set((logs ?? []).map((l) => l.contact_id as string))];
    if (contactIds.length === 0) return;

    const assignments = contactIds.map((cid) => ({ org_id: orgId, tag_id: tagId, contact_id: cid }));
    for (let i = 0; i < assignments.length; i += 500) {
      const { error } = await db
        .from("smrtcrm_tag_assignments")
        .upsert(assignments.slice(i, i + 500), { onConflict: "contact_id,tag_id", ignoreDuplicates: true });
      if (error) { console.error("[smrtreach.autotag] assign:", error.message); return; }
    }
  } catch (e) {
    console.error("[smrtreach.autotag]", campaignId, e instanceof Error ? e.message : e);
  }
}
