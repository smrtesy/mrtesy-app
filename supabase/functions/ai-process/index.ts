import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function preClassify(msg: any, settings: any, sys: SystemParams): { result: string; skipReason?: string } {
  const sender = (msg.sender_email || msg.sender || "").toLowerCase();
  // source_messages has no dedicated recipient column — Part1 stores the TO
  // address in reply_to_context and metadata.to. Fall back through all three.
  const recipient = (msg.recipient || msg.reply_to_context || (msg.metadata as any)?.to || "").toLowerCase();
  const sourceType = msg.source_type || "";
  const myEmails = (settings.my_emails || []).map((e: string) => e.toLowerCase());
  const officeAddresses = (settings.office_addresses || []).map((e: string) => e.toLowerCase());
  const skipSenders = (settings.skip_senders || []).map((e: string) => e.toLowerCase());
  const skipRecipients = (settings.skip_recipients || []).map((e: string) => e.toLowerCase());
  const toSkip: Set<string> = settings.__toSkip instanceof Set ? settings.__toSkip : new Set();
  const fromSkip: Set<string> = settings.__fromSkip instanceof Set ? settings.__fromSkip : new Set();
  const gmailLabels: string[] = Array.isArray(msg.metadata?.labels) ? msg.metadata.labels : [];
  const categoryFilter: Set<string> = settings.__category_filter instanceof Set ? settings.__category_filter : new Set();

  // rules_memory to=/from= skip rules (UI-configured)
  for (const addr of toSkip) {
    if (recipient.includes(addr)) return { result: "skip", skipReason: `to_rule: ${addr}` };
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
    const pastCutoff   = new Date(now.getTime() - sys.calendar_past_days   * 86_400_000);
    const futureCutoff = new Date(now.getTime() + sys.calendar_future_days * 86_400_000);
    if (eventDate < pastCutoff) return { result: "skip", skipReason: "past_calendar_event" };
    if (eventDate > futureCutoff) return { result: "defer", skipReason: "future_calendar_event" };
  }

  if (sourceType === "whatsapp_echo") return { result: "check_followup" };
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
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
  "completion_reason_he": "if completion=true, brief Hebrew explanation; else empty string"
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

- INFORMATIONAL = read-and-forget. No tracking needed. The user did not
  initiate anything that requires a return response. Examples:
    • Marketing / newsletter / sale / promotion
    • Build, CI, server, monitoring notification ("deploy succeeded")
    • Social-network ping
    • Payment CONFIRMATION of an already-completed transaction the user initiated
      and considers closed
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

IGNORE quoted text (after "On … wrote:" or starting with "> ") — that history is
already captured in new_summary's prior version. Base decisions on the FRESHLY
written portion of the message only.

If the user's own address is the sender:
- Their own commitment ("אחזור", "אבדוק") → ACTIONABLE (they owe follow-through), state=pending_user_action
- Just acknowledging closure → INFORMATIONAL

═══ WORKED EXAMPLE ═══
Input: "Please be advised that we are currently looking into the
collection action against your son. I will let you know as soon as we
have an update." — from a law firm.
Correct output: ACTIONABLE, state=pending_other_party. reason_he should
reference HARDEST RULE: "תגובה לפניית המשתמש, עורכי הדין הבטיחו לחזור — נדרש מעקב".
INCORRECT output: INFORMATIONAL. The HARDEST RULE applies here.`;

  // Per-message context goes in the user message (NOT the cached system prefix).
  const contextBlock = `${identityBlock}${memoryBlock}${whatsappNote}`;
  const userMessage = `${contextBlock ? contextBlock + "\n\n" : ""}From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\nNEW MESSAGE BODY:\n${bodyForAI(msg).substring(0, sys.body_truncate_classify)}`;

  const result = await callClaude(model, cachedSystem(staticPrompt), userMessage, 800, { component: "ai_process.classify", userId: msg.user_id, refId: msg.id });
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
) {
  const { data: existing } = await supabase
    .from("tasks")
    .select("updates")
    .eq("id", taskId)
    .single();
  const existingUpdates: any[] = Array.isArray(existing?.updates) ? (existing!.updates as any[]) : [];

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
        source_type: msg.source_type,
        completion_signal: analysis.completionSignal,
      },
    ],
  };

  if (analysis.completionSignal) {
    updateFields.status = "pending_completion";
    updateFields.completion_signal_detected = true;
    updateFields.completion_signal_reason = analysis.completionReason;
  }

  await supabase.from("tasks").update(updateFields).eq("id", taskId);
  await supabase.from("task_activities").insert({
    user_id: msg.user_id,
    task_id: taskId,
    activity_type: analysis.completionSignal ? "completion_signal" : "thread_followup",
    note: analysis.reason || msg.subject || `Linked via ${msg.source_type}`,
    actor: "system",
  });
}

const WHATSAPP_CLASSIFIER_RULES = `\n\n═══ WhatsApp conversation rule (OVERRIDES the outgoing-mail rule above) ═══\nThe body is a chat transcript with lines like\n  [INCOMING <timestamp>] <text>\n  [OUTGOING <timestamp>] <text>\n[INCOMING] = the other side wrote. [OUTGOING] = the user wrote.\nClassify by the LAST message in the transcript:\n  • Last line is [INCOMING] → ACTIONABLE (the user owes a response)\n  • Last line is [OUTGOING] containing a commitment ("אחזור", "אבדוק", "אשלח",\n    "אעדכן", "תוך X זמן", a specific time/date) → ACTIONABLE\n    (the user owes a follow-through on what they promised)\n  • Last line is [OUTGOING] casual closure ("תודה", "אוקיי", "סבבה", "מעולה") → INFORMATIONAL\n  • Conversation appears closed and resolved → INFORMATIONAL\nThe generic "outgoing → informational" rule does NOT apply to WhatsApp.`;

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

  const userMessage = `From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${bodyForAI(msg).substring(0, sys.body_truncate_classify)}`;
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

const WHATSAPP_TASK_RULES = `\n\n═══ WhatsApp transcript handling ═══\nThe body is a chat with [INCOMING <ts>] / [OUTGOING <ts>] lines.\nClassify the task by the LAST line:\n  • Last is [INCOMING] → the user owes a response. Title starts with\n    "לענות ל-<name>" or "לחזור ל-<name>".\n  • Last is [OUTGOING] with a commitment (אחזור / אבדוק / אשלח / אעדכן\n    / time pledge) → the user owes a follow-through. Title starts with\n    "לעקוב מול <name>" or "להשלים מול <name> את <topic>".\n  • Last is [OUTGOING] closure / nothing pending → return [].\nNever return a task that simply re-states a past line. The task must name\nthe NEXT step the user has to take.`;

async function createTasksFromMessage(msg: any, sys: SystemParams, settings: any, userId: string, projectContext?: { projectId: string; brief: string }) {
  const model = sys.summary_model;
  const truncate = sys.body_truncate_task;
  // Static instructions → cached prefix (admin-editable via ai_prompts key
  // "edge_task_builder"). Dynamic context (WhatsApp rules, project brief,
  // contact memory, body) goes in the user message to keep the cache warm.
  const staticPrompt = settings.__prompts?.taskBuilder ?? `You are a task builder for a personal task system.\nExtract concrete actionable tasks from this message.\nReturn ONLY a JSON Array, no markdown, no commentary.\n\n═══ TRACKING-TASK RULE (mandatory, READ FIRST) ═══\nIf the message is a response from a service provider (lawyer, accountant,\ndoctor, vendor, agent, school, government office, contractor) saying:\n  • "we are looking into it"\n  • "we are working on it"\n  • "I'll get back to you"\n  • "we will update you"\n  • "we received your request"\n  • Hebrew: "אנחנו בודקים", "נחזור אליך", "נעדכן"\nthen BUILD ONE tracking task. Do NOT return []. The user asked them to\ndo something, they promised to follow up, and the user needs visibility\non that promise. Task shape:\n  title_he: "לעקוב אחרי <party> על <topic>"\n  priority: medium (low if matter trivial, high if deadline-driven)\n  description: state what the user is waiting for and from whom\n  ai_actions: include "לשלוח תזכורת" / "לחזור עליהם" actions\n\n═══ ONE-TASK-PER-EMAIL RULE (mandatory) ═══\nThe array MUST contain at MOST ONE task per email, even when the email\ndescribes several actions. Collapse multiple actions on the same topic\ninto a single task — list the sub-actions inside the description\n("• בחר כרטיס\\n• ודא חיוב ביולי\\n• אשר ל-X"). Return TWO tasks ONLY\nif:\n  - they involve different recipients, OR\n  - they have distinct deadlines, AND\n  - neither can be done as part of the other.\nWhen in doubt, return ONE task.\n\n═══ QUOTED-TEXT RULE (mandatory) ═══\nThe body may include reply history. IGNORE everything after a line that\nmatches "On <date>, <name> wrote:" or starts with ">". Treat those\nquoted blocks as ALREADY-PROCESSED context — never derive a new task\nfrom a question or commitment that appears only in the quoted history.\nDecide actionability based ONLY on the freshly-written portion of the\nlatest message.\n\n═══ EMPTY-ARRAY RULE ═══\nReturn [] (empty array) when the message is purely informational AND the\nTRACKING-TASK RULE above does NOT apply:\n  • Marketing / newsletter / sale / promotion\n  • Bank/payment confirmation of an already-completed transaction\n  • System receipts already handled by the recipient\n  • Build/CI/server notifications with no human follow-up\n  • The fresh portion of the message only ACKNOWLEDGES a prior\n    commitment ("Sure, thank you", "אוקיי") with nothing pending\nNEVER return [] for a "we are looking into it / will get back to you"\nmessage — see TRACKING-TASK RULE above.\n\n═══ TASK SHAPE ═══\n{\n  "title_he":     "All-Hebrew (no English characters), starts with action verb. Transliterate foreign names phonetically.",\n  "description":  "Hebrew, 2-3 sentences: WHAT / WHO / WHEN / consequences",\n  "priority":     "urgent|high|medium|low",\n  "reason_he":    "Why this task and why this priority — cite ONE concrete fact",\n  "due_date":     "YYYY-MM-DD or null",\n  "ai_actions": [\n    { "label":  "3-7 Hebrew words naming recipient or next step",\n      "prompt": "Full instruction for the AI to run, in English or Hebrew" }\n  ],\n  "owner_contact": "name + phone + email or null"\n}\n\n═══ TITLE RULES (mandatory) ═══\nVerb-first only: לענות / לאשר / להחליט / להעביר / לבדוק / להתקשר /\nלפגוש / לתאם / להזמין / להגיש / להכין / לדחות / לבטל / לחתום / לשלם.\n\nBAD:  "תיאום פגישה"     (noun, not a command)\nBAD:  "מייל מ-X"         (passive)\nGOOD: "לתאם פגישת קליטה עם אמלגמייטד בנק עד 25/5"\nGOOD: "לאשר לדינה את הזמן (שני 09:00 או רביעי 15:00)"\nLANGUAGE: title_he must contain only Hebrew characters. Transliterate: "Google" → "גוגל", "Zoom" → "זום", "Amazon" → "אמזון", "Vercel" → "ורסל".\n\n═══ PRIORITY RULES (mandatory) ═══\nurgent : deadline today/tomorrow AND a concrete fact (amount, named\n         person, blocked system).\nhigh   : deadline within 7 days AND impacts people other than the user.\nmedium : deadline within 30 days OR routine follow-up.\nlow    : no clear deadline OR soft/optional action OR upcoming auto-renewal.\n\nNever default to urgent. If you can't cite a concrete urgency fact, drop\nto medium.\n\nAuto-system notifications (Vercel, Railway, GitHub, monitoring services)\n→ max medium, unless production is currently down.\n\n═══ CONTENT-SPECIFIC RULES ═══\n1. Subscription renewal notice ("your X plan renews on Y for $Z"):\n   priority: "low". description MUST list, in this order:\n     • מה מתחדש (service + plan)\n     • כמה ייחויב (amount + currency)\n     • מתי (date)\n     • איך לבטל / לשנות (link or step from the message)\n   ai_actions should include "draft cancel" or "review subscription".\n\n2. Bank / payment confirmation of a completed transaction → return [].\n\n═══ AI_ACTIONS RULES ═══\n2-3 actions per task. The label is the button text the user sees — it\nMUST name the recipient or the concrete next step, not the generic\naction name. The prompt is what the AI will run on click; include enough\ncontext that the AI doesn't need to re-read this message.`;
  let context = "";
  if (isWhatsApp(msg)) context += WHATSAPP_TASK_RULES;
  if (projectContext?.brief) context += `\n\nProject context (use for better extraction):\n${projectContext.brief}`;
  const contactMemory = await loadContactMemory(userId, msg);
  if (contactMemory) context += contactMemory;
  const taskUserName: string = settings.__userName ?? "";
  if (taskUserName) context += `\n\nUser's first name: ${taskUserName}. Use "${taskUserName}" instead of "המשתמש" in all Hebrew fields (title_he, description, reason_he).`;
  const userMessage = `${context ? context + "\n\n" : ""}From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${bodyForAI(msg).substring(0, truncate)}`;
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
  const result = await callClaude(model, `Determine if this outgoing message requires follow-up tracking.\nRespond: FOLLOWUP | reason OR INFO | reason`, `Subject: ${msg.subject || ""}\n\n${bodyForAI(msg).substring(0, sys.body_truncate_classify)}`, 100);
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
  switch (classification) {
    case "skip":
    case "spam":
      return "skip";
    case "informational":
      return "informational";
    case "actionable":
      return "actionable";
    case "actionable_followup":
    case "informational_followup":
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
    const labelId = (await gmailLabelMapCache.get(userId)!).get(GMAIL_REVIEW_LABELS[kind]);
    if (!labelId) return;

    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.source_id}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: [labelId] }),
    });
  } catch (e) {
    await supabase.from("log_entries").insert({
      user_id: userId, level: "warning", category: "ai_process_label", status: "failed",
      ...msgLogFields(msg), error_message: `gmail label ${kind}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function tryLinkToExistingTask(msg: any, userId: string): Promise<{ id: string; updates: any[] } | null> {
  // WhatsApp: same source_message_id (one row per chat) → existing task
  if (msg.source_type === "whatsapp" || msg.source_type === "whatsapp_echo") {
    const { data: openTask, error: taskErr } = await supabase.from("tasks").select("id, updates").eq("user_id", userId).in("status", ["inbox", "in_progress"]).eq("source_message_id", msg.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
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

async function processMessage(msg: any, settings: any, sys: SystemParams) {
  const startTime = Date.now();
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheReadTokens = 0, totalCacheWriteTokens = 0, aiModel = "", classification = "", classificationReason = "";
  let linkedTaskId: string | null = null;

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

  // ── Load thread memory before AI runs so the prompt has running context ───
  const tkey = threadKey(msg);
  const memory = tkey ? await loadThreadMemory(msg.user_id, tkey) : null;

  // ── Single AI call: classify + update summary + flag completion ───────────
  let analysis: ThreadAnalysis;
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

  // ── Path 1: known existing task in this thread → always append ────────────
  // Catches BOTH actionable_followup (the user owes more action) and
  // informational_followup (payment confirmation, "thanks", etc.).
  if (memory?.related_task_id && classification !== "spam") {
    try {
      await appendUpdateToTask(memory.related_task_id, msg, analysis, classification);
      linkedTaskId = memory.related_task_id;
      classification = classification === "actionable" ? "actionable_followup" : "informational_followup";
      classificationReason = `linked to task ${memory.related_task_id} via ${msg.source_type}${analysis.completionSignal ? " — completion signal" : ""}`;
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "warning", category: "ai_process_link", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  // ── Path 2: actionable + no linked task yet → maybe link via siblings, else create ──
  if (!linkedTaskId && classification === "actionable") {
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

  if (!linkedTaskId && classification === "actionable") {
    try {
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
        classification = "informational";
        classificationReason = "Sonnet returned no actionable tasks.";
        aiModel = taskResult.model;
      } else {
        const firstReason = taskResult.tasks.find((t: any) => t.reason_he)?.reason_he;
        if (firstReason) classificationReason = firstReason;
        aiModel = taskResult.model;
        let firstTaskId: string | null = null;
        for (const task of taskResult.tasks) {
          const { data: newTask } = await supabase.from("tasks").insert({
            user_id: msg.user_id, source_message_id: msg.id,
            title: task.title_he || msg.subject || "New task", title_he: task.title_he,
            description: task.description, task_type: "action", priority: task.priority || "medium",
            status: "inbox", manually_verified: false,
            due_date: task.due_date,
            project_id: taskResult.projectId,
            ai_actions: task.ai_actions || [], related_contact: task.owner_contact,
            related_contact_email: msg.sender_email, ai_confidence: 0.8, ai_model_used: taskResult.model,
            updates: [{ id: crypto.randomUUID(), created_at: new Date().toISOString(), type: "initial", actor: "system", content: task.description }],
          }).select("id").single();
          if (newTask) {
            if (!firstTaskId) firstTaskId = newTask.id as string;
            await supabase.from("task_activities").insert({ user_id: msg.user_id, task_id: newTask.id, activity_type: "created", new_value: "inbox", note: `Created from ${msg.source_type}: ${msg.subject || "(no subject)"}`, actor: "system" });
          }
        }
        if (firstTaskId) linkedTaskId = firstTaskId;
        if (!projectContext) await supabase.from("source_messages").update({ needs_project_check: true }).eq("id", msg.id);
      }
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "error", category: "ai_process_tasks", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
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

      const withinBudget = await checkDailyBudget(userId, settings.daily_ai_budget_usd || 10.0);
      if (!withinBudget) continue;

      let allMessages: any[] = [];
      for (const st of SOURCE_PRIORITY) {
        if (allMessages.length >= sys.batch_size) break;
        const remaining = sys.batch_size - allMessages.length;
        const { data: msgs } = await supabase.from("source_messages").select("*").eq("user_id", userId).eq("processing_status", "pending").eq("source_type", st).is("processing_lock_at", null).or("dead_letter.eq.false,dead_letter.is.null").or(BODY_TEXT_FILTER).order("received_at", { ascending: true }).limit(remaining);
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
