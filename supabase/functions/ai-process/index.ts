import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

interface SystemParams {
  classification_model: string;
  summary_model: string;
  batch_size: number;
  processing_lock_minutes: number;
  calendar_past_days: number;
  calendar_future_days: number;
  body_truncate_classify: number;
  body_truncate_project: number;
  body_truncate_task: number;
  // Kill-switch for per-matter WhatsApp routing (Part A). When false, WhatsApp
  // falls back to the legacy single-slot thread_memory linking. Default true.
  whatsapp_matter_routing: boolean;
  // Debounce window (seconds) for WhatsApp burst coalescing. A WhatsApp burst
  // row is only eligible for classification once its chat has been quiet for
  // this long, so rapid follow-up messages are gathered into one classification
  // pass instead of each spawning duplicate work. The webhook stamps the burst
  // row's received_at = latest message time; while messages keep arriving that
  // timestamp advances, so the row keeps re-arming until the chat settles. This
  // is a TIMING mechanism only — it never decides matter boundaries (the
  // content-based matter router owns that). Default 90s (cron ticks every ~60s,
  // so the effective settle window is ~90–150s).
  whatsapp_debounce_seconds: number;
}

const FALLBACK_PARAMS: SystemParams = {
  classification_model: "claude-haiku-4-5-20251001",
  summary_model: "claude-sonnet-4-6",
  batch_size: 40,
  processing_lock_minutes: 10,
  calendar_past_days: 1,
  calendar_future_days: 1,
  body_truncate_classify: 2000,
  body_truncate_project: 500,
  body_truncate_task: 6000,
  whatsapp_matter_routing: true,
  whatsapp_debounce_seconds: 90,
};

async function loadSystemParams(): Promise<SystemParams> {
  const { data, error } = await supabase.from("smrttask_system_params").select("*").eq("id", "smrttask").maybeSingle();
  if (error || !data) return FALLBACK_PARAMS;
  return {
    classification_model: data.classification_model ?? FALLBACK_PARAMS.classification_model,
    summary_model: data.summary_model ?? FALLBACK_PARAMS.summary_model,
    batch_size: data.batch_size ?? FALLBACK_PARAMS.batch_size,
    processing_lock_minutes: data.processing_lock_minutes ?? FALLBACK_PARAMS.processing_lock_minutes,
    calendar_past_days: data.calendar_past_days ?? FALLBACK_PARAMS.calendar_past_days,
    calendar_future_days: data.calendar_future_days ?? FALLBACK_PARAMS.calendar_future_days,
    body_truncate_classify: data.body_truncate_classify ?? FALLBACK_PARAMS.body_truncate_classify,
    body_truncate_project: data.body_truncate_project ?? FALLBACK_PARAMS.body_truncate_project,
    body_truncate_task: data.body_truncate_task ?? FALLBACK_PARAMS.body_truncate_task,
    whatsapp_matter_routing: data.whatsapp_matter_routing ?? FALLBACK_PARAMS.whatsapp_matter_routing,
    whatsapp_debounce_seconds: data.whatsapp_debounce_seconds ?? FALLBACK_PARAMS.whatsapp_debounce_seconds,
  };
}

const SOURCE_PRIORITY = ["whatsapp", "whatsapp_echo", "google_calendar", "google_drive", "gmail", "gmail_sent"];
const BODY_TEXT_FILTER = "body_text.not.is.null,source_type.eq.whatsapp,source_type.eq.whatsapp_echo,source_type.eq.google_calendar,source_type.eq.google_drive";

const DEFAULT_FILTERED_CATEGORY_KEYS = new Set(["promotions", "social", "forums"]);
const CATEGORY_KEY_TO_GMAIL_LABEL: Record<string, string> = {
  promotions: "CATEGORY_PROMOTIONS",
  social:     "CATEGORY_SOCIAL",
  updates:    "CATEGORY_UPDATES",
  forums:     "CATEGORY_FORUMS",
};
const ALL_CATEGORY_KEYS = Object.keys(CATEGORY_KEY_TO_GMAIL_LABEL);

interface CategoryRuleRow { trigger: string; is_active: boolean }

function buildCategoryFilter(rules: CategoryRuleRow[]): Set<string> {
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

function bodyForAI(msg: any): string {
  if (msg.source_type === "whatsapp" || msg.source_type === "whatsapp_echo") {
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
const MEETING_LINK_RE = /(?:https?:\/\/)?(?:[\w.-]*teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/|teams\.live\.com\/meet\/|[\w.-]*zoom\.us\/(?:j|my|w|s)\/|meet\.google\.com\/[a-z]|[\w.-]*webex\.com\/(?:meet|join|[\w.-]*\/j\.php)|[\w.-]*whereby\.com\/[\w-])/i;

function hasMeetingInvite(body: string): boolean {
  return MEETING_LINK_RE.test(String(body));
}

// Return the meeting block (header + join URL + Meeting ID + Passcode), with a
// little context on either side, so the join URL survives verbatim. null when
// no join link is present.
function extractMeetingBlock(body: string): string | null {
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
function bodyForClassify(msg: any, limit: number): string {
  const full = bodyForAI(msg);
  const head = full.substring(0, limit);
  const meeting = extractMeetingBlock(full);
  if (!meeting) return head;
  return `[MEETING DETAILS / פרטי פגישה — fresh & actionable, NOT quoted history. Keep the join URL verbatim]\n${meeting}\n\n${head}`;
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
const FOLLOWUP_LEAD_HOURS = 48;
const MEETING_LEAD_HOURS = 24;

function isBusinessDay(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

// Advance `start` forward by `hours` business hours.
function addBusinessHours(start: Date, hours: number): Date {
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
function subBusinessHours(start: Date, hours: number): Date {
  const d = new Date(start);
  let remaining = hours;
  while (remaining > 0) {
    d.setHours(d.getHours() - 1);
    if (isBusinessDay(d)) remaining--;
  }
  return d;
}

function preClassify(msg: any, settings: any, sys: SystemParams): { result: string; skipReason?: string } {
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
  for (const addr of fromSkip) {
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
  if (sourceType === "whatsapp_echo") return { result: "needs_claude" };
  if (sourceType === "gmail_sent") return { result: "check_followup" };
  if (myEmails.some((e: string) => sender.includes(e))) return { result: "check_followup" };
  if (officeAddresses.some((e: string) => sender.includes(e))) return { result: "customer_inquiry" };
  if (skipSenders.some((e: string) => sender.includes(e))) return { result: "informational", skipReason: `skip_sender: ${sender}` };

  if (categoryFilter.size > 0) {
    const informationalLabel = gmailLabels.find((l) => categoryFilter.has(l));
    if (informationalLabel) return { result: "informational", skipReason: `gmail_category:${informationalLabel}` };
  }

  return { result: "needs_claude" };
}

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

// Mark a large, message-invariant instruction block for prompt caching.
// The cached prefix must be byte-identical across calls to hit (5-min TTL),
// so ALL per-message context (identity, memory, project, body) must live in
// the user message, never here. The ai-process cron runs every minute — well
// inside the 5-minute TTL — so the cached prefix stays warm and reads dominate.
function cachedSystem(staticPrompt: string): SystemBlock[] {
  return [{ type: "text", text: staticPrompt, cache_control: { type: "ephemeral" } }];
}

async function callClaude(model: string, system: string | SystemBlock[], userMessage: string, maxTokens: number = 1024, meta?: { component: string; userId?: string; refId?: string }) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userMessage }] }),
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error(`Claude API ${resp.status}: ${err}`); }
  const data = await resp.json();
  const usage = {
    text: data.content?.[0]?.text || "",
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
    cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0,
  };
  // Unified cost ledger — one row per paid call (best-effort; never blocks processing).
  if (meta) {
    try {
      await supabase.from("ai_usage").insert({
        user_id: meta.userId ?? null,
        provider: "anthropic",
        component: meta.component,
        model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cost_usd: estimateCost(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, modelTypeFromName(model)),
        ref_id: meta.refId ?? null,
      });
    } catch (_e) { /* ledger insert must not break the pipeline */ }
  }
  return usage;
}

function isWhatsApp(msg: any): boolean {
  return msg.source_type === "whatsapp" || msg.source_type === "whatsapp_echo";
}

function threadKey(msg: any): string | null {
  if (msg.source_type === "gmail" || msg.source_type === "gmail_sent") {
    const tid = msg.metadata?.threadId as string | undefined;
    return tid ? `gmail:${tid}` : null;
  }
  // whatsapp_echo rows are per-message self-chat captures; each is an
  // independent new intention and should NOT share thread memory with the
  // parent WhatsApp chat (which would link every voice memo to the same
  // task via related_task_id and lose 7 of 8 captures).
  if (msg.source_type === "whatsapp_echo") return null;
  if (msg.source_type === "whatsapp") {
    const cid = msg.metadata?.chatId as string | undefined;
    return cid ? `whatsapp:${cid}` : null;
  }
  return null;
}

interface ThreadMemoryRow {
  id: string;
  user_id: string;
  thread_key: string;
  summary: string;
  state: "open" | "pending_user_action" | "pending_other_party" | "resolved";
  related_task_id: string | null;
  last_message_id: string | null;
}

async function loadThreadMemory(userId: string, key: string): Promise<ThreadMemoryRow | null> {
  const { data } = await supabase
    .from("thread_memory")
    .select("*")
    .eq("user_id", userId)
    .eq("thread_key", key)
    .maybeSingle();
  return (data as ThreadMemoryRow | null) ?? null;
}

async function upsertThreadMemory(userId: string, key: string, fields: Partial<ThreadMemoryRow>) {
  await supabase.from("thread_memory").upsert(
    { user_id: userId, thread_key: key, ...fields, updated_at: new Date().toISOString() },
    { onConflict: "user_id,thread_key" },
  );
}

interface ThreadAnalysis {
  classification: "actionable" | "informational" | "spam";
  reason: string;
  newSummary: string;
  state: "open" | "pending_user_action" | "pending_other_party" | "resolved";
  completionSignal: boolean;
  completionReason: string;
  // True when this message opens a matter DISTINCT from what the linked task
  // tracks (a different action/topic), rather than continuing the same one.
  // Drives the "spin off a new task vs reopen/append" decision in Path 1.
  newMatter: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
}

// Current wall-clock time in the user's timezone, appended to the per-message
// user content (NOT the cached static prefix, so the cache stays warm). Without
// a clock anchor the model cannot tell that a stated time window has already
// passed, cannot reason about "today/tomorrow" priority, and — the bug this was
// added for (T458) — carries a stale, event-contingent time window forward even
// after the event that defined it was cancelled. The newest [ts] line plus this
// "now" let it re-derive availability instead.
function nowContextLine(): string {
  const tz = "Asia/Jerusalem";
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const weekday = new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "long" }).format(now);
  return `Current date/time (${tz}): ${date} ${time} (${weekday}). Treat this as "now" when reasoning about deadlines, "today/tomorrow", and whether a stated time window has already passed.`;
}

async function analyzeWithMemory(
  msg: any,
  memory: ThreadMemoryRow | null,
  settings: any,
  sys: SystemParams,
): Promise<ThreadAnalysis> {
  const model = sys.classification_model;
  const myEmails: string[] = settings.my_emails ?? [];
  const officeAddresses: string[] = settings.office_addresses ?? [];
  const userName: string = settings.__userName ?? "";
  const identityLines: string[] = [];
  if (myEmails.length > 0) identityLines.push(`User's own addresses (outgoing): ${myEmails.join(", ")}`);
  if (officeAddresses.length > 0) identityLines.push(`User's office/customer-facing addresses: ${officeAddresses.join(", ")}. Business correspondence — never spam.`);
  if (userName) identityLines.push(`User's first name: ${userName}. Use "${userName}" instead of "המשתמש" in all Hebrew output fields (reason_he, completion_reason_he, new_summary).`);
  const identityBlock = identityLines.length > 0 ? `\n\n${identityLines.join("\n")}` : "";

  const memoryBlock = memory && memory.summary
    ? `\n\nExisting thread summary (previous messages already processed):\n"""${memory.summary}"""\nThread state so far: ${memory.state}${memory.related_task_id ? `\nLinked task exists.` : ""}`
    : memory
      ? `\n\n(Empty thread summary so far. This may be the first or second message.)`
      : "";

  const whatsappNote = isWhatsApp(msg)
    ? `\n\nWhatsApp note: the body is a chat transcript with [INCOMING <ts>]/[OUTGOING <ts>] markers. Reason about the LAST line in the transcript.`
    : "";

  // Static, message-invariant instructions → cached prefix (admin-editable via
  // ai_prompts key "edge_classifier"). Per-message context (identity, memory,
  // WhatsApp note) is appended to the user message below so the cache stays warm.
  const staticPrompt = settings.__prompts?.classifier ?? `You are a message classifier and thread-state tracker for a personal task management system.

═══ HARDEST RULE — READ FIRST ═══

If the message comes from a service provider (lawyer, accountant, doctor's
office, bank, vendor, agent, school, government office, contractor) and
contains ANY of these signals:

  • "we are looking into it"
  • "we are working on it"
  • "I'll get back to you"
  • "we will update you"
  • "we received your request/question/inquiry"
  • "we are currently <verb-ing>"
  • Hebrew equivalents: "אנחנו בודקים", "נחזור אליך", "נעדכן", "אנחנו עובדים על"

then the classification is ACTIONABLE. No exceptions. The reasoning is:
the user asked them to do something, they promised to follow up, and the
user now needs a tracker so the promise does not silently expire. The
title of the task should be in the form "לעקוב אחרי <party> על <topic>".

NEVER classify such a message as INFORMATIONAL just because "no immediate
step is required". The action IS the tracking.

═══ FULL CLASSIFICATION RULES ═══

You will receive the NEW message. Classify it AND update the running thread state in a single JSON response.

Return ONLY a JSON object with this exact shape (Hebrew strings, no markdown):
{
  "classification": "ACTIONABLE" | "INFORMATIONAL" | "SPAM",
  "reason_he": "short Hebrew explanation",
  "new_summary": "Hebrew, ≤ 400 chars. Incorporates this new message into the running thread context. State the current open question and who owes the next step.",
  "state": "open" | "pending_user_action" | "pending_other_party" | "resolved",
  "completion": true | false,
  "completion_reason_he": "if completion=true, brief Hebrew explanation; else empty string",
  "new_matter": true | false
}

- ACTIONABLE = either (a) the user must take a concrete step now, OR
  (b) the message is a pending matter the user MUST keep tracking until it
  resolves. The HARDEST RULE above is the most common case of (b).

  Other ACTIONABLE pending matters (no immediate step, but must track):
    • Legal case / collection / dispute in progress
    • Medical test / lab work / specialist referral pending
    • Loan / mortgage / refund application under review
    • Insurance claim / appeal in progress
    • Delivery in transit / order being prepared
    • Vendor / contractor / agent quote pending
    • Business deal / negotiation in progress
    • Meeting / video-call invitation — a Teams / Zoom / Google Meet / Webex
      join link, or a "MEETING DETAILS" block, means the user has a meeting to
      attend. ALWAYS ACTIONABLE, even if the rest of the thread looks closed
      and even if the link sits below quoted history.
    • Benefit / grant / subsidy / refund / payment / entitlement coming TO the
      user — especially when it carries an amount to collect or a future date to
      claim or use (e.g. food-stamps / EBT approved, a grant awarded, a refund
      issued, an eligibility or appointment date). The action is to REMEMBER and
      USE / collect it. Do NOT mark this INFORMATIONAL just because the message
      merely "confirms" something already known: a usable amount, or a date the
      user must act on, makes it ACTIONABLE. Title in the form
      "להשתמש ב<benefit>" / "לממש <benefit> עד <date>".

- INFORMATIONAL = read-and-forget. No tracking needed. The user did not
  initiate anything that requires a return response. Examples:
    • Marketing / newsletter / sale / promotion
    • Build, CI, server, monitoring notification ("deploy succeeded")
    • Social-network ping
    • Payment CONFIRMATION of a transaction the USER themselves made / initiated
      and considers closed (money going OUT). NOTE: money or a benefit coming TO
      the user that they still need to claim, collect, or use is ACTIONABLE — see
      the benefit/entitlement bullet above.
    • Closure acknowledgement: "thanks, all good", "סבבה", "תודה"
    • System sender (Vercel, Railway, GitHub Actions) with no human follow-up

- SPAM = clearly junk.

Default when uncertain: prefer ACTIONABLE over INFORMATIONAL. It is better
to over-track than to lose visibility on a pending matter.

completion=true means: the open matter the prior task was tracking has been
ANSWERED or RESOLVED in this message. Specifically:
  • Payment confirmed
  • Document signed and accepted
  • Decision made and communicated
  • Pending information / answer / quote / ETA / date was provided
  • The other party closed the loop on what the user was waiting for

CRITICAL — TASKS THAT TRACK A PENDING RESPONSE:
When the task title is "לחכות לתשובת X על Y" / "לעקוב אחרי X על Y" /
"wait for X's response about Y" / "follow up with X about Y", and X has
now PROVIDED that information / decision / commitment — set completion=true,
even if the user hasn't yet written back. The system has a "pending_completion"
state for exactly this case: it surfaces the resolved task for one-click
confirmation so the user doesn't have to dig through the inbox to close it.
Withholding completion=true just because the user hasn't acknowledged YET
defeats this mechanism and leaves answered questions stuck in the inbox.

Conversely, if NEW pending matters surface in the same thread (e.g. the
other party now wants something back), you still set completion=true for
the ORIGINAL open question — a new task will be created downstream for the
new matter. One task = one open question.

CRITICAL — DO NOT confuse scheduling confirmation with task completion:
If the task requires the USER to take a future action (transfer money,
attend a meeting, submit a document, make a call, pay a bill, etc.),
then confirming WHEN or HOW the action will happen is NOT completion.
completion=true only when the action itself has been done, received, or
confirmed as completed — not merely planned or scheduled.
  WRONG: task="להעביר כסף ביום שישי" → message confirms the timing is Friday → completion=true
  RIGHT: task="להעביר כסף ביום שישי" → message confirms timing → completion=false (money not sent yet)
  WRONG: task="לשלוח דו״ח" → user says "אשלח מחר" → completion=true
  RIGHT: task="לשלוח דו״ח" → user says "אשלח מחר" → completion=false (still future)

Be conservative only when the answer is genuinely partial or ambiguous
(e.g. "I'll check and get back to you" — that's still pending). When the
requested answer is plainly in the message, set completion=true.

═══ new_matter — is this a DIFFERENT open matter? ═══
new_matter=true means: this message opens an actionable matter that is
DISTINCT from what the existing thread summary / linked task was tracking
— a different action, deliverable, meeting, or topic — NOT just the next
turn of the same one. Judge against the "Existing thread summary" block.

  • Same matter continuing (more back-and-forth on the SAME question,
    a status update, the other party finally answering the original ask)
    → new_matter=false.
  • A genuinely new ask/commitment/event on top of (or after) the original
    → new_matter=true. Classic case: the original question was just
    answered (completion=true) and the conversation pivots to scheduling a
    call, sending a document, or a new request — that scheduling/request is
    a NEW matter that deserves its own task.

Set new_matter=false when classification is not ACTIONABLE, or when there
is no existing thread summary (first message — there is nothing to be
distinct from). Default to false when unsure: re-opening or appending to
the known task is safer than spawning a duplicate.

IGNORE quoted text (after "On … wrote:" or starting with "> ") — that history is
already captured in new_summary's prior version. Base decisions on the FRESHLY
written portion of the message only.

If the user's own address is the sender:
- Their own commitment ("אחזור", "אבדוק") → ACTIONABLE (they owe follow-through), state=pending_user_action
- Just acknowledging closure → INFORMATIONAL

═══ COMMITMENT vs POSSIBILITY vs STATEMENT — wording rule (mandatory) ═══
THREE registers — never collapse one into another in reason_he / new_summary.

(1) Soft possibility (modal / conditional / tentative):
    EN: "I can try", "I might", "I'll see", "I could", "let me try",
        "if I have time", "perhaps", "maybe I'll",
        "I might be able to"
    HE: "אנסה", "אולי אעשה", "אם יהיה לי זמן", "אני יכול לנסות",
        "אבדוק אם אפשר", "אולי", "ייתכן ש", "אני אשתדל"
    → "אמר שיכול לנסות" / "הציע לנסות" / "ציין שאולי יבדוק".
    NEVER use "התחייב" / "הבטיח" for these.

(2) Statement of intent (plain future tense, no promise vocabulary):
    EN: "I will call", "I'll send tomorrow", "I'm going to pay",
        "you'll have it by Friday", "let's meet at 3"
    HE: "אתקשר", "אשלח", "אעדכן", "אבדוק" (unhedged future),
        "אסיים", "אעביר עד מחר", "ניפגש ב-3"
    → "אמר שיתקשר" / "אמר שישלח" / "ציין שיעדכן" /
      "Wagner אמר שיבדוק".
    Plain future-tense is NOT a commitment. The speaker stated what
    they intend to do; they did NOT make an explicit promise. NEVER
    write "התחייב" / "הבטיח" for these — that's misleading.

(3) Explicit promise / commitment ONLY:
    EN: "I promise to call", "I commit to send", "you have my word",
        "I guarantee", "I pledge to"
    HE: "מבטיח שאתקשר", "מתחייב לשלוח", "מתחייב להעביר",
        "ערב לכך ש", "נשבע ש", "מילתי על"
    → "התחייב להתקשר" / "הבטיח לשלוח" — appropriate ONLY here.
    The speaker must use explicit promise vocabulary
    (promise/commit/guarantee/pledge/מבטיח/מתחייב/ערב/נשבע).

WORKED EXAMPLES:
  Input: "I will call AT&T tomorrow"
  WRONG: "Chanoch התחייב להתקשר ל-AT&T"
  RIGHT: "Chanoch אמר שיתקשר ל-AT&T מחר"

  Input: "I can try to handle it"
  WRONG: "Chanoch התחייב לטפל"
  RIGHT: "Chanoch אמר שיכול לנסות לטפל"

  Input: "I promise I'll send the report by Friday"
  RIGHT: "Chanoch הבטיח לשלוח את הדו״ח עד שישי"
  (explicit "I promise" → "הבטיח" is correct)

When in doubt between (2) and (3): default to "אמר ש" / "ציין ש". Saying
someone committed when they merely stated intent erodes the user's
trust in the system's wording.

═══ GROUNDING — NO FABRICATION (mandatory) ═══
reason_he / new_summary may attribute to a party ONLY what they literally
said. This is separate from the register rule above: even when you pick
"אמר ש" correctly, you must not INVENT the object or scope of the statement,
and you must not move a topic raised by one party onto another party.

  • Vague / impersonal acknowledgements — "יטופל", "נטפל בזה", "אני אדאג",
    "we'll handle it", "I'll take care of it", "leave it with me" — are NOT
    a commitment to any SPECIFIC sub-task. Report them as the vague statement
    they are, quoted: 'אמר ש"יטופל"' / 'ציין שייטפל בכך'. NEVER expand "יטופל"
    into "אמר/התחייב שיבדוק את <נושא ספציפי>".
  • If party A asked about topic X and party B answered only "I don't know",
    do NOT later write that B will check / committed to checking X. B said
    nothing about X beyond not knowing.
  • A topic the USER raised (or said they don't know about) does NOT
    automatically become something the OTHER party agreed to handle. Attribute
    each open item to whoever actually owns it per the literal text; if it is
    unowned, say it is still open — do not assign it to anyone.

WORKED EXAMPLE (the failure this rule prevents):
  Thread: user asked an accountant to prepare a final statement; user asked
  about salary (answered) and about "בוטמן" (user said "I don't know"); the
  accountant replied only "יטופל".
  WRONG: "רוה״ח התחייב לבדוק את נושא בוטמן ולהכין את החשבון" — fabricates a
         בוטמן commitment that was never made and mis-registers "יטופל".
  RIGHT: 'רוה״ח אמר ש"יטופל" — נדרש מעקב על החשבון הסופי. נושא בוטמן עדיין
         פתוח (המשתמש לא ידע).'

═══ SUPERSESSION — NEWER FACTS REPLACE STALE ONES (mandatory) ═══
new_summary / reason_he describe the situation AS OF THE LATEST message —
not a pile of every state the thread passed through. When a newer line
changes a premise an earlier line established, REPLACE the stale premise;
never state both side by side.
  • Time windows and deadlines that were CONTINGENT on an event need
    special care. If a window was framed as "after my 4:00 meeting, before
    I leave at 6:00" and a later line says that meeting was postponed or
    cancelled, the window NO LONGER HOLDS — the constraint that created it
    is gone. Re-derive availability from the latest facts. A postponed or
    cancelled blocker WIDENS availability; it does not preserve the old
    narrow window.
  • Use the [INCOMING <ts>]/[OUTGOING <ts>] timestamps and the current
    date/time given above to decide which fact is newest. The newest
    statement wins.
  • Never produce a summary that contradicts itself (e.g. "the blocking
    meeting was postponed AND there is a narrow window 5–6"). If both
    cannot be true now, keep only the one true as of the last line.
WORKED EXAMPLE (the failure this prevents):
  Voice memo: "I have a 4:00 meeting, hope it ends ~5:00, then I'll try; at
  6:00 I leave — so let's try in that 5–6 window." Later line: "the meeting
  was postponed."
  WRONG: "...the blocking meeting was postponed and there is a narrow 5–6
         window today..." — self-contradictory; the 5–6 bound came from the
         now-cancelled meeting.
  RIGHT: "פגישת ה-4:00 נדחתה, כך שאילוץ ה-5–6 הקודם כבר לא חל — יש עכשיו
         יותר זמן עד היציאה ב-6:00. עדיין צריך לבצע את שיחת הוועידה."

═══ NATURAL HEBREW — NO INVENTED WORDS OR SYSTEM JARGON (mandatory) ═══
  • Use the user's own verb. If they wrote "לעשות שיחת ועידה" / "אעשה
    שיחה", say "לעשות" / "לקיים שיחת ועידה" — do NOT invent an ill-fitting
    verb (e.g. "להערים", which is not a real fit) or paraphrase into
    something they never said.
  • Plain Hebrew, not calques. "the conditions hold / are met" → "הכל
    מסודר" / "אפשר להתקדם", never the literal "התנאים עומדים".
  • Never inject internal/PM jargon into user-facing text. A meeting that
    was in the way is "הפגישה שעיכבה" / "הפגישה החוסמת" — never "הפגישה
    בחוסם" (the word "חוסם"/blocker belongs to app-status tracking, not
    task text).
  • Never introduce a name, number, or detail absent from the message. If
    the other party is "שוויגער"/Miryam, do not invent a different name.

═══ WORKED EXAMPLE ═══
Input: "Please be advised that we are currently looking into the
collection action against your son. I will let you know as soon as we
have an update." — from a law firm.
Correct output: ACTIONABLE, state=pending_other_party. reason_he should
reference HARDEST RULE: "תגובה לפניית המשתמש, עורכי הדין הבטיחו לחזור — נדרש מעקב".
INCORRECT output: INFORMATIONAL. The HARDEST RULE applies here.`;

  // Mandatory output-contract addendum, appended AFTER the (possibly
  // admin-overridden) staticPrompt so the new_matter field is always required
  // even when a tenant has customized the edge_classifier prompt. Without this,
  // a custom prompt that predates new_matter would never emit it and the
  // spin-off-vs-reopen logic in Path 1 would silently no-op for that tenant.
  const newMatterContract = `\n\n═══ OUTPUT CONTRACT — new_matter (mandatory, do not omit) ═══
In addition to any shape above, the JSON you return MUST include the boolean
field "new_matter". new_matter=true ONLY when classification is ACTIONABLE AND
this message opens a matter DISTINCT from what the existing thread summary /
linked task tracks (a different action, deliverable, meeting, or topic) — NOT
the next turn of the same one. The classic case: the original question was just
answered (completion=true) and the conversation pivots to a new ask (scheduling
a call, sending a document) — that pivot is a new_matter. Set new_matter=false
when not ACTIONABLE, when there is no prior thread summary, or when unsure.`;

  // Per-message context goes in the user message (NOT the cached system prefix).
  const contextBlock = `\n\n${nowContextLine()}${identityBlock}${memoryBlock}${whatsappNote}`;
  const userMessage = `${contextBlock ? contextBlock + "\n\n" : ""}From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\nNEW MESSAGE BODY:\n${bodyForClassify(msg, sys.body_truncate_classify)}`;

  const result = await callClaude(model, cachedSystem(staticPrompt + newMatterContract), userMessage, 800, { component: "ai_process.classify", userId: msg.user_id, refId: msg.id });
  const text = result.text.trim();
  let parsed: any = null;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch { /* fallthrough */ }

  const fallbackClass = text.toUpperCase().startsWith("ACTIONABLE")
    ? "actionable"
    : text.toUpperCase().startsWith("SPAM")
      ? "spam"
      : "informational";

  if (!parsed) {
    return {
      classification: fallbackClass as "actionable" | "informational" | "spam",
      reason: text,
      newSummary: memory?.summary ?? "",
      state: memory?.state ?? "open",
      completionSignal: false,
      completionReason: "",
      newMatter: false,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      model,
    };
  }

  const cls = String(parsed.classification ?? "").toLowerCase();
  const classification: "actionable" | "informational" | "spam" =
    cls === "actionable" ? "actionable" : cls === "spam" ? "spam" : "informational";
  const validStates = ["open", "pending_user_action", "pending_other_party", "resolved"];
  const state = validStates.includes(parsed.state) ? parsed.state : (memory?.state ?? "open");

  return {
    classification,
    reason: String(parsed.reason_he ?? ""),
    newSummary: String(parsed.new_summary ?? "").slice(0, 400),
    state,
    completionSignal: Boolean(parsed.completion),
    completionReason: String(parsed.completion_reason_he ?? ""),
    // Only an ACTIONABLE message can introduce a new trackable matter.
    newMatter: classification === "actionable" && parsed.new_matter === true,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    model,
  };
}

async function appendUpdateToTask(
  taskId: string,
  msg: any,
  analysis: ThreadAnalysis,
  classification: string,
  opts?: { reopen?: boolean },
) {
  const { data: existing } = await supabase
    .from("tasks")
    .select("updates")
    .eq("id", taskId)
    .single();
  const existingUpdates: any[] = Array.isArray(existing?.updates) ? (existing!.updates as any[]) : [];

  // Dedup guard: skip ONLY if we already appended an update for this exact
  // source_message id at this exact received_at. WhatsApp burst rows and Gmail
  // message rows are both immutable per-record now, so the id is already a
  // stable per-message key; the received_at pair is kept as a belt-and-braces
  // guard against the same row being re-processed within a run. (Historically,
  // WhatsApp upserted ONE overwritten row per chat — same id, new received_at —
  // which is why the pair, not the id alone, is the dedup key: T284 and every
  // other multi-burst thread went silent after the first update when dedupping
  // by id alone.)
  //
  // Legacy update entries (created before source_received_at was added
  // to the shape) have id-only and are treated as non-dupes here so we
  // don't get permanently stuck on old rows.
  if (
    msg?.id
    && existingUpdates.some(
      (u) =>
        u?.source_message_id === msg.id
        && typeof u?.source_received_at === "string"
        && u.source_received_at === msg.received_at,
    )
  ) {
    return;
  }

  const updateFields: Record<string, unknown> = {
    last_interaction_at: new Date().toISOString(),
    has_unread_update: true,
    updates: [
      ...existingUpdates,
      {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        type: classification === "actionable" ? "ai_update" : "info_update",
        actor: "system",
        content: analysis.reason || msg.subject || "הודעת המשך בשרשור",
        source_message_id: msg.id,
        source_received_at: msg.received_at,
        source_type: msg.source_type,
        completion_signal: analysis.completionSignal,
      },
    ],
  };

  // Refresh task.description to the analyzer's current-state summary so
  // the user sees "where everything stands" without scrolling the timeline.
  // newSummary is already 400-char-capped and incorporates the latest msg.
  if (analysis.newSummary && analysis.newSummary.trim().length > 0) {
    updateFields.description = analysis.newSummary;
  }

  // reopen wins over a stale completion flag: the thread resumed with a new
  // actionable turn on the SAME matter, so pull the task back to active and
  // clear any prior completion signal so it stops looking "done" in the UI.
  if (opts?.reopen) {
    updateFields.status = "in_progress";
    updateFields.completion_signal_detected = false;
    updateFields.completion_signal_reason = null;
  } else if (analysis.completionSignal) {
    updateFields.status = "pending_completion";
    updateFields.completion_signal_detected = true;
    updateFields.completion_signal_reason = analysis.completionReason;
  }

  await supabase.from("tasks").update(updateFields).eq("id", taskId);
  await supabase.from("task_activities").insert({
    user_id: msg.user_id,
    task_id: taskId,
    activity_type: opts?.reopen ? "reopened" : analysis.completionSignal ? "completion_signal" : "thread_followup",
    note: analysis.reason || msg.subject || `Linked via ${msg.source_type}`,
    actor: "system",
  });
}

// ── WhatsApp per-matter router ────────────────────────────────────────────
// A single WhatsApp chat (one contact) can carry several unrelated open
// matters at once — unlike Gmail, which fractures by threadId. The legacy
// pipeline keyed every WhatsApp message to ONE task per chat (thread_memory
// related_task_id / source_message_id), so distinct matters collapsed into a
// single task. This router restores per-matter granularity: given the open
// tasks already tied to this chat, decide whether the LATEST message belongs
// to one of them or opens a NEW matter. Only invoked when 2+ candidates exist
// (the genuinely ambiguous case); 0/1-candidate cases are resolved cheaply by
// the caller using analysis.newMatter without an extra model call.
interface WhatsAppCandidate { id: string; title_he: string | null; title: string | null; description: string | null; status: string; }

async function routeWhatsAppMatter(
  msg: any,
  candidates: WhatsAppCandidate[],
  sys: SystemParams,
): Promise<{ taskId: string | "NEW"; inputTokens: number; outputTokens: number }> {
  const list = candidates
    .map((c, i) => `${i + 1}. id=${c.id} | ${(c.title_he || c.title || "(ללא כותרת)").slice(0, 80)} — ${(c.description || "").replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n");
  const system = `You route an incoming WhatsApp message to the open matter it continues, or flag it as a NEW distinct matter.
A single contact can have several unrelated open matters at once. Decide which one the LATEST message in the transcript belongs to.
Return ONLY JSON: {"task_id": "<one of the listed ids>"} if it continues that matter, or {"task_id": "NEW"} if it opens a distinct matter (different action/topic) not covered by any listed task.
Judge by the LAST message in the transcript. When genuinely unsure, prefer the most recently relevant existing matter over NEW.`;
  const user = `Open matters for this contact:\n${list}\n\nWhatsApp transcript (latest last):\n${bodyForClassify(msg, sys.body_truncate_classify)}`;
  const result = await callClaude(sys.classification_model, system, user, 60, { component: "ai_process.wa_route", userId: msg.user_id, refId: msg.id });
  let taskId: string | "NEW" = "NEW";
  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      const picked = String(parsed.task_id ?? "").trim();
      if (picked && picked !== "NEW" && candidates.some((c) => c.id === picked)) taskId = picked;
      else if (picked === "NEW") taskId = "NEW";
    }
  } catch { /* default NEW */ }
  return { taskId, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

const WHATSAPP_CLASSIFIER_RULES = `\n\n═══ WhatsApp conversation rule (OVERRIDES the outgoing-mail rule above) ═══\nThe body is a chat transcript with lines like\n  [INCOMING <timestamp>] <text>\n  [OUTGOING <timestamp>] <text>\n[INCOMING] = the other side wrote. [OUTGOING] = the user wrote.\nClassify by the LAST message in the transcript:\n  • Last line is [INCOMING] → ACTIONABLE (the user owes a response)\n  • Last line is [OUTGOING] containing a commitment ("אחזור", "אבדוק", "אשלח",\n    "אעדכן", "תוך X זמן", a specific time/date) → ACTIONABLE\n    (the user owes a follow-through on what they promised)\n  • Last line is [OUTGOING] that asks a question or makes a request and is still\n    awaiting the other side's reply ("?", "אתם פתוחים?", "אפשר?", "מה לגבי",\n    any open ask) → ACTIONABLE (the user is waiting on the other party and\n    needs a tracker so it does not silently expire — the user is NOT the one\n    who owes a reply here)\n  • Last line is [OUTGOING] casual closure ("תודה", "אוקיי", "סבבה", "מעולה") → INFORMATIONAL\n  • Conversation appears closed and resolved → INFORMATIONAL\nThe generic "outgoing → informational" rule does NOT apply to WhatsApp.`;

async function classifyMessage(msg: any, settings: any, sys: SystemParams) {
  const model = sys.classification_model;
  const myEmails: string[] = settings.my_emails ?? [];
  const officeAddresses: string[] = settings.office_addresses ?? [];
  const identityLines: string[] = [];
  if (myEmails.length > 0) identityLines.push(`User's own addresses (outgoing): ${myEmails.join(", ")}`);
  if (officeAddresses.length > 0) identityLines.push(`User's office/customer-facing addresses: ${officeAddresses.join(", ")}. Mail addressed to or from these is business correspondence — classify by content, never spam.`);
  const identityBlock = identityLines.length > 0 ? `\n\n${identityLines.join("\n")}` : "";

  const whatsappBlock = isWhatsApp(msg) ? WHATSAPP_CLASSIFIER_RULES : "";

  const systemPrompt = `You are a message classifier for a personal task management system.${identityBlock}\n\nRules:\n- Outgoing mail (from the user's own addresses) → informational\n- Payment confirmations of completed transactions → informational\n- Mail to/from the user's office addresses → classify by content (NOT spam)${whatsappBlock}\n\nRespond: WORD | reason in Hebrew. WORD must be one of: ACTIONABLE | INFORMATIONAL | SPAM`;

  const userMessage = `From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${bodyForClassify(msg, sys.body_truncate_classify)}`;
  const result = await callClaude(model, systemPrompt, userMessage, 100);
  const text = result.text.trim().toUpperCase();
  let classification = "informational";
  if (text.startsWith("ACTIONABLE")) classification = "actionable";
  else if (text.startsWith("SPAM")) classification = "spam";
  return { classification, reason: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model };
}

async function detectProject(msg: any, sys: SystemParams, userId: string) {
  const { data: projects } = await supabase.from("projects").select("id, name, name_he").eq("user_id", userId).eq("is_active", true);
  if (!projects || projects.length === 0) return null;
  const model = sys.classification_model;
  const projectList = projects.map((p: any) => `${p.id}: ${p.name_he || p.name}`).join("\n");
  const result = await callClaude(model, `Given these projects:\n${projectList}\n\nDoes this message belong to one of them? Respond with ONLY the project ID or 'none'.`, `From: ${msg.sender_email}\nSubject: ${msg.subject}\n${bodyForAI(msg).substring(0, sys.body_truncate_project)}`, 50, { component: "ai_process.project", userId, refId: msg.id });
  const projectId = result.text.trim();
  const matched = projects.find((p: any) => p.id === projectId);
  return matched ? { projectId: matched.id, inputTokens: result.inputTokens, outputTokens: result.outputTokens } : null;
}

async function getProjectBrief(projectId: string): Promise<string> {
  const { data: brief } = await supabase.from("project_briefs").select("purpose, target_audience, current_status, kpis").eq("project_id", projectId).single();
  if (!brief) return "";
  const parts = [];
  if (brief.purpose) parts.push(`Purpose: ${brief.purpose}`);
  if (brief.target_audience) parts.push(`Audience: ${brief.target_audience}`);
  if (brief.current_status) parts.push(`Status: ${brief.current_status}`);
  if (brief.kpis) parts.push(`KPIs: ${brief.kpis}`);
  return parts.join("\n").substring(0, 400);
}

async function loadContactMemory(userId: string, msg: any): Promise<string> {
  // Build a short list of recent open tasks tied to the same contact, so Sonnet
  // doesn't re-invent context the user already saw in past tasks. Cheap (text-only).
  const phone = (msg.metadata?.fromPhone as string | undefined) || null;
  const senderEmail = (msg.sender_email as string | undefined) || null;
  const senderName = (msg.sender as string | undefined) || null;
  const filters: string[] = [];
  if (phone) filters.push(`related_contact_phone.eq.${phone}`);
  if (senderEmail) filters.push(`related_contact_email.eq.${senderEmail}`);
  if (senderName) filters.push(`related_contact.ilike.%${senderName.replace(/[,]/g, " ").trim().split(/\s+/)[0]}%`);
  if (filters.length === 0) return "";

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: tasks } = await supabase
    .from("tasks")
    .select("title_he, title, status, due_date, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .in("status", ["inbox", "in_progress", "completed"])
    .or(filters.join(","))
    .order("created_at", { ascending: false })
    .limit(5);

  if (!tasks || tasks.length === 0) return "";
  const lines = tasks.map((t: any) => {
    const date = (t.created_at || "").slice(0, 10);
    const due = t.due_date ? ` due:${t.due_date}` : "";
    return `• [${t.status} ${date}${due}] ${t.title_he || t.title}`;
  });
  return `\n\nRecent tasks involving this contact (last 30 days):\n${lines.join("\n")}\nIf the current message continues one of these threads, prefer extending it (use the same verb / context).`;
}

const DRIVE_TASK_RULES = `\n\n═══ Drive document handling ═══\nThe body below is the EXTRACTED CONTENT of a document the user keeps in
their Drive folder — a spreadsheet, doc, sheet, presentation, or notes
file. There is no sender, no "reply", no thread. Treat it as a working
document, not a message.

Build the task by READING the content:
  • title_he must name what the document is FOR + the next concrete step
    the user should take with it. Examples:
      - "לעדכן את גיליון Crypto Tracker עם מחיר ETH עדכני"
      - "להמשיך לערוך את 'תקציב מאי' — חסר טור הוצאות"
      - "להכין מצגת על Vivante לפי הנקודות במסמך"
    NEVER use a generic title like "לעיין במסמך X" — that is exactly the
    failure mode this rule exists to prevent.
  • description must reference 1-2 SPECIFIC facts from the content
    (names, amounts, dates, headings, table columns). If you cannot cite
    a specific fact, the content is too thin — return [].
  • If the document is clearly a finished reference (read-only data, a
    completed report, a template, contact list, archived notes) and the
    user has no obvious next step → return [].
  • If the body is empty or unintelligible (audio/image without OCR, PDF
    that didn't extract) → return []. Do NOT invent a "review this"
    task — the file already lives in Drive and the user sees it there.

The TRACKING-TASK / QUOTED-TEXT / ONE-TASK-PER-EMAIL rules above are for
inbound messages and DO NOT apply to Drive documents.`;

const WHATSAPP_TASK_RULES = `\n\n═══ WhatsApp transcript handling ═══\nThe body is a chat with [INCOMING <ts>] / [OUTGOING <ts>] lines.\n[INCOMING] = the OTHER side wrote. [OUTGOING] = the user wrote.\nClassify the task by the LAST line:\n  • Last is [INCOMING] → the user owes a response. Title starts with\n    "לענות ל-<name>" or "לחזור ל-<name>".\n  • Last is [OUTGOING] that asks a question / makes a request / is still\n    awaiting the other side's reply (the user already wrote; the OTHER\n    party now owes the answer) → the user is WAITING ON <name>, not\n    replying to them. Title starts with "לעקוב מול <name>" or\n    "לוודא ש<name> חוזר על <topic>". The description must say the user\n    already sent it and is waiting for the other side's answer.\n  • Last is [OUTGOING] with a commitment BY THE USER (אחזור / אבדוק /\n    אשלח / אעדכן / time pledge) → the user owes a follow-through. Title\n    starts with "לעקוב מול <name>" or "להשלים מול <name> את <topic>".\n  • Last is [OUTGOING] closure / nothing pending → return [].\nDIRECTION GUARD (mandatory): "לענות ל" / "לחזור ל" mean the USER replies,\nso use them ONLY when the LAST line is [INCOMING]. If the last line is\n[OUTGOING] the user has already written — NEVER title the task\n"לענות ל-<name>"/"לחזור ל-<name>"; the other party is the one who owes the\nreply, so the user's next step is to follow up / wait, not to answer.\nNever return a task that simply re-states a past line. The task must name\nthe NEXT step the user has to take.`;

const GMAIL_SENT_TASK_RULES = `\n\n═══ SENT-EMAIL DIRECTION RULE (mandatory) ═══\nThis email was SENT BY THE USER — the From: address is the user's own.\nThe user is the SENDER, not the recipient. NEVER turn the user's own\nrequest into a to-do FOR the user.\n  • If the user ASKED the recipient to do / pay / send / transfer\n    something → the user is now WAITING ON the recipient. The next step\n    is to follow up or confirm the OTHER side acted — NOT to perform the\n    action the user requested from them. Title starts with\n    "לעקוב אחרי <נמען>" or "לוודא ש<נמען> …".\n  • If the user COMMITTED to do something themselves (אשלח / אעביר /\n    אבדוק / a time pledge) → the user owes a follow-through. Title starts\n    with the committed verb / "להשלים מול <נמען> …".\n  • If nothing is pending (closure, thank-you, pure FYI) → return [].\nDIRECTION GUARD (mandatory): money or an action the user REQUESTED from\nthe recipient flows TOWARD the user — never title it as the user\npaying / sending / transferring TO the recipient. owner_contact and any\nnamed party must be the RECIPIENT, never the user themselves.`;

// Incoming mail whose visible To: is NOT one of the user's own addresses —
// the message is addressed to a THIRD PARTY and the user only received a
// copy / BCC / forward. The body's 2nd-person "you/your" refers to that
// third party, not the user. Canonical failure (T475/T436): a Stripe
// dunning notice the org's OWN merchant account sends to a donor whose
// recurring-donation card failed — the builder read "update your billing
// information" as the user's own to-do and inverted payer/payee. The
// recipient address is injected so owner_contact resolves to the real
// counterparty instead of the email's support footer.
const thirdPartyRecipientTaskRules = (recipient: string) => `\n\n═══ THIRD-PARTY RECIPIENT DIRECTION RULE (mandatory) ═══
This email is NOT addressed to the user. The visible To: address
(${recipient || "a third party"}) is NOT one of the user's own addresses —
the user only received a copy / BCC / forward. Every 2nd-person reference
in the body ("you", "your card", "your subscription", "update your billing
information", and the Hebrew equivalents "שלך", "הכרטיס שלך", "המנוי שלך")
refers to that THIRD-PARTY RECIPIENT, NOT to the user. NEVER turn an action
the recipient must take into a to-do for the user.

This is the norm for automated billing/payment services (Stripe, PayPal,
etc.) where the user's OWN organization is the MERCHANT / payee: the From
display name is the user's org and the envelope looks like
"failed-payments+acct_…@stripe.com" / "<brand> via <service>", while the
message tells a CUSTOMER / DONOR that their card failed or a payment is due.
In that case:
  • The failed card / subscription belongs to the RECIPIENT, not the user.
    The user's org is RECEIVING the money — it is the payee, not the payer.
  • The user's action (if any) is to FOLLOW UP WITH the recipient — title
    like "ליצור קשר עם <נמען> — התשלום/התרומה החוזרת ($סכום) נכשל" — NOT to
    update the user's own payment method.
  • owner_contact MUST be the third-party recipient (${recipient || "the To: address"}),
    never the user's own org and never the service's support-footer address.
  • If no follow-up by the user is actually warranted (pure FYI, the service
    retries automatically, the recipient handles it themselves) → return [].
DIRECTION GUARD: do not invert payer/payee. If the user's org is the one
RECEIVING money (merchant / payee), never title the task as the user needing
to pay, update billing, or fix their own card.`;

async function createTasksFromMessage(msg: any, sys: SystemParams, settings: any, userId: string, projectContext?: { projectId: string; brief: string }) {
  const model = sys.summary_model;
  const truncate = sys.body_truncate_task;
  // Static instructions → cached prefix (admin-editable via ai_prompts key
  // "edge_task_builder"). Dynamic context (WhatsApp rules, project brief,
  // contact memory, body) goes in the user message to keep the cache warm.
  const staticPrompt = settings.__prompts?.taskBuilder ?? `You are a task builder for a personal task system.\nExtract concrete actionable tasks from this message.\nReturn ONLY a JSON Array, no markdown, no commentary.\n\n═══ TRACKING-TASK RULE (mandatory, READ FIRST) ═══\nIf the message is a response from a service provider (lawyer, accountant,\ndoctor, vendor, agent, school, government office, contractor) saying:\n  • "we are looking into it"\n  • "we are working on it"\n  • "I'll get back to you"\n  • "we will update you"\n  • "we received your request"\n  • Hebrew: "אנחנו בודקים", "נחזור אליך", "נעדכן"\nthen BUILD ONE tracking task. Do NOT return []. The user asked them to\ndo something, they promised to follow up, and the user needs visibility\non that promise. Task shape:\n  title_he: "לעקוב אחרי <party> על <topic>"\n  priority: medium (low if matter trivial, high if deadline-driven)\n  description: state what the user is waiting for and from whom\n  ai_actions: include "לשלוח תזכורת" / "לחזור עליהם" actions\n\n═══ ONE-TASK-PER-EMAIL RULE (mandatory) ═══\nThe array MUST contain at MOST ONE task per email, even when the email\ndescribes several actions. Collapse multiple actions on the same topic\ninto a single task — list the sub-actions inside the description\n("• בחר כרטיס\\n• ודא חיוב ביולי\\n• אשר ל-X"). Return TWO tasks ONLY\nif:\n  - they involve different recipients, OR\n  - they have distinct deadlines, AND\n  - neither can be done as part of the other.\nWhen in doubt, return ONE task.\n\n═══ QUOTED-TEXT RULE (mandatory) ═══\nThe body may include reply history. IGNORE everything after a line that\nmatches "On <date>, <name> wrote:" or starts with ">". Treat those\nquoted blocks as ALREADY-PROCESSED context — never derive a new task\nfrom a question or commitment that appears only in the quoted history.\nDecide actionability based ONLY on the freshly-written portion of the\nlatest message.\nEXCEPTION: a "MEETING DETAILS" block (see CONTENT-SPECIFIC rule 3) is ALWAYS\nfresh, actionable content — the QUOTED-TEXT rule does NOT apply to it, even\nwhen it appears below quoted history.\n\n═══ EMPTY-ARRAY RULE ═══\nReturn [] (empty array) when the message is purely informational AND the\nTRACKING-TASK RULE above does NOT apply:\n  • Marketing / newsletter / sale / promotion\n  • Bank/payment confirmation of a transaction the user PAID (money going out) — but NOT a benefit / refund / grant / entitlement coming TO the user, which DOES need a task\n  • System receipts already handled by the recipient\n  • Build/CI/server notifications with no human follow-up\n  • The fresh portion of the message only ACKNOWLEDGES a prior\n    commitment ("Sure, thank you", "אוקיי") with nothing pending\nNEVER return [] for a "we are looking into it / will get back to you"\nmessage — see TRACKING-TASK RULE above.\n\n═══ DEEP-LINK PRESERVATION RULE (mandatory, system-wide) ═══\nWhenever the source message contains a SPECIFIC URL (deep link to a\nparticular product page, document, mail thread, listing, dashboard,\ninvoice, ticket, etc.), the description MUST quote that URL VERBATIM —\nincluding query params, fragments, message IDs, doc IDs, anchors.\nNEVER strip a URL down to its bare domain. The whole point of this\nsystem is to save the user clicks: if the original message linked\ndirectly to a specific page, the task description must link to that\nsame page so the user lands where they need to be in one click.\nBAD:   "לבדוק ב-everythingbranded.com"  (bare domain — useless)\nGOOD:  "לבדוק ב-https://everythingbranded.com/products/crayons?ref=foo"\nIf the message contains multiple links to different items, list them\nall in the description. Same rule applies to ai_actions.prompt — keep\nthe exact URL in there too so the action AI has the deep link to act on.\n\n═══ GROUNDING & NATURAL HEBREW (mandatory) ═══\n• Use only names, numbers, and dates that actually appear in the message. Never invent a contact name — if the other party is "שוויגער", do not substitute a different name.\n• Use the user's own verb; never invent an ill-fitting one (e.g. avoid "להערים" for making a call — use "לעשות"/"לקיים שיחת ועידה"). Plain Hebrew only: no calques ("התנאים עומדים") and no internal/PM jargon in user-facing text — a meeting that was in the way is "הפגישה שעיכבה", never "הפגישה בחוסם".\n• description reflects the situation AS OF THE LAST line. If a later line cancels or postpones an event that an earlier time window depended on, that window no longer holds — re-derive from the latest facts (use the current date/time and the [ts] markers); never carry a stale "narrow window" forward.\n\n═══ TASK SHAPE ═══\n{\n  "title_he":     "All-Hebrew (no English characters), starts with action verb. Transliterate foreign names phonetically.",\n  "description":  "Hebrew, 2-3 sentences: WHAT / WHO / WHEN / consequences. PRESERVE any URLs from the source verbatim — never shorten to bare domain.",\n  "priority":     "urgent|high|medium|low",\n  "reason_he":    "Why this task and why this priority — cite ONE concrete fact",\n  "due_date":     "YYYY-MM-DD or null",\n  "ai_actions": [\n    { "label":  "3-7 Hebrew words naming recipient or next step",\n      "prompt": "Full instruction for the AI to run, in English or Hebrew" }\n  ],\n  "owner_contact": "name + phone + email or null"\n}\n\n═══ TITLE RULES (mandatory) ═══\nVerb-first only: לענות / לאשר / להחליט / להעביר / לבדוק / להתקשר /\nלפגוש / לתאם / להזמין / להגיש / להכין / לדחות / לבטל / לחתום / לשלם.\n\nBAD:  "תיאום פגישה"     (noun, not a command)\nBAD:  "מייל מ-X"         (passive)\nGOOD: "לתאם פגישת קליטה עם אמלגמייטד בנק עד 25/5"\nGOOD: "לאשר לדינה את הזמן (שני 09:00 או רביעי 15:00)"\nLANGUAGE: title_he must contain only Hebrew characters. Transliterate: "Google" → "גוגל", "Zoom" → "זום", "Amazon" → "אמזון", "Vercel" → "ורסל".\n\n═══ DATE RULE (mandatory) ═══\nWhen stating WHEN the task/meeting/event is scheduled or due — in BOTH\ntitle_he and description — always write the absolute calendar date\n(e.g. "2 ביוני" or "ב-2/6"). NEVER use relative day-words ("היום",\n"מחר", "אתמול", "today", "tomorrow", "yesterday") to express the task's\ndate. The text is stored persistently; relative words go stale and\nbecome WRONG the next day. EXCEPTION: quoting what a person literally\nsaid ("אמר שיתקשר מחר") is allowed — that reports their words, it is\nNOT the task's scheduled date.\n\n═══ PRIORITY RULES (mandatory) ═══\nurgent : deadline today/tomorrow AND a concrete fact (amount, named\n         person, blocked system).\nhigh   : deadline within 7 days AND impacts people other than the user.\nmedium : deadline within 30 days OR routine follow-up.\nlow    : no clear deadline OR soft/optional action OR upcoming auto-renewal.\n\nNever default to urgent. If you can't cite a concrete urgency fact, drop\nto medium.\n\nAuto-system notifications (Vercel, Railway, GitHub, monitoring services)\n→ max medium, unless production is currently down.\n\n═══ CONTENT-SPECIFIC RULES ═══\n1. Subscription renewal notice ("your X plan renews on Y for $Z"):\n   priority: "low". description MUST list, in this order:\n     • מה מתחדש (service + plan)\n     • כמה ייחויב (amount + currency)\n     • מתי (date)\n     • איך לבטל / לשנות (link or step from the message)\n   ai_actions should include "draft cancel" or "review subscription".\n\n2. Bank / payment confirmation of a transaction the USER paid (money OUT) → return []. BUT a benefit / refund / grant / subsidy / entitlement coming TO the user — especially with an amount to collect or a date to claim/use (food-stamps/EBT, grant, refund, eligibility date) → build ONE task: title "להשתמש ב<benefit>" / "לממש <benefit> עד <date>", describe the amount + date + how to use it.\n\n3. Meeting / video-call invitation (a "MEETING DETAILS" block is present, or\n   the body contains a Teams / Zoom / Google Meet / Webex join link): build\n   ONE task. title_he starts with "להצטרף" / "להשתתף", names the other party,\n   and includes the meeting date/time when present (absolute date per the DATE\n   RULE). The description MUST quote the FULL join URL verbatim, plus Meeting\n   ID and Passcode when present. priority by how soon the meeting is. NEVER\n   shorten or drop the join link.\n\n═══ AI_ACTIONS RULES ═══\n2-3 actions per task. The label is the button text the user sees — it\nMUST name the recipient or the concrete next step, not the generic\naction name. The prompt is what the AI will run on click; include enough\ncontext that the AI doesn't need to re-read this message.`;
  let context = `\n\n${nowContextLine()}`;
  if (isWhatsApp(msg)) context += WHATSAPP_TASK_RULES;
  if (msg.source_type === "google_drive") context += DRIVE_TASK_RULES;
  // Outgoing email (the user is the sender): tell the task builder the
  // direction explicitly, otherwise it reads the user's own request
  // ("Please zelle $250") as a to-do for the user and reverses it (T460).
  // Mirror the gmail_sent / my_emails detection in preClassify (lines 165-166).
  if (!isWhatsApp(msg)) {
    const senderLc = (msg.sender_email || msg.sender || "").toLowerCase();
    const myEmails = (settings.my_emails || []).map((e: string) => String(e).toLowerCase());
    const officeAddresses = (settings.office_addresses || []).map((e: string) => String(e).toLowerCase());
    // The user's address lists in user_settings are often incomplete (they may
    // hold only a personal alias), so fold in the auth-account email too — it's
    // the most reliable "this is me" signal we have at runtime.
    const ownAddresses = [...myEmails, ...officeAddresses, settings.__authEmail || ""]
      .map((e: string) => String(e).toLowerCase()).filter(Boolean);
    const isOutgoingEmail = msg.source_type === "gmail_sent"
      || (msg.source_type === "gmail" && myEmails.some((e: string) => e && senderLc.includes(e)));
    if (isOutgoingEmail) {
      context += GMAIL_SENT_TASK_RULES;
    } else {
      // Incoming mail addressed to someone OTHER than the user, where the
      // sender is an automated payment processor talking to a CUSTOMER/DONOR
      // (dunning, failed-charge, receipt). The body's "you" is that third
      // party, not the user — see thirdPartyRecipientTaskRules.
      //
      // Two guards, BOTH required, keep the blast radius tiny:
      //   1. recipient is known AND matches none of the user's addresses, and
      //   2. the message looks like customer-facing billing.
      // Guard 2 is what keeps genuine user-addressed Stripe mail safe even
      // when the address lists are incomplete: e.g. a "provide business info"
      // verification for the user's OWN merchant account (verifications@ /
      // notifications@stripe.com) does NOT match the dunning pattern, so the
      // rule never fires on it (T356/T366). Mirror preClassify's To fallback.
      const recipientRaw = (msg.recipient || msg.reply_to_context || (msg.metadata as any)?.to || "").toString();
      // Strip a "Name <addr>" wrapper down to the bare address before matching,
      // so the own-address check compares like-for-like (mirrors the To-header
      // parsing in part1-collector).
      const recipientEmail = (recipientRaw.match(/<([^>]+)>/)?.[1] ?? recipientRaw).trim();
      const recipientLc = recipientEmail.toLowerCase();
      const recipientIsThirdParty = recipientLc.length > 0
        && !ownAddresses.some((e) => recipientLc.includes(e));
      const subjectLc = (msg.subject || "").toLowerCase();
      const looksLikeCustomerBilling =
        /(?:failed-payments|invoice|receipts?|billing|dunning|subscription-)[+@]/.test(senderLc)
        || /\bvia (?:stripe|paypal|square|quickbooks|bill\.com|chargebee|recurly|hellosign)\b/i.test(String(msg.sender || ""))
        || /(?:payment|charge|invoice|subscription).*(?:unsuccessful|failed|declined|past[- ]?due|overdue|could ?n.?t)/.test(subjectLc)
        || /update your (?:billing|payment|card)/.test(subjectLc);
      if (recipientIsThirdParty && looksLikeCustomerBilling) {
        context += thirdPartyRecipientTaskRules(recipientEmail);
      }
    }
  }
  if (projectContext?.brief) context += `\n\nProject context (use for better extraction):\n${projectContext.brief}`;
  const contactMemory = await loadContactMemory(userId, msg);
  if (contactMemory) context += contactMemory;
  const taskUserName: string = settings.__userName ?? "";
  if (taskUserName) context += `\n\nUser's first name: ${taskUserName}. Use "${taskUserName}" instead of "המשתמש" in all Hebrew fields (title_he, description, reason_he).`;
  const userMessage = `${context ? context + "\n\n" : ""}From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${bodyForClassify(msg, truncate)}`;
  const result = await callClaude(model, cachedSystem(staticPrompt), userMessage, 2048, { component: "ai_process.task", userId, refId: msg.id });
  let tasks: any[] = [];
  let parsed = true;
  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) tasks = JSON.parse(jsonMatch[0]);
    else parsed = false;
  } catch { parsed = false; }
  if (!parsed) {
    tasks = [{ title_he: msg.subject || "משימה חדשה", description: result.text, priority: "medium", reason_he: "Sonnet output failed to parse — raw text preserved", due_date: null, ai_actions: [], owner_contact: null }];
  }
  return { tasks, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cacheReadTokens: result.cacheReadTokens, cacheWriteTokens: result.cacheWriteTokens, model, projectId: projectContext?.projectId || null };
}

async function checkFollowup(msg: any, sys: SystemParams) {
  const model = sys.classification_model;
  const result = await callClaude(model, `Determine if this outgoing message requires follow-up tracking.\nRespond: FOLLOWUP | reason OR INFO | reason`, `Subject: ${msg.subject || ""}\n\n${bodyForClassify(msg, sys.body_truncate_classify)}`, 100);
  return { isFollowup: result.text.trim().toUpperCase().startsWith("FOLLOWUP"), reason: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

async function checkDailyBudget(userId: string, budgetUsd: number): Promise<boolean> {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const { data } = await supabase.from("log_entries").select("ai_cost_usd").eq("user_id", userId).gte("created_at", todayStart.toISOString()).not("ai_cost_usd", "is", null);
  const totalCost = (data || []).reduce((sum, r) => sum + (Number(r.ai_cost_usd) || 0), 0);
  return totalCost < budgetUsd;
}

function resolveSourceUrl(msg: any): string | null {
  if (msg.source_url) return msg.source_url;
  if ((msg.source_type === "gmail" || msg.source_type === "gmail_sent") && msg.source_id) return `https://mail.google.com/mail/u/0/#all/${msg.source_id}`;
  return null;
}

function msgLogFields(msg: any) {
  return { source_message_id: msg.id, source_type: msg.source_type, source_id: msg.source_id, source_url: resolveSourceUrl(msg), sender: msg.sender, sender_email: msg.sender_email, subject: msg.subject };
}

// ── Gmail review labels ─────────────────────────────────────────────────────
// Tag each scanned Gmail message with its classification outcome as a nested
// "smrtTask/<kind>" label, so the user sees the pipeline's verdict directly in
// Gmail. This mirrors the labels the retired server-side classifier applied;
// the work moved here when collection/classification consolidated onto the
// edge pipeline (see fix(smrttask): single pipeline on edge).
const GMAIL_REVIEW_LABELS = {
  skip:          "smrtTask/דילוג",
  informational: "smrtTask/אינפו",
  actionable:    "smrtTask/הצעה",
  update:        "smrtTask/עדכון",
} as const;

function reviewLabelFor(classification: string): keyof typeof GMAIL_REVIEW_LABELS | null {
  // Normalise to lowercase so legacy uppercase values from the
  // removed server-side Part3 classifier (INFORMATIONAL, ACTIONABLE,
  // UPDATE, …) also map to the right label. The backfill route
  // depends on this — without it, ~50 already-classified messages
  // would skip past tagging silently.
  switch (String(classification).toLowerCase()) {
    case "skip":
    case "skipped":
    case "spam":
      return "skip";
    case "informational":
      return "informational";
    case "actionable":
      return "actionable";
    case "actionable_followup":
    case "informational_followup":
    case "update":
      return "update";
    default:
      return null;
  }
}

// Per-invocation caches (cleared at the top of each request) so we refresh the
// token and list labels at most once per user even when a batch holds many of
// their messages.
const gmailTokenCache = new Map<string, Promise<string>>();
const gmailLabelMapCache = new Map<string, Promise<Map<string, string>>>();

async function refreshGmailToken(userId: string): Promise<string> {
  const { data: cred } = await supabase
    .from("user_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("service", "gmail")
    .single();
  if (!cred) throw new Error("No Gmail credentials found");

  // Still valid (5-min buffer) → reuse.
  if (cred.expires_at && new Date(cred.expires_at) > new Date(Date.now() + 5 * 60 * 1000)) {
    return cred.access_token;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: cred.refresh_token!,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);

  const tokens = await resp.json();
  await supabase
    .from("user_credentials")
    .update({
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    })
    .eq("user_id", userId)
    .eq("service", "gmail");
  return tokens.access_token;
}

async function listGmailLabels(token: string): Promise<Map<string, string>> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`labels.list ${resp.status}`);
  const map = new Map<string, string>();
  for (const l of (await resp.json()).labels ?? []) {
    if (l.name && l.id) map.set(l.name, l.id);
  }
  return map;
}

// Ensure each name exists as a label, creating any that are missing. A
// "Parent/Child" name renders as a nested label in Gmail.
async function getOrCreateGmailLabels(token: string, names: string[]): Promise<Map<string, string>> {
  const map = await listGmailLabels(token);
  for (const name of names) {
    if (map.has(name)) continue;
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    if (resp.ok) {
      const created = await resp.json();
      if (created.id) map.set(name, created.id);
    } else if (resp.status === 409) {
      // Concurrent run created it between our list and create — re-list.
      const refreshed = await listGmailLabels(token);
      const id = refreshed.get(name);
      if (id) map.set(name, id);
    }
  }
  return map;
}

// Best-effort: tag one Gmail message with the label for its final
// classification. Never throws — a labeling failure is logged but must not
// affect message processing.
/**
 * Re-apply Gmail labels to every already-classified Gmail message for a
 * user, WITHOUT re-running the AI classifier. Used after a fix to
 * reviewLabelFor (e.g. when legacy uppercase classifications start
 * mapping to the right kind) so historical messages catch up to the
 * new behaviour without paying for re-classification.
 *
 * Idempotent — Gmail's `addLabelIds` is a set-union, so re-running on
 * already-labelled messages is cheap and safe.
 */
async function relabelGmailForUser(userId: string): Promise<{
  scanned: number;
  tagged: number;
  no_kind: number;
  errors: number;
}> {
  let scanned = 0;
  let tagged = 0;
  let noKind = 0;
  let errors = 0;
  // Page through processed gmail rows. processed_at is the natural cursor;
  // we order ASC so reruns pick up where we left off if the function
  // times out partway.
  const PAGE = 200;
  let cursor: string | null = null;
  while (true) {
    let q = supabase
      .from("source_messages")
      .select("id, user_id, source_type, source_id, ai_classification, processed_at, metadata")
      .eq("user_id", userId)
      .eq("source_type", "gmail")
      .not("ai_classification", "is", null)
      .order("processed_at", { ascending: true, nullsFirst: true })
      .limit(PAGE);
    if (cursor) q = q.gt("processed_at", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`relabel scan: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const msg of data) {
      scanned++;
      const kind = reviewLabelFor(String(msg.ai_classification ?? ""));
      if (!kind) { noKind++; continue; }
      try {
        await tagGmailReview(msg, String(msg.ai_classification));
        tagged++;
      } catch {
        errors++;
      }
    }
    cursor = (data[data.length - 1]?.processed_at as string | null) ?? null;
    if (!cursor) break;
  }
  return { scanned, tagged, no_kind: noKind, errors };
}

async function tagGmailReview(msg: any, classification: string): Promise<void> {
  if (msg.source_type !== "gmail" || !msg.source_id) return;
  const kind = reviewLabelFor(classification);
  if (!kind) return;
  const userId = msg.user_id;
  try {
    if (!gmailTokenCache.has(userId)) gmailTokenCache.set(userId, refreshGmailToken(userId));
    const token = await gmailTokenCache.get(userId)!;

    if (!gmailLabelMapCache.has(userId)) {
      gmailLabelMapCache.set(
        userId,
        getOrCreateGmailLabels(token, ["smrtTask", ...Object.values(GMAIL_REVIEW_LABELS)]),
      );
    }
    const labelMap = await gmailLabelMapCache.get(userId)!;
    const specificId = labelMap.get(GMAIL_REVIEW_LABELS[kind]);
    if (!specificId) return;
    // Always attach BOTH the specific kind (smrtTask/דילוג, smrtTask/הצעה,
    // …) AND the parent "smrtTask" label. Gmail's nested labels are
    // independent — `smrtTask/הצעה` doesn't auto-imply `smrtTask` — so
    // tagging just the kind leaves the parent empty and the user has to
    // expand the tree to see anything we processed.
    // Also drop `UNREAD`: once smrtTask has classified a message it's
    // been "read" by the system, and the boldface in Gmail is noise.
    const parentId = labelMap.get("smrtTask");
    const addLabelIds = parentId ? [specificId, parentId] : [specificId];

    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.source_id}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds: ["UNREAD"] }),
    });
  } catch (e) {
    await supabase.from("log_entries").insert({
      user_id: userId, level: "warning", category: "ai_process_label", status: "failed",
      ...msgLogFields(msg), error_message: `gmail label ${kind}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// Every source_messages.id for a WhatsApp chat. Burst rows are now immutable
// and per-burst (source_id=wa:<chatId>:<wamid>), so a chat's tasks no longer
// share one source_message_id — they fan out across burst rows the same way
// Gmail's fan out across a thread's message rows. We therefore link by the
// chat (metadata.chatId) sibling set, mirroring the Gmail threadId path below.
async function whatsappChatSiblingIds(userId: string, chatId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("source_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("source_type", "whatsapp")
    .filter("metadata->>chatId", "eq", chatId);
  // Don't swallow the error: an empty result here makes the caller spin off a
  // NEW task instead of linking to the chat's open matter, so a transient query
  // failure would silently fragment a thread. Log it; the caller still degrades
  // to [] (self-heals on the next burst).
  if (error) {
    await supabase.from("log_entries").insert({ user_id: userId, level: "warning", category: "ai_process_wa_siblings", status: "failed", error_message: `whatsappChatSiblingIds(${chatId}): ${error.message}` });
    return [];
  }
  return (data ?? []).map((r: any) => r.id as string);
}

async function tryLinkToExistingTask(msg: any, userId: string): Promise<{ id: string; updates: any[] } | null> {
  // Self-chat voice memos (whatsapp_echo): each is an independent new intention
  // (threadKey returns null for them), so we only re-link to a task born from
  // THIS exact row — never to a sibling memo's task.
  if (msg.source_type === "whatsapp_echo") {
    const { data: openTask, error: taskErr } = await supabase.from("tasks").select("id, updates").eq("user_id", userId).in("status", ["inbox", "in_progress"]).eq("source_message_id", msg.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (taskErr || !openTask) return null;
    return { id: openTask.id as string, updates: Array.isArray(openTask.updates) ? openTask.updates : [] };
  }

  // WhatsApp (non self-chat): link by chat sibling set — any open task born from
  // an earlier burst row in the same chat.
  if (msg.source_type === "whatsapp") {
    const chatId = msg.metadata?.chatId as string | undefined;
    if (!chatId) return null;
    const sibIds = await whatsappChatSiblingIds(userId, chatId);
    if (sibIds.length === 0) return null;
    const { data: openTask, error: taskErr } = await supabase.from("tasks").select("id, updates").eq("user_id", userId).in("status", ["inbox", "in_progress"]).in("source_message_id", sibIds).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (taskErr || !openTask) return null;
    return { id: openTask.id as string, updates: Array.isArray(openTask.updates) ? openTask.updates : [] };
  }

  if (msg.source_type !== "gmail") return null;
  const threadId = msg.metadata?.threadId;
  if (!threadId) return null;

  const { data: siblings, error: sibErr } = await supabase.from("source_messages").select("id").eq("user_id", userId).eq("source_type", "gmail").neq("id", msg.id).filter("metadata->>threadId", "eq", threadId);
  if (sibErr || !siblings || siblings.length === 0) return null;
  const siblingIds = siblings.map((r) => r.id);

  const { data: openTask, error: taskErr } = await supabase.from("tasks").select("id, updates").eq("user_id", userId).in("status", ["inbox", "in_progress"]).in("source_message_id", siblingIds).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (taskErr || !openTask) return null;
  const updates = Array.isArray(openTask.updates) ? openTask.updates : [];
  return { id: openTask.id as string, updates };
}

// ── Cross-source link: Drive document ↔ email payment/confirmation ───────────

const COMPLETION_KEYWORDS = [
  "אישור תשלום", "שולם", "קבלה", "חיוב", "ביצוע", "הושלם", "אושר", "אישור",
  "payment confirmed", "payment received", "receipt", "paid", "completed",
  "confirmed", "authorization", "approved", "charge", "transaction",
];

function hasCompletionKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return COMPLETION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

const CROSS_SOURCE_PROMPT = `You are matching two documents to decide if a payment or action confirmation email closes an open task.

MATCH RULE — require at least 2 of the following to match EXACTLY:
• Same monetary amount (exact number, e.g. ₪417.50 — not "a few hundred")
• Same reference / ticket / invoice / case number
• Same organization, authority, or person name as payer/payee

DATE RULE (mandatory):
• Find the EVENT date in the document — the date of the violation / event / service.
  This is NOT the document issuance date; documents are often issued days or weeks after the event.
• Find the payment / confirmation date in the email.
• Payment date MUST be >= event date. A payment that predates the event is impossible → not a match.
• There is no maximum gap — payments can arrive months after the event.

STRICT UNCERTAINTY RULE:
If you cannot confirm 2+ matching specifics, return {"match": false}.
A false positive (linking the wrong documents) is far worse than a missed link.

Return ONLY valid JSON, no markdown:
{"match": true, "matched_id": "<id>", "reason": "<Hebrew: cite the 2+ specific matching details>"}
OR
{"match": false}`;

async function checkCrossSourceLink(
  msg: any,
  userId: string,
  direction: "email_to_open_tasks" | "drive_task_to_past_emails",
  newTaskId: string | null,
  sys: SystemParams,
): Promise<{ taskId: string; sourceMessageId?: string; reason: string } | null> {
  const model = sys.classification_model;
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();

  if (direction === "email_to_open_tasks") {
    const { data: tasks } = await supabase
      .from("tasks")
      .select("id, title_he, title, description")
      .eq("user_id", userId)
      .in("status", ["inbox", "in_progress"])
      .gte("created_at", since90)
      .not("description", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!tasks || tasks.length === 0) return null;

    const taskList = (tasks as any[]).map((t) =>
      `TASK_ID: ${t.id}\nTitle: ${t.title_he || t.title}\nDescription:\n${String(t.description).substring(0, 800)}`,
    ).join("\n\n---\n\n");

    const userMessage = `EMAIL:\nSubject: ${msg.subject || ""}\nBody:\n${bodyForAI(msg).substring(0, 3000)}\n\n═══ OPEN TASKS (last 90 days) ═══\n${taskList}`;

    const result = await callClaude(model, CROSS_SOURCE_PROMPT, userMessage, 300,
      { component: "ai_process.cross_link", userId, refId: msg.id });

    try {
      const m = result.text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      if (parsed.match && parsed.matched_id) {
        return { taskId: String(parsed.matched_id), reason: String(parsed.reason ?? "") };
      }
    } catch { /* ignore */ }
    return null;
  }

  if (direction === "drive_task_to_past_emails") {
    const { data: emails } = await supabase
      .from("source_messages")
      .select("id, subject, body_text, received_at")
      .eq("user_id", userId)
      .in("source_type", ["gmail", "gmail_sent"])
      .eq("ai_classification", "informational")
      .gte("received_at", since90)
      .not("body_text", "is", null)
      .order("received_at", { ascending: false })
      .limit(30);

    if (!emails || emails.length === 0) return null;

    const candidates = (emails as any[]).filter((e) =>
      hasCompletionKeywords(`${e.subject || ""} ${String(e.body_text || "").substring(0, 200)}`),
    );
    if (candidates.length === 0) return null;

    const emailList = candidates.map((e: any) =>
      `EMAIL_ID: ${e.id}\nSubject: ${e.subject || ""}\nDate: ${e.received_at || ""}\nBody:\n${String(e.body_text || "").substring(0, 800)}`,
    ).join("\n\n---\n\n");

    const userMessage = `DRIVE DOCUMENT:\nTitle: ${msg.subject || ""}\nContent:\n${bodyForAI(msg).substring(0, 3000)}\n\n═══ PAST CONFIRMATION EMAILS (last 90 days) ═══\n${emailList}`;

    const result = await callClaude(model, CROSS_SOURCE_PROMPT, userMessage, 300,
      { component: "ai_process.cross_link", userId, refId: msg.id });

    try {
      const m = result.text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      if (parsed.match && parsed.matched_id) {
        return { taskId: newTaskId!, sourceMessageId: String(parsed.matched_id), reason: String(parsed.reason ?? "") };
      }
    } catch { /* ignore */ }
    return null;
  }

  return null;
}

// ── Cross-source duplicate detection ─────────────────────────────────────────
// The thread/sibling linkers above only connect items that share a Gmail
// threadId or a WhatsApp chatId. They cannot connect the SAME real-world event
// arriving from DIFFERENT sources — e.g. a Google Calendar appointment and a
// Gmail reminder for that same appointment (the T241/T455 case). This matcher
// closes that gap: cheap deterministic recall (contact / date overlap) narrows
// the open tasks to a handful of candidates, then a strict AI call decides
// whether it is genuinely the same thing. A false link is worse than a miss,
// so the prompt is conservative and the result is tiered:
//   • high   → auto-link (append as update to the existing task)
//   • medium → suggest to the user (stamp suggested_duplicate_of), no auto-merge

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const PHONE_RE = /\+?\d[\d\-().\s]{6,}\d/g;

interface DupeProbe {
  title: string;
  description: string;
  dueDate: string | null; // YYYY-MM-DD proxy (event date / arrival date)
  emails: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
}

function extractEmails(...vals: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const v of vals) {
    if (!v) continue;
    const m = String(v).match(EMAIL_RE);
    if (m) for (const e of m) out.add(e.toLowerCase());
  }
  return out;
}

function emailDomains(emails: Set<string>): Set<string> {
  const d = new Set<string>();
  for (const e of emails) {
    const i = e.indexOf("@");
    if (i > 0) {
      const dom = e.slice(i + 1);
      // Skip generic/no-reply sender domains that would over-match unrelated
      // automated mail. They carry no "same party" signal.
      if (!/^(gmail|googlemail|outlook|hotmail|yahoo|icloud)\./.test(dom)) d.add(dom);
    }
  }
  return d;
}

// Last 10 digits, so +1-212-908-6671 and (212) 908-6671 compare equal.
function normPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function extractPhones(...vals: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const v of vals) {
    if (!v) continue;
    const m = String(v).match(PHONE_RE);
    if (m) for (const p of m) { const n = normPhone(p); if (n.length >= 9) out.add(n); }
  }
  return out;
}

function extractUrls(text: string): string[] {
  const m = String(text).match(URL_RE);
  return m ? Array.from(new Set(m)) : [];
}

function dayDiff(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a);
  const tb = Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b);
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.abs(ta - tb) / 86_400_000;
}

// Build a probe from the raw inbound message. Contact emails/phones are pulled
// from the sender, the recipients, the AI-supplied owner_contact (when present)
// and the head of the body — calendar events carry the assessor's email only
// in the body, not in any sender field. The due-date proxy is the message's
// received_at (for calendar that IS the event time; for mail it's arrival, and
// the ±-window in the recall filter absorbs the gap).
function buildProbe(msg: any, ownerContact?: string | null): DupeProbe {
  const bodyHead = bodyForAI(msg).slice(0, 1200);
  const emails = extractEmails(msg.sender_email, msg.sender, (msg.metadata as any)?.to, ownerContact, bodyHead);
  const phones = extractPhones((msg.metadata as any)?.fromPhone, ownerContact, bodyHead);
  const dueProxy = msg.received_at ? new Date(msg.received_at).toISOString().slice(0, 10) : null;
  return {
    title: msg.subject || "",
    description: bodyHead,
    dueDate: dueProxy,
    emails,
    domains: emailDomains(emails),
    phones,
  };
}

const DUPE_MATCH_PROMPT = `You decide whether a NEW item refers to the SAME real-world event, appointment, obligation, or thread as one of the user's EXISTING open tasks — even when they arrived from DIFFERENT sources (a calendar event, an email, a WhatsApp chat, a Drive document).

A MATCH means the SAME concrete thing — not merely the same person or the same topic. Require at least 2 of the following to agree:
• Same date — the appointment / deadline / event date is the same (±1 day).
• Same party — the same person or organization (email, phone, email domain, or unmistakably the same named party).
• Same specific subject — the same meeting name, invoice / reference / case number, document, or decision.

confidence:
• "high"   — date AND party match, OR an exact reference/invoice/subject match. Safe to merge automatically.
• "medium" — strong overlap but one pillar is ambiguous (e.g. same person and topic but the date is unclear). Suggest to the user; do NOT auto-merge.

NEVER match on person alone. NEVER match on topic alone. Two DIFFERENT meetings with the same person are NOT a match. A recurring event's separate occurrences are NOT a match unless the date is the same. When unsure, return {"match": false}. A false match is worse than a missed one.

Return ONLY valid JSON, no markdown:
{"match": true, "matched_task_id": "<id from the candidate list>", "confidence": "high", "reason_he": "<Hebrew: name the 2+ matching specifics — date, party, subject>"}
OR
{"match": false}`;

async function findDuplicateOpenTask(
  userId: string,
  probe: DupeProbe,
  sys: SystemParams,
  refId: string,
): Promise<{ taskId: string; serial: string; confidence: "high" | "medium"; reason: string } | null> {
  // No signal to match on → skip entirely (no DB read, no AI call).
  if (probe.emails.size === 0 && probe.phones.size === 0 && !probe.dueDate) return null;

  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const { data: open, error: openErr } = await supabase
    .from("tasks")
    .select("id, serial_display, title_he, title, description, due_date, related_contact, related_contact_email, related_contact_phone")
    .eq("user_id", userId)
    .in("status", ["inbox", "in_progress"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(80);
  if (openErr || !open || open.length === 0) return null;

  // Deterministic recall: keep only tasks that share a contact OR fall within
  // 3 days of the probe date. Contact extraction reads BOTH the structured
  // columns AND the free-text related_contact field, because Sonnet often
  // packs the email/phone into related_contact ("Robin Speary — robin@x.com —
  // (212)…") and leaves related_contact_email null.
  const candidates = (open as any[]).filter((t) => {
    const tEmails = extractEmails(t.related_contact_email, t.related_contact);
    const tPhones = extractPhones(t.related_contact_phone, t.related_contact);
    const tDomains = emailDomains(tEmails);
    const contactHit =
      [...probe.emails].some((e) => tEmails.has(e)) ||
      [...probe.phones].some((p) => tPhones.has(p)) ||
      [...probe.domains].some((d) => tDomains.has(d));
    const dist = dayDiff(probe.dueDate, t.due_date);
    const dateHit = dist !== null && dist <= 3;
    return contactHit || dateHit;
  }).slice(0, 12);

  if (candidates.length === 0) return null;

  const candList = candidates.map((t) =>
    `TASK_ID: ${t.id}\nSerial: ${t.serial_display || "—"}\nTitle: ${t.title_he || t.title}\nDue: ${t.due_date || "—"}\nContact: ${t.related_contact || t.related_contact_email || t.related_contact_phone || "—"}\nDescription: ${String(t.description || "").substring(0, 400)}`,
  ).join("\n\n---\n\n");

  const userMessage = `NEW ITEM (about to become a task):\nTitle: ${probe.title}\nDate: ${probe.dueDate || "—"}\nContact emails: ${[...probe.emails].join(", ") || "—"}\nContact phones: ${[...probe.phones].join(", ") || "—"}\nBody:\n${probe.description.substring(0, 900)}\n\n═══ OPEN TASK CANDIDATES ═══\n${candList}`;

  const result = await callClaude(sys.classification_model, DUPE_MATCH_PROMPT, userMessage, 300,
    { component: "ai_process.dupe_match", userId, refId });

  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (parsed.match && parsed.matched_task_id && (parsed.confidence === "high" || parsed.confidence === "medium")) {
      const hit = candidates.find((c) => c.id === parsed.matched_task_id);
      if (!hit) return null; // guard against a hallucinated id
      return {
        taskId: String(parsed.matched_task_id),
        serial: hit.serial_display || "",
        confidence: parsed.confidence,
        reason: String(parsed.reason_he ?? ""),
      };
    }
  } catch { /* ignore parse errors — treat as no match */ }
  return null;
}

// HIGH-confidence: append the new message to the existing task as an update,
// preserving any deep links from the body verbatim (system-wide rule), and
// enrich the task with details the existing copy was missing (a source link,
// a contact email). Then register thread memory so future messages on the new
// message's own thread attach to the same task automatically.
async function linkAndEnrichDuplicate(
  taskId: string,
  msg: any,
  analysis: ThreadAnalysis,
  reasonHe: string,
) {
  const urls = extractUrls(bodyForAI(msg));
  const linkAnalysis: ThreadAnalysis = {
    ...analysis,
    // Don't clobber the existing task's description with this message's summary;
    // record the cross-source link reason + the verbatim deep link(s) instead.
    newSummary: "",
    completionSignal: false,
    completionReason: "",
    reason: `קישור חוצה-מקורות (${msg.source_type}): ${reasonHe}${urls.length ? `\nקישורים: ${urls.join(" ")}` : ""}`,
  };
  await appendUpdateToTask(taskId, msg, linkAnalysis, "actionable");

  // Backfill fields the existing task lacked.
  const { data: t } = await supabase
    .from("tasks").select("source_link, related_contact_email").eq("id", taskId).maybeSingle();
  const patch: Record<string, unknown> = {};
  if (t && !t.source_link && (msg.source_url || urls[0])) patch.source_link = msg.source_url || urls[0];
  if (t && !t.related_contact_email && msg.sender_email) patch.related_contact_email = msg.sender_email;
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
    if (error) {
      await supabase.from("log_entries").insert({
        user_id: msg.user_id, level: "warning", category: "ai_process_dupe", status: "failed",
        ...msgLogFields(msg), error_message: `enrich update: ${error.message}`,
      });
    }
  }

  // Register thread memory for the NEW message's own thread (Gmail/WhatsApp)
  // so the next reply on it attaches here too. Calendar has no thread key.
  const tk = threadKey(msg);
  if (tk) await upsertThreadMemory(msg.user_id, tk, { related_task_id: taskId, last_message_id: msg.id });
}

// MEDIUM-confidence: the new task was created normally but flagged as a
// possible duplicate. Record an activity so the suggestion is auditable
// alongside the suggested_duplicate_of pointer the UI reads.
async function logDuplicateSuggestion(userId: string, newTaskId: string, suggestedOfTaskId: string) {
  await supabase.from("task_activities").insert({
    user_id: userId,
    task_id: newTaskId,
    activity_type: "duplicate_suggested",
    note: `Possible duplicate of task ${suggestedOfTaskId}`,
    actor: "system",
  });
}

async function processMessage(msg: any, settings: any, sys: SystemParams) {
  const startTime = Date.now();
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheReadTokens = 0, totalCacheWriteTokens = 0, aiModel = "", classification = "", classificationReason = "";
  let linkedTaskId: string | null = null;
  // WhatsApp per-matter routing state (Part A). When routing is active and the
  // router decides the message opens a NEW matter, we must NOT let the legacy
  // single-slot Path 1 / sibling re-linker re-swallow it into an existing task.
  let whatsappWantsNew = false;
  // Medium-confidence cross-source duplicate: stamped onto the task we are
  // about to create (set in Path 2.5, applied in Path 3).
  let dupSuggestionTaskId: string | null = null;

  // User reclassified this message as actionable via the log UI — bypass
  // preClassify skip/defer/informational logic and force actionable after AI.
  const userForceActionable = msg.ai_classification === "user_actionable";

  const preResult = preClassify(msg, settings, sys);

  // ── Early exits that don't need AI ─────────────────────────────────────────
  if (!userForceActionable && preResult.result === "defer") {
    await supabase.from("source_messages").update({ processing_lock_at: null }).eq("id", msg.id);
    return "deferred";
  }

  if (!userForceActionable && preResult.result === "skip") {
    await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "skip", skip_reason: preResult.skipReason, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
    await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "skipped", ...msgLogFields(msg), pre_classification: preResult.result, ai_classification: "skip", classification_reason: preResult.skipReason, processing_duration_ms: Date.now() - startTime });
    await tagGmailReview(msg, "skip");
    return;
  }

  if (!userForceActionable && preResult.result === "informational") {
    await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "informational", skip_reason: preResult.skipReason, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
    await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "ok", ...msgLogFields(msg), pre_classification: preResult.result, ai_classification: "informational", classification_reason: preResult.skipReason, processing_duration_ms: Date.now() - startTime });
    await tagGmailReview(msg, "informational");
    return;
  }

  // ── Outgoing message awaiting a reply → DEFERRED follow-up suggestion ──────
  // The user sent an email / WhatsApp and is waiting on the other side. We do
  // NOT surface a follow-up immediately: a suggestion only appears
  // FOLLOWUP_LEAD_HOURS (48) business hours later, and only if no reply has
  // arrived by then. We model this with a snoozed task — the reminders-check
  // cron wakes it into the inbox at snoozed_until, and suppresses it there if
  // the other party already replied.
  if (!userForceActionable && preResult.result === "check_followup") {
    const fu = await checkFollowup(msg, sys);
    totalInputTokens += fu.inputTokens;
    totalOutputTokens += fu.outputTokens;
    const baseFields = {
      user_id: msg.user_id, category: "ai_process", ...msgLogFields(msg),
      pre_classification: preResult.result, processing_duration_ms: Date.now() - startTime,
    };
    if (!fu.isFollowup) {
      // Outgoing message that closes a loop / needs no chasing → informational.
      await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "informational", processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
      await supabase.from("log_entries").insert({ ...baseFields, status: "ok", ai_classification: "informational", classification_reason: `no follow-up needed: ${fu.reason}` });
      return;
    }

    // Don't double-create if this sent message was processed before.
    const { data: existingFu } = await supabase
      .from("tasks").select("id").eq("source_message_id", msg.id).eq("task_type", "followup").maybeSingle();
    if (!existingFu) {
      const anchor = msg.received_at ? new Date(msg.received_at) : new Date();
      const surfaceAt = addBusinessHours(anchor, FOLLOWUP_LEAD_HOURS);
      const recipient = msg.recipient || msg.reply_to_context || (msg.metadata as any)?.to || "";
      const snippet = (msg.subject || (msg.body_text || "").slice(0, 60) || "הודעה שנשלחה").trim();
      const title = `מעקב: ${snippet}`;
      const sourceUrl = resolveSourceUrl(msg);
      // Preserve the deep link verbatim (system-wide URL rule).
      const description = [
        "שלחת הודעה וממתינה לתגובה. אם לא התקבל מענה — כדאי לעשות מעקב.",
        recipient ? `נשלח אל: ${recipient}` : null,
        sourceUrl ? `קישור להודעה: ${sourceUrl}` : null,
      ].filter(Boolean).join("\n");
      const { data: newTask } = await supabase.from("tasks").insert({
        user_id: msg.user_id, source_message_id: msg.id,
        title, title_he: title, description,
        task_type: "followup", priority: "medium",
        status: "snoozed", snoozed_until: surfaceAt.toISOString(),
        manually_verified: false,
        related_contact_email: recipient || null,
        source_link: sourceUrl,
        ai_actions: [], ai_confidence: 0.7, ai_model_used: sys.classification_model,
        updates: [{ id: crypto.randomUUID(), created_at: new Date().toISOString(), type: "initial", actor: "system", content: description }],
      }).select("id").single();
      if (newTask) {
        await supabase.from("task_activities").insert({
          user_id: msg.user_id, task_id: newTask.id,
          activity_type: "created", new_value: "snoozed",
          note: `Follow-up scheduled for ${surfaceAt.toISOString()} (${FOLLOWUP_LEAD_HOURS} business hours after send)`,
          actor: "system",
        });
      }
    }
    await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "actionable_followup", processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
    await supabase.from("log_entries").insert({ ...baseFields, status: "ok", ai_classification: "actionable_followup", classification_reason: `follow-up deferred ${FOLLOWUP_LEAD_HOURS} business hours: ${fu.reason}` });
    return;
  }

  // ── Load thread memory before AI runs so the prompt has running context ───
  const tkey = threadKey(msg);
  const memory = tkey ? await loadThreadMemory(msg.user_id, tkey) : null;

  // Calendar events inside the meeting lead window (24 business hours before
  // the event) are always actionable — skip Claude classification and go
  // straight to task creation. Claude is still called for the task content.
  const calendarForceActionable = !userForceActionable && preResult.result === "calendar_actionable";
  // Drive documents are never spam — skip Claude classification, but still
  // call createTasksFromMessage so Claude reads the document and builds a task.
  const driveForceActionable = !userForceActionable && preResult.result === "drive_actionable";

  let analysis: ThreadAnalysis;
  if (calendarForceActionable) {
    analysis = {
      classification: "actionable",
      reason: "אירוע יומן מתקרב — משימה נוצרה אוטומטית",
      newSummary: "",
      state: "open",
      completionSignal: false,
      completionReason: "",
      newMatter: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "",
    };
    classification = "actionable";
    classificationReason = "calendar: within meeting lead window (24 business hours)";
  } else if (driveForceActionable) {
    analysis = {
      classification: "actionable",
      reason: "מסמך Drive — הצעה תיבנה מתוכן המסמך",
      newSummary: "",
      state: "open",
      completionSignal: false,
      completionReason: "",
      newMatter: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "",
    };
    classification = "actionable";
    classificationReason = "drive: forced actionable";
  } else {
    // ── Single AI call: classify + update summary + flag completion ───────────
    try {
      analysis = await analyzeWithMemory(msg, memory, settings, sys);
      classification = analysis.classification;
      classificationReason = analysis.reason;
      totalInputTokens += analysis.inputTokens;
      totalOutputTokens += analysis.outputTokens;
      totalCacheReadTokens += analysis.cacheReadTokens;
      totalCacheWriteTokens += analysis.cacheWriteTokens;
      aiModel = analysis.model;
    } catch (e) {
      const retryCount = (msg.retry_count || 0) + 1;
      // After 3 failed AI attempts we give up gracefully — mark the message
      // processed/informational (it won't be re-selected) and log the error.
      // Do NOT set dead_letter: the message is handled, not stuck, and the
      // failure is already recorded in log_entries. (A true dead_letter flag on
      // an otherwise-"processed" row is what made the admin counts misleading.)
      await supabase.from("source_messages").update({ processing_status: retryCount >= 3 ? "processed" : "pending", ai_classification: retryCount >= 3 ? "informational" : "pending", retry_count: retryCount, dead_letter: false, processing_lock_at: null }).eq("id", msg.id);
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "error", category: "ai_process", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message, retry_count: retryCount });
      return;
    }
  }

  // customer_inquiry pre-classification forces actionable regardless of AI
  if (preResult.result === "customer_inquiry") {
    classification = "actionable";
    classificationReason = `${classificationReason} | pre:customer_inquiry`;
    await supabase.from("source_messages").update({ is_customer_inquiry: true }).eq("id", msg.id);
  }

  // User override: user reclassified as actionable via the log UI
  if (userForceActionable) {
    classification = "actionable";
    classificationReason = classificationReason
      ? `${classificationReason} | [user_override]`
      : "user manually reclassified as actionable";
  }

  // Meeting-invite guard: a video-call join link (Teams / Zoom / Meet / Webex)
  // anywhere in the body means there is a meeting to attend — actionable, never
  // read-and-forget. These invites sit past the classifier's truncation window
  // and below the quoted thread, so the model routinely mis-files them as
  // "informational closure". Override here (after the AI verdict, before any
  // task linkage) so the task-builder — which now receives the grafted MEETING
  // block — builds a join task with the link preserved verbatim. SPAM is left
  // alone (a join link in junk is more likely phishing than a real meeting).
  if (classification === "informational" && hasMeetingInvite(bodyForAI(msg))) {
    classification = "actionable";
    classificationReason = classificationReason
      ? `${classificationReason} | pre:meeting_invite`
      : "meeting invite (video-call join link in body) → actionable";
  }

  // ── Path 0 (WhatsApp): per-matter routing ─────────────────────────────────
  // A WhatsApp chat can hold several unrelated open matters. Burst rows are now
  // immutable and per-burst (wa:<chatId>:<wamid>), so a chat's tasks fan out
  // across those rows — we gather every open matter via the chat's sibling set
  // (whatsappChatSiblingIds) and route the new message to the right one, or spin
  // off a new matter even while others stay open. This replaces the legacy
  // single-slot Path 1 for WhatsApp (which collapsed every message onto one
  // task). Falls back to legacy Path 1 when the flag is off.
  const whatsappRoutingActive = sys.whatsapp_matter_routing && isWhatsApp(msg);
  // Route both actionable and informational WhatsApp messages — informational
  // follow-ups (e.g. "תודה, סגרנו") must still land on their matter as an
  // update, exactly as the legacy Path 1 branch (c) did. SPAM is left alone.
  if (whatsappRoutingActive && (classification === "actionable" || classification === "informational")) {
    try {
      // Reopenable + open statuses are candidates; completed/dismissed/archived
      // matters can still be reopened by a same-matter resumption. Burst rows are
      // per-burst now, so gather every task born from ANY burst row in this chat
      // (the sibling set) — not just this row's id, which would miss every prior
      // matter and re-create a duplicate task on each new burst.
      // whatsapp_echo (self-chat memos) are independent intentions, NOT part of
      // a multi-matter chat — each routes only to a task born from its OWN row
      // (preserving the per-memo behavior). Only real two-party `whatsapp` burst
      // rows fan out across the chat's sibling set.
      const chatId = msg.metadata?.chatId as string | undefined;
      const sibIds = msg.source_type === "whatsapp_echo"
        ? [msg.id]
        : (chatId ? await whatsappChatSiblingIds(msg.user_id, chatId) : []);
      let candidates: WhatsAppCandidate[] = [];
      if (sibIds.length > 0) {
        const { data: cands } = await supabase
          .from("tasks")
          .select("id, title_he, title, description, status")
          .eq("user_id", msg.user_id)
          .in("source_message_id", sibIds)
          .in("status", ["inbox", "in_progress", "snoozed", "pending_completion", "completed"])
          .order("created_at", { ascending: false });
        candidates = (cands ?? []) as WhatsAppCandidate[];
      }

      if (candidates.length > 0) {
        let targetId: string | "NEW";
        if (candidates.length === 1) {
          // Single open matter: trust the classifier's new_matter verdict
          // (always false for informational, so those always route to it).
          targetId = analysis.newMatter ? "NEW" : candidates[0].id;
        } else {
          const routed = await routeWhatsAppMatter(msg, candidates, sys);
          totalInputTokens += routed.inputTokens;
          totalOutputTokens += routed.outputTokens;
          targetId = routed.taskId;
        }

        if (targetId === "NEW") {
          if (classification === "actionable") {
            // Spin off a fresh matter even though others are open (user's choice).
            whatsappWantsNew = true;
            classificationReason = `WhatsApp: new matter on existing chat (${candidates.length} open) → new task`;
          }
          // Informational + belongs to no open matter → nothing to track; drop
          // through as plain informational (no task created, none updated).
        } else {
          const target = candidates.find((c) => c.id === targetId)!;
          const closed = ["pending_completion", "completed"].includes(String(target.status));
          if (closed && classification === "actionable") {
            await appendUpdateToTask(targetId, msg, analysis, "actionable", { reopen: true });
            classificationReason = `WhatsApp: reopened matter ${targetId} — thread resumed`;
          } else {
            await appendUpdateToTask(targetId, msg, analysis, classification);
            classificationReason = `WhatsApp: routed ${classification} to matter ${targetId}`;
          }
          linkedTaskId = targetId;
          classification = classification === "actionable" ? "actionable_followup" : "informational_followup";
        }
      }
      // 0 candidates → fall through: actionable creates the first matter;
      // informational has no task and is simply recorded as informational.
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_wa_route", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  // ── Path 1: known existing task in this thread → append / reopen / spin off ─
  // Three outcomes, decided by the message's relationship to the linked task:
  //   (a) NEW distinct matter (analysis.newMatter)        → spin off a fresh
  //       task (fall through to Path 2/3); close the old one first if this
  //       same message also resolved its original question.
  //   (b) actionable resumption of an ALREADY-CLOSED task → reopen + append.
  //   (c) anything else (open task continuing, or an informational follow-up)
  //                                                       → append as before.
  // Before the regression fix, every message hit (c) unconditionally, so new
  // asks (e.g. scheduling a call after the original question was answered) got
  // buried as silent updates inside a task already marked pending_completion.
  // Skipped for WhatsApp when per-matter routing (Path 0) is active — that
  // branch already owns the append/reopen/spin-off decision for WhatsApp.
  if (!whatsappRoutingActive && memory?.related_task_id && classification !== "spam") {
    try {
      const { data: linkedTask } = await supabase
        .from("tasks").select("id, status")
        .eq("id", memory.related_task_id).eq("user_id", msg.user_id).maybeSingle();

      if (!linkedTask) {
        // The task was deleted/merged away — the thread_memory link is stale.
        // Don't append into a ghost; let the create/link paths below handle
        // this message from scratch (and re-point thread_memory if a task is made).
      } else {
        // Only the natural "done" states reopen on a resumed actionable turn.
        // dismissed/archived were deliberately killed (don't auto-resurrect);
        // snoozed is a user-intended hide — both keep their prior append
        // behavior via branch (c) below.
        const REOPENABLE_STATUSES = ["pending_completion", "completed"];
        const taskClosed = REOPENABLE_STATUSES.includes(String(linkedTask.status));

        if (classification === "actionable" && analysis.newMatter && (analysis.completionSignal || taskClosed)) {
          // (a) New, distinct matter AND the old task is closing or already
          // closed → spin off a fresh task. If this same message resolved the
          // old task's original question, record that closure (which moves it
          // to pending_completion). Then leave linkedTaskId unset so Path 2/3
          // creates a new task and thread_memory re-points to it.
          // Why gate on closed: Path 2's sibling linker re-attaches by
          // source_message_id (one row per WhatsApp chat), and the dup linker
          // by contact — both only match inbox/in_progress. Once the old task
          // is closed, neither can re-swallow the new matter. If the old task
          // is still OPEN and unresolved, a new matter can't get its own task
          // cleanly (it would relink), so we fall through to (c) and append —
          // same as before, no regression.
          if (analysis.completionSignal && !taskClosed) {
            await appendUpdateToTask(memory.related_task_id, msg, analysis, "informational");
          }
        } else if (taskClosed && classification === "actionable") {
          // (b) Same-topic resumption of an already-closed task → reopen it
          // rather than burying new actionable content as a silent update.
          await appendUpdateToTask(memory.related_task_id, msg, analysis, "actionable", { reopen: true });
          linkedTaskId = memory.related_task_id;
          classification = "actionable_followup";
          classificationReason = `reopened task ${memory.related_task_id} via ${msg.source_type} — thread resumed`;
        } else {
          // (c) Open task continuing, or an informational follow-up → append.
          await appendUpdateToTask(memory.related_task_id, msg, analysis, classification);
          linkedTaskId = memory.related_task_id;
          classification = classification === "actionable" ? "actionable_followup" : "informational_followup";
          classificationReason = `linked to task ${memory.related_task_id} via ${msg.source_type}${analysis.completionSignal ? " — completion signal" : ""}`;
        }
      }
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_link", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  // ── Path 2: actionable + no linked task yet → maybe link via siblings, else create ──
  // The sibling re-linker re-attaches WhatsApp messages by source_message_id
  // (one row per chat), which would re-swallow a deliberate new matter back
  // into an existing task. Skip it when Path 0 already routed this WhatsApp
  // message to a NEW matter.
  if (!linkedTaskId && classification === "actionable" && !whatsappWantsNew) {
    try {
      const sibling = await tryLinkToExistingTask(msg, msg.user_id);
      if (sibling) {
        await appendUpdateToTask(sibling.id, msg, analysis, "actionable");
        linkedTaskId = sibling.id;
        classification = "actionable_followup";
        classificationReason = `linked to task ${sibling.id} via ${msg.source_type} (sibling-fallback)`;
      }
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_link", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  // ── Idempotency guard: one source_message → its task(s) created exactly once ─
  // A source_message row is immutable (one row per calendar event / email /
  // WhatsApp burst), but it can be RE-SELECTED for processing — calendar events
  // in particular are re-upserted to `pending` on every calendar sync until the
  // event passes, so the same row reaches this point repeatedly. Without a guard
  // each reprocess re-runs Path 2.5/3 and spawns a fresh duplicate. (Real case:
  // one "תרומה של רסקין" calendar event produced T244 and T329 — identical tasks
  // four days apart.) The cross-source duplicate detector below is the wrong tool
  // for this: it's a fuzzy, AI-based CONTENT match, and calendar rows carry an
  // empty body and no contact, so it cannot reliably recognise the same event —
  // whereas a reprocess of the SAME row is exactly identifiable by
  // source_message_id. Catch it deterministically here, before the paid dup call.
  if (!linkedTaskId && classification === "actionable") {
    const { data: existingForMsg, error: existErr } = await supabase
      .from("tasks").select("id").eq("source_message_id", msg.id).limit(1).maybeSingle();
    if (existErr) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_tasks", status: "failed", ...msgLogFields(msg), error_message: `dup-guard select: ${existErr.message}` });
    } else if (existingForMsg) {
      // Already turned into a task on a prior pass — link to it and skip
      // re-creation. classification flips so this counts as a follow-up touch,
      // not a fresh actionable, and the source_message is still marked processed.
      linkedTaskId = existingForMsg.id as string;
      classification = "actionable_followup";
      classificationReason = `source_message already produced task ${existingForMsg.id} — skipped duplicate creation on reprocess`;
    }
  }

  // ── Path 2.5: cross-source duplicate detection ────────────────────────────
  // The sibling linker above only connects same-thread items. This catches the
  // SAME real-world event arriving from a DIFFERENT source (e.g. a Gmail
  // reminder for an appointment already tracked from a Calendar event).
  //   high   → link to the existing task now (skip creating a duplicate)
  //   medium → create normally, but flag the suspected duplicate for the user
  // Skipped when Path 0 deliberately routed this WhatsApp message to a NEW
  // matter — honor that decision instead of re-collapsing onto a sibling.
  if (!linkedTaskId && classification === "actionable" && !whatsappWantsNew) {
    try {
      const dup = await findDuplicateOpenTask(msg.user_id, buildProbe(msg), sys, msg.id);
      if (dup && dup.confidence === "high") {
        await linkAndEnrichDuplicate(dup.taskId, msg, analysis, dup.reason);
        linkedTaskId = dup.taskId;
        classification = "actionable_followup";
        classificationReason = `cross-source duplicate of ${dup.serial || dup.taskId} (high) — ${dup.reason}`;
      } else if (dup && dup.confidence === "medium") {
        dupSuggestionTaskId = dup.taskId;
        classificationReason = `possible duplicate of ${dup.serial || dup.taskId} (medium) — ${dup.reason}`;
      }
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_dupe", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  if (!linkedTaskId && classification === "actionable") {
    try {
      // Calendar events: build the task directly from the event's own data.
      // Calling Claude here would generate "לתאם" (to schedule) tasks even
      // though the appointment already exists in the calendar.
      if (calendarForceActionable) {
        const eventDate = new Date(msg.received_at);
        const dueDateStr = eventDate.toISOString().split("T")[0];
        const eventTitle = msg.subject || "ארוע ביומן";
        // Use raw ISO date — toLocaleString with IANA timezones is unreliable in Deno V8.
        const description = `ארוע ביומן: ${eventTitle}`;
        // Fire the prominent "happening soon" reminder one hour before the
        // meeting starts. The banner keys off reminder_at (a precise instant,
        // tz-rendered on the client), so we don't need a tz-correct due_time.
        const reminderAt = new Date(eventDate.getTime() - 60 * 60 * 1000);
        const { data: newTask } = await supabase.from("tasks").insert({
          user_id: msg.user_id, source_message_id: msg.id,
          title: eventTitle, title_he: eventTitle,
          description, task_type: "meeting", priority: "medium",
          status: "inbox", manually_verified: false,
          due_date: dueDateStr,
          reminder_at: reminderAt.toISOString(),
          ai_actions: [], ai_confidence: 1.0, ai_model_used: "calendar",
          suggested_duplicate_of: dupSuggestionTaskId,
          updates: [{ id: crypto.randomUUID(), created_at: new Date().toISOString(), type: "initial", actor: "system", content: description }],
        }).select("id").single();
        if (newTask) {
          linkedTaskId = newTask.id as string;
          classificationReason = dupSuggestionTaskId ? classificationReason : "calendar event → direct task (no AI)";
          await supabase.from("task_activities").insert({
            user_id: msg.user_id, task_id: newTask.id,
            activity_type: "created", new_value: "inbox",
            note: `Created from google_calendar: ${eventTitle}`,
            actor: "system",
          });
          if (dupSuggestionTaskId) await logDuplicateSuggestion(msg.user_id, newTask.id as string, dupSuggestionTaskId);
        }
      } else {
        let projectContext: { projectId: string; brief: string } | undefined;
        const projectMatch = await detectProject(msg, sys, msg.user_id);
        if (projectMatch) {
          totalInputTokens += projectMatch.inputTokens;
          totalOutputTokens += projectMatch.outputTokens;
          const brief = await getProjectBrief(projectMatch.projectId);
          if (brief) projectContext = { projectId: projectMatch.projectId, brief };
        }

        const taskResult = await createTasksFromMessage(msg, sys, settings, msg.user_id, projectContext);
        totalInputTokens += taskResult.inputTokens;
        totalOutputTokens += taskResult.outputTokens;
        totalCacheReadTokens += taskResult.cacheReadTokens;
        totalCacheWriteTokens += taskResult.cacheWriteTokens;

        if (taskResult.tasks.length === 0) {
          // No fallback for Drive: if Sonnet, given the document content,
          // can't articulate a concrete next step, a generic "review this
          // document" task is just noise — the file already lives in Drive
          // and the user can open it from there. Downgrade to informational
          // exactly like every other source.
          classification = "informational";
          classificationReason = driveForceActionable
            ? "drive: Sonnet returned no actionable task — no fallback noise"
            : "Sonnet returned no actionable tasks.";
          aiModel = taskResult.model;
        } else {
          const firstReason = taskResult.tasks.find((t: any) => t.reason_he)?.reason_he;
          if (firstReason) classificationReason = firstReason;
          aiModel = taskResult.model;
          // An email carrying a video-call join link is a meeting to attend.
          // Tag it so it gets the meeting indicator (the 24h lead-window gate
          // only applies to calendar events, which carry a reliable start time).
          const taskType = hasMeetingInvite(bodyForAI(msg)) ? "meeting" : "action";
          let firstTaskId: string | null = null;
          const createdTaskIds: string[] = [];
          for (const task of taskResult.tasks) {
            const { data: newTask } = await supabase.from("tasks").insert({
              user_id: msg.user_id, source_message_id: msg.id,
              title: task.title_he || msg.subject || "New task", title_he: task.title_he,
              description: task.description, task_type: taskType, priority: task.priority || "medium",
              status: "inbox", manually_verified: false,
              due_date: task.due_date,
              project_id: taskResult.projectId,
              ai_actions: task.ai_actions || [], related_contact: task.owner_contact,
              related_contact_email: msg.sender_email, ai_confidence: 0.8, ai_model_used: taskResult.model,
              // Stamp the medium-confidence dup suggestion onto the first task only.
              suggested_duplicate_of: firstTaskId ? null : dupSuggestionTaskId,
              updates: [{ id: crypto.randomUUID(), created_at: new Date().toISOString(), type: "initial", actor: "system", content: task.description }],
            }).select("id").single();
            if (newTask) {
              const isFirst = !firstTaskId;
              if (isFirst) firstTaskId = newTask.id as string;
              createdTaskIds.push(newTask.id as string);
              await supabase.from("task_activities").insert({ user_id: msg.user_id, task_id: newTask.id, activity_type: "created", new_value: "inbox", note: `Created from ${msg.source_type}: ${msg.subject || "(no subject)"}`, actor: "system" });
              if (isFirst && dupSuggestionTaskId) await logDuplicateSuggestion(msg.user_id, newTask.id as string, dupSuggestionTaskId);
            }
          }
          if (firstTaskId) linkedTaskId = firstTaskId;

          // Part B: a NEW WhatsApp matter whose LAST message is the user's own
          // outgoing one becomes a DEFERRED follow-up, mirroring the email
          // check_followup path: don't nag now, snooze FOLLOWUP_LEAD_HOURS (48
          // business hours) and let reminders-check surface it only if no reply
          // arrives. The deferral is driven by the REAL message direction
          // (metadata.lastDirection, stamped by the webhook from
          // whatsapp_messages.direction) — not by the classifier's GUESSED
          // thread state, which was unstable and re-derived on every reprocess.
          // Last message incoming → the user owes the reply → stays in the inbox.
          const lastDirectionOutgoing = (msg.metadata?.lastDirection as string | undefined) === "outgoing";
          if (whatsappRoutingActive && lastDirectionOutgoing && createdTaskIds.length > 0) {
            const anchor = msg.received_at ? new Date(msg.received_at) : new Date();
            const surfaceAt = addBusinessHours(anchor, FOLLOWUP_LEAD_HOURS).toISOString();
            // Destructure { error }: an RLS denial / FK error here would otherwise
            // leave the task stuck inbox→snoozed with no trail and no log.
            const { error: snoozeErr } = await supabase.from("tasks")
              .update({ task_type: "followup", status: "snoozed", snoozed_until: surfaceAt })
              .in("id", createdTaskIds);
            if (snoozeErr) {
              await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_wa_followup", status: "failed", ...msgLogFields(msg), error_message: `defer snooze failed: ${snoozeErr.message}` });
            } else {
              for (const tid of createdTaskIds) {
                const { error: actErr } = await supabase.from("task_activities").insert({
                  user_id: msg.user_id, task_id: tid,
                  activity_type: "snoozed", new_value: "snoozed",
                  note: `Follow-up scheduled for ${surfaceAt} (${FOLLOWUP_LEAD_HOURS} business hours — awaiting WhatsApp reply)`,
                  actor: "system",
                });
                if (actErr) await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_wa_followup", status: "failed", ...msgLogFields(msg), error_message: `defer activity insert failed: ${actErr.message}` });
              }
              classificationReason = `${classificationReason} | WhatsApp follow-up deferred ${FOLLOWUP_LEAD_HOURS}h (last message outgoing)`;
            }
          }
          if (!projectContext) await supabase.from("source_messages").update({ needs_project_check: true }).eq("id", msg.id);
        }
      }
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "error", category: "ai_process_tasks", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  // ── Path 4: informational Gmail with completion signals →
  //    check cross-source whether it closes an open task (Drive or any source) ─
  if (
    !linkedTaskId &&
    classification === "informational" &&
    (msg.source_type === "gmail" || msg.source_type === "gmail_sent") &&
    hasCompletionKeywords(`${msg.subject || ""} ${bodyForAI(msg).substring(0, 400)}`)
  ) {
    try {
      const link = await checkCrossSourceLink(msg, msg.user_id, "email_to_open_tasks", null, sys);
      if (link) {
        const { data: targetTask } = await supabase
          .from("tasks").select("id").eq("id", link.taskId).eq("user_id", msg.user_id).maybeSingle();
        if (targetTask) {
          const completionAnalysis: ThreadAnalysis = {
            ...analysis,
            completionSignal: true,
            completionReason: link.reason,
            reason: link.reason,
          };
          await appendUpdateToTask(link.taskId, msg, completionAnalysis, "informational");
          linkedTaskId = link.taskId;
          classification = "informational_followup";
          classificationReason = `cross-source: closes task ${link.taskId} — ${link.reason}`;
          totalInputTokens += 0; // Haiku call tracked inside callClaude via ai_usage
        }
      }
    } catch (e) {
      await supabase.from("log_entries").insert({
        user_id: msg.user_id, level: "warning", category: "ai_process_cross_link",
        status: "failed", ...msgLogFields(msg), error_message: (e as Error).message,
      }).catch(() => {});
    }
  }

  // ── Path 5: new Drive task → check if a past email already confirms it ────
  if (driveForceActionable && linkedTaskId) {
    try {
      const link = await checkCrossSourceLink(msg, msg.user_id, "drive_task_to_past_emails", linkedTaskId, sys);
      if (link?.sourceMessageId) {
        const { data: emailMsg } = await supabase
          .from("source_messages").select("*")
          .eq("id", link.sourceMessageId).eq("user_id", msg.user_id).maybeSingle();
        if (emailMsg) {
          const completionAnalysis: ThreadAnalysis = {
            classification: "informational",
            reason: link.reason,
            newSummary: "",
            state: "open",
            completionSignal: true,
            completionReason: link.reason,
            newMatter: false,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "",
          };
          await appendUpdateToTask(linkedTaskId, emailMsg, completionAnalysis, "informational");
        }
      }
    } catch (e) {
      await supabase.from("log_entries").insert({
        user_id: msg.user_id, level: "warning", category: "ai_process_cross_link",
        status: "failed", ...msgLogFields(msg), error_message: (e as Error).message,
      }).catch(() => {});
    }
  }

  // ── Persist thread memory ─────────────────────────────────────────────────
  if (tkey) {
    try {
      await upsertThreadMemory(msg.user_id, tkey, {
        summary: analysis.newSummary || memory?.summary || "",
        state: analysis.state,
        related_task_id: linkedTaskId ?? memory?.related_task_id ?? null,
        last_message_id: msg.id,
      });
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_memory", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: classification, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
  await tagGmailReview(msg, classification);
  const costType = modelTypeFromName(aiModel);
  await supabase.from("log_entries").insert({
    user_id: msg.user_id,
    category: "ai_process",
    status: "ok",
    ...msgLogFields(msg),
    pre_classification: preResult.result,
    ai_classification: classification,
    classification_reason: classificationReason,
    task_id: linkedTaskId,
    ai_model_used: aiModel,
    ai_input_tokens: totalInputTokens,
    ai_output_tokens: totalOutputTokens,
    ai_cost_usd: estimateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, costType),
    processing_duration_ms: Date.now() - startTime,
  });
}

function estimateCost(input: number, output: number, cacheRead: number, cacheWrite: number, type: string): number {
  const rate = type === "haiku" ? { in: 0.80, out: 4 } : type === "opus" ? { in: 15, out: 75 } : { in: 3, out: 15 };
  // cache read ≈ 0.1× input rate; cache write (5-min TTL) ≈ 1.25× input rate.
  return (input * rate.in + output * rate.out + cacheRead * rate.in * 0.1 + cacheWrite * rate.in * 1.25) / 1_000_000;
}

function modelTypeFromName(model: string): "haiku" | "sonnet" | "opus" {
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus"))  return "opus";
  return "sonnet";
}

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (authHeader !== cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
      const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
      if (!user) return new Response("Unauthorized", { status: 401 });
    }

    // One-off backfill mode: re-apply Gmail labels to already-classified
    // messages WITHOUT re-running classification. Triggered by
    //   POST .../ai-process?action=relabel_gmail&user_id=<uuid>
    // and admin-bounded by the cron secret (same gate the scheduler uses).
    // Without this, retroactively fixing reviewLabelFor (which used to
    // ignore legacy uppercase classifications) would never touch the
    // messages that were processed before the fix.
    const reqUrl = new URL(req.url);
    if (reqUrl.searchParams.get("action") === "relabel_gmail") {
      if (authHeader !== cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
        return new Response("Forbidden — admin only", { status: 403 });
      }
      const targetUserId = reqUrl.searchParams.get("user_id");
      if (!targetUserId) return new Response("user_id required", { status: 400 });
      gmailTokenCache.clear();
      gmailLabelMapCache.clear();
      const result = await relabelGmailForUser(targetUserId);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }

    const sys = await loadSystemParams();

    // Fresh per request — never reuse a token/label map across warm invocations.
    gmailTokenCache.clear();
    gmailLabelMapCache.clear();

    await supabase.from("source_messages").update({ processing_lock_at: null }).lt("processing_lock_at", new Date(Date.now() - sys.processing_lock_minutes * 60_000).toISOString()).not("processing_lock_at", "is", null);

    const { data: pendingUsers } = await supabase.from("source_messages").select("user_id").eq("processing_status", "pending").is("processing_lock_at", null).or("dead_letter.eq.false,dead_letter.is.null").or(BODY_TEXT_FILTER).limit(100);
    const uniqueUserIds = [...new Set((pendingUsers || []).map((r) => r.user_id))];
    let totalProcessed = 0;
    let totalDeferred = 0;

    for (const userId of uniqueUserIds) {
      const [settingsRes, categoryRulesRes, skipRulesRes, promptsRes, userAuthRes] = await Promise.all([
        supabase.from("user_settings").select("*").eq("user_id", userId).single(),
        supabase.from("rules_memory").select("trigger, is_active").eq("user_id", userId).ilike("trigger", "category=%"),
        supabase.from("rules_memory").select("trigger").eq("user_id", userId).eq("is_active", true).or("trigger.ilike.to=%,trigger.ilike.from=%"),
        supabase.from("ai_prompts").select("prompt_key, content").eq("user_id", userId).eq("is_active", true).in("prompt_key", ["edge_classifier", "edge_task_builder"]),
        supabase.auth.admin.getUserById(userId),
      ]);
      const settings = settingsRes.data;
      if (!settings) continue;
      settings.__category_filter = buildCategoryFilter(categoryRulesRes.data ?? []);
      // Build to=/from= skip sets from rules_memory (the UI stores them here,
      // not in user_settings.skip_recipients/skip_senders).
      const toSkip = new Set<string>();
      const fromSkip = new Set<string>();
      for (const r of (skipRulesRes.data ?? [])) {
        const m = String(r.trigger).match(/^(to|from)=(.+)$/i);
        if (!m) continue;
        if (m[1].toLowerCase() === "to") toSkip.add(m[2].toLowerCase());
        else fromSkip.add(m[2].toLowerCase());
      }
      settings.__toSkip = toSkip;
      settings.__fromSkip = fromSkip;
      // Admin-editable prompt overrides (fallback to the inline defaults). Loaded
      // once per user per run so the cached system prefix stays stable.
      const promptMap = new Map((promptsRes.data ?? []).map((p: any) => [p.prompt_key, p.content as string]));
      settings.__prompts = {
        classifier: promptMap.get("edge_classifier") || undefined,
        taskBuilder: promptMap.get("edge_task_builder") || undefined,
      };
      const rawFullName = ((userAuthRes.data?.user?.user_metadata?.full_name as string | undefined) || "").trim();
      settings.__userName = rawFullName.split(/\s+/)[0] || "";
      // Auth-account email — the most reliable "this is the user" address at
      // runtime. Folded into the own-address set in createTasksFromMessage so
      // the third-party-recipient direction rule doesn't misfire on mail
      // genuinely addressed to the user when user_settings.my_emails is sparse.
      settings.__authEmail = ((userAuthRes.data?.user?.email as string | undefined) || "").toLowerCase();

      const withinBudget = await checkDailyBudget(userId, settings.daily_ai_budget_usd || 10.0);
      if (!withinBudget) continue;

      // WhatsApp debounce: a `whatsapp` burst row is only eligible once its chat
      // has been quiet for whatsapp_debounce_seconds. The webhook stamps the burst
      // row's received_at = latest message time and supersedes any earlier pending
      // burst row in the chat, so while messages keep arriving the surviving row's
      // received_at stays recent and it is held back here until the chat settles —
      // coalescing rapid follow-ups into ONE classification pass. Self-chat
      // `whatsapp_echo` memos are deliberate one-offs and are NOT debounced.
      const whatsappReadyBefore = new Date(Date.now() - sys.whatsapp_debounce_seconds * 1000).toISOString();
      let allMessages: any[] = [];
      for (const st of SOURCE_PRIORITY) {
        if (allMessages.length >= sys.batch_size) break;
        const remaining = sys.batch_size - allMessages.length;
        let q = supabase.from("source_messages").select("*").eq("user_id", userId).eq("processing_status", "pending").eq("source_type", st).is("processing_lock_at", null).or("dead_letter.eq.false,dead_letter.is.null").or(BODY_TEXT_FILTER);
        if (st === "whatsapp") q = q.lte("received_at", whatsappReadyBefore);
        const { data: msgs } = await q.order("received_at", { ascending: true }).limit(remaining);
        if (msgs && msgs.length > 0) allMessages = allMessages.concat(msgs);
      }

      for (const msg of allMessages) {
        const { data: claimed } = await supabase.from("source_messages").update({ processing_lock_at: new Date().toISOString() }).eq("id", msg.id).eq("processing_status", "pending").is("processing_lock_at", null).select("id").single();
        if (!claimed) continue;
        try {
          const result = await processMessage(msg, settings, sys);
          if (result === "deferred") totalDeferred++; else totalProcessed++;
        } catch (e) {
          await supabase.from("source_messages").update({ processing_lock_at: null, retry_count: (msg.retry_count || 0) + 1 }).eq("id", msg.id);
          await supabase.from("log_entries").insert({ user_id: userId, level: "error", category: "ai_process", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
        }
      }
    }
    return new Response(JSON.stringify({ processed: totalProcessed, deferred: totalDeferred, batchSize: sys.batch_size }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
