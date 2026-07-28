// The deterministic pre-AI filter. Every message in the system passes through
// preClassify before a single token is paid for, so a mistake here is either a
// real task silently dropped or money spent on noise — and neither leaves a
// trace anyone would notice.
//
// Run: deno test supabase/functions/ai-process/

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  addBusinessHours,
  buildCategoryFilter,
  isBusinessDay,
  preClassify,
  subBusinessHours,
} from "./preclassify.ts";

const SYS = { calendar_past_days: 1 };

/** Settings with everything switched off; each test opts into what it needs. */
function settings(over: Record<string, unknown> = {}) {
  return {
    my_emails: [],
    office_addresses: [],
    skip_senders: [],
    skip_recipients: [],
    __toSkip: new Set<string>(),
    __fromSkip: new Set<string>(),
    __contentSkip: [] as string[],
    __category_filter: new Set<string>(),
    ...over,
  };
}

const DAY = 86_400_000;

Deno.test("plain inbound mail needs the model", () => {
  const r = preClassify({ source_type: "gmail", sender_email: "them@corp.com" }, settings(), SYS);
  assertEquals(r.result, "needs_claude");
});

// ── rules_memory skip rules ────────────────────────────────────────────────

Deno.test("to= rule matches the BCC / forwarded-to addresses, not just the To header (T367)", () => {
  // The visible To is a customer; the user is only on the Bcc. Matching just
  // the To header is why this family of rules quietly did nothing.
  const msg = {
    source_type: "gmail",
    sender_email: "office@corp.com",
    recipient: "customer@elsewhere.com",
    metadata: { recipients: ["customer@elsewhere.com", "outbox@corp.com"] },
  };
  const r = preClassify(msg, settings({ __toSkip: new Set(["outbox@corp.com"]) }), SYS);
  assertEquals(r.result, "skip");
  assert(r.skipReason?.startsWith("to_rule:"));
});

Deno.test("from= rule skips a matching sender", () => {
  const r = preClassify(
    { source_type: "gmail", sender_email: "news@spammy.com" },
    settings({ __fromSkip: new Set(["spammy.com"]) }),
    SYS,
  );
  assertEquals(r.result, "skip");
});

Deno.test("from= rule NEVER swallows the user's own outgoing mail", () => {
  // Regression guard for the 2026-07 fix: a from= rule on a shared domain used
  // to eat the user's own sent mail before the follow-up path ever saw it, so
  // "I asked them for X and never heard back" produced no tracker at all.
  const msg = { source_type: "gmail", sender_email: "me@corp.com" };
  const s = settings({ my_emails: ["me@corp.com"], __fromSkip: new Set(["corp.com"]) });
  assertEquals(preClassify(msg, s, SYS).result, "check_followup");
});

Deno.test("skip_senders is an honest 'skip', not 'informational'", () => {
  // Changed 2026-07 to match the Gmail-category filter: a sender the user asked
  // to drop is filtered noise, and the log should say so.
  const r = preClassify(
    { source_type: "gmail", sender_email: "noise@bulk.com" },
    settings({ skip_senders: ["noise@bulk.com"] }),
    SYS,
  );
  assertEquals(r.result, "skip");
  assert(r.skipReason?.startsWith("skip_sender:"));
});

// ── Gmail category filter ──────────────────────────────────────────────────

Deno.test("buildCategoryFilter: promotions/social/forums off by default, updates kept", () => {
  const f = buildCategoryFilter([]);
  assert(f.has("CATEGORY_PROMOTIONS"));
  assert(f.has("CATEGORY_SOCIAL"));
  assert(f.has("CATEGORY_FORUMS"));
  assert(!f.has("CATEGORY_UPDATES"));
});

Deno.test("buildCategoryFilter: an explicit rule overrides the default either way", () => {
  assert(buildCategoryFilter([{ trigger: "category=updates", is_active: true }]).has("CATEGORY_UPDATES"));
  assert(!buildCategoryFilter([{ trigger: "category=promotions", is_active: false }]).has("CATEGORY_PROMOTIONS"));
  // rules_memory holds from=/to=/contains= rows too. A non-category rule must
  // be ignored outright — not misparsed into enabling or disabling a category —
  // so the defaults are exactly what they'd be with no rules at all.
  const withUnrelated = buildCategoryFilter([{ trigger: "from=x@y.com", is_active: true }]);
  assertEquals([...withUnrelated].sort(), [...buildCategoryFilter([])].sort());
});

Deno.test("a filtered Gmail category is dropped, and the reason names the label", () => {
  const r = preClassify(
    { source_type: "gmail", sender_email: "deals@shop.com", metadata: { labels: ["CATEGORY_PROMOTIONS"] } },
    settings({ __category_filter: buildCategoryFilter([]) }),
    SYS,
  );
  assertEquals(r.result, "skip");
  assertEquals(r.skipReason, "gmail_category:CATEGORY_PROMOTIONS");
});

// ── source-type routing ────────────────────────────────────────────────────

Deno.test("self-notes go straight to the model, never to the follow-up defer", () => {
  // whatsapp_echo / sms_echo are deliberate task captures, not messages
  // awaiting anyone's reply. Deferring them 48h is how voice memos vanished.
  for (const source_type of ["whatsapp_echo", "sms_echo"]) {
    assertEquals(preClassify({ source_type }, settings(), SYS).result, "needs_claude");
  }
});

Deno.test("sent mail is routed to the follow-up check", () => {
  assertEquals(preClassify({ source_type: "gmail_sent" }, settings(), SYS).result, "check_followup");
});

Deno.test("an office address is business correspondence, never spam", () => {
  const r = preClassify(
    { source_type: "gmail", sender_email: "hello@office.com" },
    settings({ office_addresses: ["hello@office.com"] }),
    SYS,
  );
  assertEquals(r.result, "customer_inquiry");
});

Deno.test("Drive documents are always actionable", () => {
  assertEquals(preClassify({ source_type: "google_drive" }, settings(), SYS).result, "drive_actionable");
});

// ── calendar windowing ─────────────────────────────────────────────────────

Deno.test("calendar: past events are skipped, far-future deferred, imminent processed", () => {
  const now = Date.now();
  const at = (ms: number) => ({ source_type: "google_calendar", received_at: new Date(ms).toISOString() });

  assertEquals(preClassify(at(now - 10 * DAY), settings(), SYS).result, "skip");
  // 24 business hours back from an event is at most ~4 calendar days, so a
  // month out is always still deferred regardless of which day the suite runs.
  assertEquals(preClassify(at(now + 30 * DAY), settings(), SYS).result, "defer");
  // An event an hour away is inside the lead window on any day of the week.
  assertEquals(preClassify(at(now + 3600_000), settings(), SYS).result, "calendar_actionable");
});

// ── Google Workspace storage threshold ─────────────────────────────────────

Deno.test("Workspace storage warnings only surface at 95% or more", () => {
  const at = (pct: number) => ({
    source_type: "gmail",
    sender_email: "workspace-noreply@google.com",
    subject: "Approaching pooled storage limit",
    body_text: `You are currently using ${pct}% of your storage.`,
  });
  assertEquals(preClassify(at(81), settings(), SYS).result, "skip");
  assertEquals(preClassify(at(90), settings(), SYS).result, "skip");
  assertEquals(preClassify(at(96), settings(), SYS).result, "needs_claude");
});

// ── content skip ───────────────────────────────────────────────────────────

Deno.test("content skip drops a first-contact transactional notice", () => {
  const r = preClassify(
    { source_type: "gmail", sender_email: "billing@shop.com", subject: "Your receipt", body_text: "payment received, thanks" },
    settings({ __contentSkip: ["payment received"] }),
    SYS,
  );
  assertEquals(r.result, "skip");
  assert(r.skipReason?.startsWith("content_skip:"));
});

Deno.test("content skip never fires inside a live reply thread", () => {
  // "...the package was delivered, but can you..." is a real ask that happens
  // to quote a skip phrase. The first-contact guard is the whole reason the
  // phrase list is safe to apply at all.
  const s = settings({ __contentSkip: ["payment received"] });
  const asReply = {
    source_type: "gmail",
    sender_email: "them@corp.com",
    subject: "Re: invoice",
    body_text: "payment received, but can you resend the invoice?",
  };
  assertEquals(preClassify(asReply, s, SYS).result, "needs_claude");

  // Same, detected via reply_to_context rather than the subject prefix.
  const threaded = { ...asReply, subject: "invoice", reply_to_context: "them@corp.com" };
  assertEquals(preClassify(threaded, s, SYS).result, "needs_claude");
});

Deno.test("content skip is Gmail-only — a chat is never dropped on a phrase", () => {
  const r = preClassify(
    { source_type: "whatsapp", raw_content: "payment received" },
    settings({ __contentSkip: ["payment received"] }),
    SYS,
  );
  assertEquals(r.result, "needs_claude");
});

// ── business-hours math ────────────────────────────────────────────────────

Deno.test("business hours never land on a weekend and jump over it", () => {
  // Anchor on a real Friday, found rather than hardcoded so the assertion is
  // about the arithmetic and not about a magic date.
  const friday = new Date(2026, 0, 1, 10, 0, 0);
  while (friday.getDay() !== 5) friday.setDate(friday.getDate() + 1);

  const plus = addBusinessHours(friday, 24);
  assert(isBusinessDay(plus), "a business-hours result must be a business day");
  // 24 business hours from Friday morning must cross the weekend, so the
  // wall-clock gap is strictly more than 24h.
  assert(plus.getTime() - friday.getTime() > 24 * 3600_000);

  const minus = subBusinessHours(friday, 24);
  assert(isBusinessDay(minus));
  assert(friday.getTime() - minus.getTime() >= 24 * 3600_000);
});

Deno.test("isBusinessDay: only Saturday and Sunday are weekend", () => {
  const days = [0, 1, 2, 3, 4, 5, 6].map((target) => {
    const d = new Date(2026, 0, 1);
    while (d.getDay() !== target) d.setDate(d.getDate() + 1);
    return isBusinessDay(d);
  });
  assertEquals(days, [false, true, true, true, true, true, false]);
});
