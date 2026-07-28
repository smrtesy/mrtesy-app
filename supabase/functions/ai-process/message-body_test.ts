// What the model actually gets to read. Truncation decisions here are
// invisible when they go wrong — the model answers confidently about the part
// of the message it saw — so each case below is a message that was mis-handled
// in production before the rule existed.
//
// Run: deno test supabase/functions/ai-process/

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  bodyForAI,
  bodyForClassify,
  extractMeetingBlock,
  hasMeetingInvite,
  isConversational,
  isWhatsApp,
  splitChatByHighWater,
  stripLoneSurrogates,
  threadKey,
} from "./message-body.ts";

// ── channel predicates ─────────────────────────────────────────────────────

Deno.test("conversational = WhatsApp and SMS, both directions", () => {
  for (const t of ["whatsapp", "whatsapp_echo", "sms", "sms_echo"]) {
    assert(isConversational({ source_type: t }), t);
  }
  for (const t of ["gmail", "gmail_sent", "google_calendar", "google_drive"]) {
    assertFalse(isConversational({ source_type: t }), t);
  }
  assert(isWhatsApp({ source_type: "whatsapp_echo" }));
  assertFalse(isWhatsApp({ source_type: "sms" }));
});

Deno.test("bodyForAI: chats carry the rolling transcript, email carries body_text", () => {
  assertEquals(bodyForAI({ source_type: "whatsapp", raw_content: "transcript", body_text: "ignored" }), "transcript");
  assertEquals(bodyForAI({ source_type: "gmail", body_text: "the mail" }), "the mail");
});

// ── thread keys ────────────────────────────────────────────────────────────

Deno.test("threadKey: a self-note shares memory with nothing (the 8-voice-memo bug)", () => {
  // Each echo row is an independent intention. Sharing the parent chat's
  // thread memory linked all eight memos to one task and lost seven of them.
  assertEquals(threadKey({ source_type: "whatsapp_echo", metadata: { chatId: "c1" } }), null);
  assertEquals(threadKey({ source_type: "sms_echo", metadata: { chatId: "c1" } }), null);
});

Deno.test("threadKey: gmail keys by thread, chats key by chat, missing id yields null", () => {
  assertEquals(threadKey({ source_type: "gmail", metadata: { threadId: "t1" } }), "gmail:t1");
  assertEquals(threadKey({ source_type: "gmail_sent", metadata: { threadId: "t1" } }), "gmail:t1");
  assertEquals(threadKey({ source_type: "whatsapp", metadata: { chatId: "c1" } }), "whatsapp:c1");
  assertEquals(threadKey({ source_type: "sms", metadata: { chatId: "c1" } }), "sms:c1");
  assertEquals(threadKey({ source_type: "gmail", metadata: {} }), null);
  assertEquals(threadKey({ source_type: "google_calendar", metadata: { threadId: "t1" } }), null);
});

// ── truncation direction ───────────────────────────────────────────────────

Deno.test("truncation keeps the HEAD of an email and the TAIL of a chat", () => {
  const long = "S".repeat(50) + "M".repeat(50) + "E".repeat(50);

  const email = bodyForClassify({ source_type: "gmail", body_text: long }, 50);
  assertEquals(email, "S".repeat(50));

  // A chat runs oldest→newest and the decision lives in the last line, so
  // head-truncating drops exactly the "please do X" that matters.
  const chat = bodyForClassify({ source_type: "whatsapp", raw_content: long }, 50);
  assertStringIncludes(chat, "E".repeat(50));
  assert(chat.startsWith("…"));
});

Deno.test("a body under the limit is passed through untouched", () => {
  const short = "just a line";
  assertEquals(bodyForClassify({ source_type: "gmail", body_text: short }, 500), short);
});

// ── meeting rescue ─────────────────────────────────────────────────────────

Deno.test("hasMeetingInvite recognises the real join-link shapes", () => {
  const yes = [
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
    "https://teams.live.com/meet/93123",
    "https://us02web.zoom.us/j/8412345678",
    "https://meet.google.com/abc-defg-hij",
    "https://company.webex.com/meet/someone",
    "https://whereby.com/team-room",
  ];
  for (const u of yes) assert(hasMeetingInvite(`text ${u} text`), u);

  const no = ["https://example.com/zoom-tips", "https://corp.com/meet-the-team", "no link at all"];
  for (const u of no) assertFalse(hasMeetingInvite(u), u);
});

Deno.test("a meeting link past the truncation window is rescued to the top, verbatim", () => {
  // The exact miss this exists for: a Teams meeting with a lawyer whose join
  // link sat at ~char 3500 while the classifier truncated at 2000, so the
  // thread was filed as "informational closure".
  const joinUrl =
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_" +
    "Y".repeat(600) +
    "?context=%7b%22Tid%22%3a%22abc%22%7d";
  const body = "quoted history ".repeat(200) + "\nMicrosoft Teams meeting\n" + joinUrl + "\nMeeting ID: 123 456 789\nPasscode: xyz";

  const out = bodyForClassify({ source_type: "gmail", body_text: body }, 2000);
  assert(out.startsWith("[MEETING DETAILS"), "the block must be grafted on top");
  // Deep-link rule: the ENTIRE url survives, query string included.
  assertStringIncludes(out, joinUrl);
  assertStringIncludes(out, "Meeting ID: 123 456 789");
  assertStringIncludes(out, "Passcode: xyz");
});

Deno.test("extractMeetingBlock returns null when there is no join link", () => {
  assertEquals(extractMeetingBlock("just a normal email about a meeting next week"), null);
});

Deno.test("no meeting link means the body is returned unchanged", () => {
  const body = "plain mail";
  assertEquals(bodyForClassify({ source_type: "gmail", body_text: body }, 2000), body);
});

// ── Chat high-water split (WhatsApp AND SMS) ───────────────────────────────

const HEADER = "Chat: Dini\nPhone: +1-555-0100\n---";
const OLD_LINE = "[INCOMING 2026-06-09T10:00:00] here are the materials";
const NEW_LINE = "[INCOMING 2026-06-12T09:00:00] can you put money in the canteen?";

Deno.test("no high-water mark means the whole transcript is new", () => {
  const raw = `${HEADER}\n${OLD_LINE}\n${NEW_LINE}`;
  assertEquals(splitChatByHighWater(raw, null), raw);
  // An unparseable timestamp must fail OPEN to the same behaviour, never drop
  // the transcript.
  assertEquals(splitChatByHighWater(raw, "not-a-date"), raw);
});

Deno.test("everything already processed yields an explicit nothing-new marker (T736)", () => {
  // The rolling 20-message window kept re-presenting a days-old matter, and the
  // builder kept rebuilding it as a brand-new task stamped today.
  const raw = `${HEADER}\n${OLD_LINE}`;
  const out = splitChatByHighWater(raw, "2026-06-10T00:00:00");
  assertStringIncludes(out, "No new messages");
  assertFalse(out.includes("NEW MESSAGES"));
});

Deno.test("a mixed transcript is split into context and new material", () => {
  const raw = `${HEADER}\n${OLD_LINE}\n${NEW_LINE}`;
  const out = splitChatByHighWater(raw, "2026-06-10T00:00:00");
  assertStringIncludes(out, "EARLIER CONTEXT");
  assertStringIncludes(out, "NEW MESSAGES");
  // The old line must be present as context but below the marker; the new line
  // must be in the new section.
  assert(out.indexOf(OLD_LINE) < out.indexOf("NEW MESSAGES"));
  assert(out.indexOf(NEW_LINE) > out.indexOf("NEW MESSAGES"));
  assertStringIncludes(out, "Chat: Dini");
});

Deno.test("continuation lines inherit the timestamp of the line above them", () => {
  // OCR output and multi-line message bodies carry no [ts] marker of their own.
  // Without carrying the bucket forward they'd land in the wrong section.
  const raw = [HEADER, OLD_LINE, "  (OCR) page two of the old doc", NEW_LINE, "  second line of the new ask"].join("\n");
  const out = splitChatByHighWater(raw, "2026-06-10T00:00:00");
  const boundary = out.indexOf("NEW MESSAGES");
  assert(out.indexOf("page two of the old doc") < boundary, "old continuation stays in context");
  assert(out.indexOf("second line of the new ask") > boundary, "new continuation stays in the new section");
});

// ── surrogate hygiene ──────────────────────────────────────────────────────

Deno.test("stripLoneSurrogates drops dangling halves and keeps whole emoji", () => {
  // Truncating by code unit can cut an emoji in half; the API then rejects the
  // whole request with a 400 before processing a single token.
  assertEquals(stripLoneSurrogates("hi 😀 there"), "hi 😀 there");
  assertEquals(stripLoneSurrogates("cut \uD83D"), "cut ");
  assertEquals(stripLoneSurrogates("\uDE00 orphan low"), " orphan low");
  assertEquals(stripLoneSurrogates("plain ascii"), "plain ascii");
});

Deno.test("the high-water split is format-based, so an SMS transcript splits identically", () => {
  // SMS was left out of the caller's gate until 2026-07-28 even though its
  // webhook builds the same rolling window — every burst re-presented old lines
  // and the builder made fresh tasks from them (T1735/T1736). The splitter
  // itself was never WhatsApp-specific; only the call site was.
  const smsRaw = [
    "Chat: +1-555-0100",
    "---",
    "[INCOMING 2026-07-16T09:00:00] your order is ready for a delivery slot",
    "[INCOMING 2026-07-23T11:56:00] reminder: pick a slot for Shabbos",
  ].join("\n");
  const out = splitChatByHighWater(smsRaw, "2026-07-20T00:00:00");
  const boundary = out.indexOf("NEW MESSAGES");
  assert(boundary > -1, "a mixed SMS transcript must be split, not passed through");
  assert(out.indexOf("your order is ready") < boundary, "the week-old line is context");
  assert(out.indexOf("pick a slot for Shabbos") > boundary, "only the new line is actionable");
});
