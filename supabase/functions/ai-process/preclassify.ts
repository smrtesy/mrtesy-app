// EXTRACTED FROM index.ts (2026-07-28) — pure helpers, no I/O, no Deno
// globals, so they can be unit-tested directly (see *_test.ts next to this
// file). Moved verbatim; every comment below documents a real production bug
// the rule exists to prevent. Keep them pure: the moment one of these needs
// `supabase` or `fetch`, it belongs back in index.ts.

/** The deterministic pre-AI filter and the business-hours math it uses. */

/**
 * Only the parameter preClassify actually reads. Structural, so index.ts can
 * keep passing the full SystemParams without this module importing it.
 */
export interface PreClassifySystemParams {
  calendar_past_days: number;
}

export const DEFAULT_FILTERED_CATEGORY_KEYS = new Set(["promotions", "social", "forums"]);
export const CATEGORY_KEY_TO_GMAIL_LABEL: Record<string, string> = {
  promotions: "CATEGORY_PROMOTIONS",
  social:     "CATEGORY_SOCIAL",
  updates:    "CATEGORY_UPDATES",
  forums:     "CATEGORY_FORUMS",
};
export const ALL_CATEGORY_KEYS = Object.keys(CATEGORY_KEY_TO_GMAIL_LABEL);

export interface CategoryRuleRow { trigger: string; is_active: boolean }

export function buildCategoryFilter(rules: CategoryRuleRow[]): Set<string> {
  const ruleByKey = new Map<string, boolean>();
  for (const r of rules) {
    const m = r.trigger.match(/^category=(.+)$/i);
    if (!m) continue;
    ruleByKey.set(m[1].toLowerCase(), r.is_active);
  }
  const labels = new Set<string>();
  for (const key of ALL_CATEGORY_KEYS) {
    const ruleValue = ruleByKey.get(key);
    const shouldFilter = ruleValue !== undefined ? ruleValue : DEFAULT_FILTERED_CATEGORY_KEYS.has(key);
    if (shouldFilter) labels.add(CATEGORY_KEY_TO_GMAIL_LABEL[key]);
  }
  return labels;
}

// ── Business-hours math ──────────────────────────────────────────────────────
// "Business hours" here = clock hours that fall on a business DAY. A business
// day is Mon–Fri (Sun=0 and Sat=6 are weekend) — matching the convention this
// file already used. Nights count; only weekends are skipped. So 48 business
// hours = "two business days later, jumping over any weekend in between".
//
// Used for two product rules:
//   * follow-up suggestions surface FOLLOWUP_LEAD_HOURS after an outgoing
//     message that's awaiting a reply (default 48h).
//   * meeting suggestions surface MEETING_LEAD_HOURS before the event (24h).
export const FOLLOWUP_LEAD_HOURS = 48;
export const MEETING_LEAD_HOURS = 24;

export function isBusinessDay(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

// Advance `start` forward by `hours` business hours.
export function addBusinessHours(start: Date, hours: number): Date {
  const d = new Date(start);
  let remaining = hours;
  while (remaining > 0) {
    d.setHours(d.getHours() + 1);
    if (isBusinessDay(d)) remaining--;
  }
  return d;
}

// Move `start` backward by `hours` business hours (the earliest moment that is
// still `hours` business hours ahead of it).
export function subBusinessHours(start: Date, hours: number): Date {
  const d = new Date(start);
  let remaining = hours;
  while (remaining > 0) {
    d.setHours(d.getHours() - 1);
    if (isBusinessDay(d)) remaining--;
  }
  return d;
}

export function preClassify(msg: any, settings: any, sys: PreClassifySystemParams): { result: string; skipReason?: string } {
  const sender = (msg.sender_email || msg.sender || "").toLowerCase();
  // source_messages has no dedicated recipient column — Part1 stores the TO
  // address in reply_to_context and metadata.to. Fall back through all three.
  const recipient = (msg.recipient || msg.reply_to_context || (msg.metadata as any)?.to || "").toLowerCase();
  // For `to=<addr>` skip rules, the `recipient` string only captures the
  // visible To header. gmail-sync now stores every recipient-side
  // address (To, Cc, Bcc, Delivered-To, X-Forwarded-To, X-Original-To)
  // as metadata.recipients[], so the BCC and forwarded-to cases (T367
  // family: mail sent from office@maor.org to a customer with BCC
  // outbox@maor.org) finally have something to match against.
  const recipients: string[] = Array.isArray((msg.metadata as any)?.recipients)
    ? ((msg.metadata as any).recipients as string[]).map((s) => String(s).toLowerCase())
    : [];
  const sourceType = msg.source_type || "";
  const myEmails = (settings.my_emails || []).map((e: string) => e.toLowerCase());
  const officeAddresses = (settings.office_addresses || []).map((e: string) => e.toLowerCase());
  const skipSenders = (settings.skip_senders || []).map((e: string) => e.toLowerCase());
  const skipRecipients = (settings.skip_recipients || []).map((e: string) => e.toLowerCase());
  const toSkip: Set<string> = settings.__toSkip instanceof Set ? settings.__toSkip : new Set();
  const fromSkip: Set<string> = settings.__fromSkip instanceof Set ? settings.__fromSkip : new Set();
  const gmailLabels: string[] = Array.isArray(msg.metadata?.labels) ? msg.metadata.labels : [];
  const categoryFilter: Set<string> = settings.__category_filter instanceof Set ? settings.__category_filter : new Set();

  // rules_memory to=/from= skip rules (UI-configured).
  // `to=` matches the visible To header AND every other recipient-side
  // address (Cc, Bcc, Delivered-To, X-Forwarded-To, X-Original-To) —
  // that's what makes `to=outbox@maor.org` catch BCC traffic.
  for (const addr of toSkip) {
    if (recipient.includes(addr) || recipients.some((r) => r.includes(addr))) {
      return { result: "skip", skipReason: `to_rule: ${addr}` };
    }
  }
  // The user's own outgoing mail must reach the check_followup routing below —
  // a from= rule that happens to match one of the user's own addresses (e.g. a
  // rule created on a shared domain) must never swallow it here.
  const senderIsSelf = myEmails.some((e: string) => e && sender.includes(e));
  for (const addr of fromSkip) {
    if (senderIsSelf) break;
    if (sender.includes(addr)) return { result: "skip", skipReason: `from_rule: ${addr}` };
  }

  // Legacy user_settings skip lists
  for (const sr of skipRecipients) {
    if (recipient.includes(sr)) return { result: "skip", skipReason: `recipient: ${sr}` };
  }

  if (sourceType === "google_calendar" && msg.received_at) {
    const eventDate = new Date(msg.received_at);
    const now = new Date();
    const pastCutoff = new Date(now.getTime() - sys.calendar_past_days * 86_400_000);
    if (eventDate < pastCutoff) return { result: "skip", skipReason: "past_calendar_event" };
    // All calendar events are actionable, but a meeting should only surface as a
    // suggestion MEETING_LEAD_HOURS (24) business hours before it starts — not
    // days in advance. Defer until that lead window opens; the cron re-evaluates
    // every minute, so it surfaces exactly on time.
    const processFrom = subBusinessHours(eventDate, MEETING_LEAD_HOURS);
    if (now < processFrom) return { result: "defer", skipReason: "future_calendar_event" };
    return { result: "calendar_actionable" };
  }

  // Drive documents are never spam — always actionable regardless of content.
  if (sourceType === "google_drive") {
    return { result: "drive_actionable" };
  }

  // Google Workspace storage warnings (workspace-noreply@google.com).
  // Google sends these at ~81%, ~90%, and 100%. Only surface a task at ≥ 95%.
  if (sender === "workspace-noreply@google.com" && (msg.subject || "").toLowerCase().includes("storage")) {
    const bodyText = (msg.body_text || "").toLowerCase();
    const pctMatch = bodyText.match(/currently using (\d+)%/);
    const pct = pctMatch ? parseInt(pctMatch[1], 10) : 0;
    if (pct < 95) {
      return { result: "skip", skipReason: `google_workspace_storage_${pct}pct_below_threshold` };
    }
  }

  // whatsapp_echo rows are self-chat captures (voice memos = fresh task
  // intentions), NOT messages sent to a third party awaiting a reply — they go
  // through normal analysis and become tasks immediately. Only sent EMAIL is
  // routed to the deferred 48-business-hour follow-up flow.
  // sms_echo mirrors whatsapp_echo: an SMS the user texted to their OWN number
  // as a task-capture channel. A deliberate self-note, never a sent message
  // awaiting a reply — go straight to Claude, skip the check_followup defer.
  if (sourceType === "whatsapp_echo" || sourceType === "sms_echo") return { result: "needs_claude" };
  if (sourceType === "gmail_sent") return { result: "check_followup" };
  if (myEmails.some((e: string) => sender.includes(e))) return { result: "check_followup" };
  if (officeAddresses.some((e: string) => sender.includes(e))) return { result: "customer_inquiry" };
  // A sender the user asked to skip is filtered noise, not read-and-keep info —
  // route to "skip" so it gets the "דילוג" label and reads honestly in the log
  // (same reasoning as the Gmail-category filter below).
  if (skipSenders.some((e: string) => sender.includes(e))) return { result: "skip", skipReason: `skip_sender: ${sender}` };

  // Gmail categories the user filters out (promotions/social/forums by
  // default) are DROPPED, not kept — so they are a skip, not "informational".
  // Labeling them "informational" was misleading: a "You're our 3rd winner"
  // promo is filtered noise, not read-and-keep info. Route to skip so it gets
  // the "דילוג" label and reads honestly in the log.
  if (categoryFilter.size > 0) {
    const filteredLabel = gmailLabels.find((l) => categoryFilter.has(l));
    if (filteredLabel) return { result: "skip", skipReason: `gmail_category:${filteredLabel}` };
  }

  // Deterministic content-skip layer. Phrases (rules_memory `contains=<phrase>`)
  // were mined from history with ~100% precision on the no-task corpus — every
  // matching phrase was a transactional close-out ("payment received", "your
  // receipt") or a bulk marker ("newsletter"), and ZERO of the user's real
  // tasks contained them. Restricted to FIRST-CONTACT inbound email: a bulk /
  // transactional notice is never a reply in a live human thread, and that
  // guard neutralizes the only collision risk found — a phrase quoted inside a
  // "Re:" conversation (e.g. "...the package was delivered, but can you..."),
  // which is a real ask, not a receipt.
  const contentSkip: string[] = Array.isArray(settings.__contentSkip) ? settings.__contentSkip : [];
  if (contentSkip.length > 0 && sourceType === "gmail") {
    const subj = String(msg.subject || "");
    const isReply = /^\s*(re|fwd|fw|תגובה|הועבר)\s*:/i.test(subj)
      || !!(msg.reply_to_context && String(msg.reply_to_context).trim());
    if (!isReply) {
      const haystack = `${subj}\n${msg.body_text || ""}`.toLowerCase();
      const hit = contentSkip.find((p) => p && haystack.includes(p));
      if (hit) return { result: "skip", skipReason: `content_skip: ${hit}` };
    }
  }

  return { result: "needs_claude" };
}
