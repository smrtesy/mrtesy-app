// EXTRACTED FROM index.ts (2026-07-28) — pure helpers, no I/O, no Deno
// globals, so they can be unit-tested directly (see *_test.ts next to this
// file). Moved verbatim; every comment below documents a real production bug
// the rule exists to prevent. Keep them pure: the moment one of these needs
// `supabase` or `fetch`, it belongs back in index.ts.

/** Body extraction, truncation, meeting rescue, WhatsApp high-water split. */

export function isWhatsApp(msg: any): boolean {
  return msg.source_type === "whatsapp" || msg.source_type === "whatsapp_echo";
}

// WhatsApp AND SMS are two-party rolling-transcript chats — both carry a
// [INCOMING]/[OUTGOING] conversation in raw_content and get the conversation-
// aware handling (transcript body, chat rules, thread memory, per-matter
// routing, follow-up defer). isWhatsApp stays for the genuinely WhatsApp-only
// spots (self-chat echo, placeholder text, delivery-status coalescing).
export function isConversational(msg: any): boolean {
  return isWhatsApp(msg) || msg.source_type === "sms" || msg.source_type === "sms_echo";
}

export function threadKey(msg: any): string | null {
  if (msg.source_type === "gmail" || msg.source_type === "gmail_sent") {
    const tid = msg.metadata?.threadId as string | undefined;
    return tid ? `gmail:${tid}` : null;
  }
  // whatsapp_echo rows are per-message self-chat captures; each is an
  // independent new intention and should NOT share thread memory with the
  // parent WhatsApp chat (which would link every voice memo to the same
  // task via related_task_id and lose 7 of 8 captures).
  // sms_echo (self-notes) are per-message intentions like whatsapp_echo — each
  // is independent, so no shared thread memory.
  if (msg.source_type === "whatsapp_echo" || msg.source_type === "sms_echo") return null;
  if (msg.source_type === "whatsapp" || msg.source_type === "sms") {
    const cid = msg.metadata?.chatId as string | undefined;
    return cid ? `${msg.source_type}:${cid}` : null;
  }
  return null;
}

export function bodyForAI(msg: any): string {
  // Conversational channels (WhatsApp + SMS) carry the rolling transcript in
  // raw_content; everything else (email) uses body_text.
  if (isConversational(msg)) {
    return String(msg.raw_content ?? msg.body_text ?? "");
  }
  return String(msg.body_text ?? "");
}

// Video-call / meeting join links. A meeting invite buried in a reply is the
// single highest-value "actionable" an email can carry (a meeting to attend),
// yet it almost always lands at the BOTTOM of the body — beneath the quoted
// thread and past body_truncate_classify — so the classifier never sees it and
// files the thread as "informational closure". (This is exactly the miss the
// user flagged: a Teams meeting with a lawyer, link at char ~3500, classifier
// truncates at 2000.) Detect the link across the FULL, untruncated body.
// Non-global on purpose: we only ever .test()/.exec() once, so there is no
// lastIndex state to trip over.
export const MEETING_LINK_RE = /(?:https?:\/\/)?(?:[\w.-]*teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/|teams\.live\.com\/meet\/|[\w.-]*zoom\.us\/(?:j|my|w|s)\/|meet\.google\.com\/[a-z]|[\w.-]*webex\.com\/(?:meet|join|[\w.-]*\/j\.php)|[\w.-]*whereby\.com\/[\w-])/i;

export function hasMeetingInvite(body: string): boolean {
  return MEETING_LINK_RE.test(String(body));
}

// Return the meeting block (header + join URL + Meeting ID + Passcode), with a
// little context on either side, so the join URL survives verbatim. null when
// no join link is present.
export function extractMeetingBlock(body: string): string | null {
  const s = String(body);
  const m = MEETING_LINK_RE.exec(s);
  if (!m) return null;
  // The window must span the ENTIRE join URL verbatim (deep-link rule): Teams
  // `meetup-join` links carry an encoded `context` JSON and routinely run
  // 500–900 chars, so a fixed forward window would slice them mid-string. Grab
  // the full whitespace-delimited URL token, then +160 chars for the Meeting
  // ID / Passcode lines that follow, and -220 for a preceding header.
  const urlToken = (s.slice(m.index).match(/^\S*/)?.[0] ?? "").length;
  const start = Math.max(0, m.index - 220);
  const end = Math.min(s.length, Math.max(m.index + 400, m.index + urlToken + 160));
  return s.slice(start, end).trim();
}

// Body for the classifier / task-builder, capped at `limit`. When a meeting
// invite exists anywhere in the full body, graft the meeting block onto the
// TOP, tagged as fresh & actionable: this rescues invites that sit past the
// truncation window (classifier) and ones that sit below the quoted thread
// (where the task-builder's QUOTED-TEXT rule would skip them), and keeps the
// join URL verbatim (system-wide deep-link rule).
export function bodyForClassify(msg: any, limit: number): string {
  const full = bodyForAI(msg);
  // Conversational channels (WhatsApp + SMS) run oldest→newest with the
  // decision-relevant lines at the BOTTOM, so keep the TAIL; email keeps HEAD.
  const isConvo = isConversational(msg);
  // WhatsApp transcripts run oldest→newest and the prompt reasons about the
  // LAST line, so the decision-relevant messages sit at the BOTTOM. Head-
  // truncating drops exactly them — a long thread of old OCR/audio blocks once
  // pushed the latest "please do X" past the cap, so it got mis-filed as
  // informational. Keep the TAIL for WhatsApp; keep the HEAD for email (the
  // latest reply is on top, quoted history below).
  const clipped =
    full.length <= limit
      ? full
      : isConvo
        ? "…\n" + full.slice(full.length - limit)
        : full.substring(0, limit);
  const meeting = extractMeetingBlock(full);
  if (!meeting) return clipped;
  return `[MEETING DETAILS / פרטי פגישה — fresh & actionable, NOT quoted history. Keep the join URL verbatim]\n${meeting}\n\n${clipped}`;
}

// WhatsApp burst transcripts are a ROLLING 20-message window: every new
// message rebuilds raw_content as "last 20 messages" and stamps the burst's
// received_at = now. So a matter from days ago keeps re-appearing in the
// window, and the task builder re-extracts it as a brand-new task stamped
// today (T736: a 9 ביוני "Dini materials" matter rebuilt as a 12 ביוני task;
// T737 titled "נשלח ב-12/6" over 11 ביוני content). This splits the transcript
// at a high-water timestamp (the latest message already processed in a PRIOR
// burst for this chat): lines at/before it are CONTEXT-only; only lines after
// it are NEW material the builder may turn into a task. Deterministic on
// purpose — we partition the lines ourselves rather than trust the model to
// honor a "ignore old lines" instruction (it doesn't, reliably). When there is
// no high-water (first burst ever for the chat), the whole transcript is new.
export const WA_LINE_RE = /^\[(INCOMING|OUTGOING)\s+([0-9T:.\-]+)\]/;
export function splitWhatsAppByHighWater(rawBody: string, highWaterIso: string | null): string {
  if (!highWaterIso) return rawBody;
  const hw = Date.parse(highWaterIso);
  if (isNaN(hw)) return rawBody;
  const lines = String(rawBody).split("\n");
  const header: string[] = [];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  // A transcript line's timestamp governs the lines that follow it (OCR /
  // multi-line message bodies have no marker of their own), so carry the last
  // seen bucket forward. Header lines (Chat:/Phone:/Group:/--- markers) before
  // the first [ts] line stay in the header.
  let bucket: "header" | "old" | "new" = "header";
  for (const line of lines) {
    const m = line.match(WA_LINE_RE);
    if (m) {
      const ts = Date.parse(m[2]);
      bucket = !isNaN(ts) && ts > hw ? "new" : "old";
    }
    if (bucket === "header") header.push(line);
    else if (bucket === "old") oldLines.push(line);
    else newLines.push(line);
  }
  // No genuinely-new lines → nothing for the builder to act on. Return only the
  // header + a marker; the builder will correctly produce [] (and the tiny-gate
  // / empty-build paths handle it), instead of re-mining stale history.
  const headBlock = header.join("\n").trim();
  if (newLines.length === 0) {
    return `${headBlock}\n\n[No new messages since the last time this chat was processed — nothing new to act on.]`;
  }
  const ctx = oldLines.join("\n").trim();
  const fresh = newLines.join("\n").trim();
  return [
    headBlock,
    ctx ? `\n--- EARLIER CONTEXT (already processed — for understanding only, do NOT create a task from these lines) ---\n${ctx}` : "",
    `\n--- NEW MESSAGES (create a task ONLY from these) ---\n${fresh}`,
  ].filter(Boolean).join("\n");
}

// Strip UNPAIRED UTF-16 surrogates (a high surrogate not followed by a low one,
// or a low surrogate not preceded by a high one). They arise when a body is
// truncated by code-unit count (bodyForClassify slices WhatsApp text with
// .slice/.substring, which can cut an emoji's surrogate pair in half) or when
// the source itself is corrupt. JSON.stringify escapes a lone surrogate to
// \udXXX, which is syntactically "valid" but the Anthropic API's JSON parser
// rejects it with HTTP 400 "invalid high surrogate in string". A complete emoji
// (well-formed pair) is untouched; only the dangling half is dropped.
export function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
