import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// System-wide knobs sourced from smrttask_system_params (single row, id='smrttask').
// Loaded once at the start of each cron tick and passed through the call stack.
// Defaults below are last-resort fallbacks for the brief window between migration
// rollout and the seed row landing — in steady state the row always exists.
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
  const { data, error } = await supabase
    .from("smrttask_system_params")
    .select("*")
    .eq("id", "smrttask")
    .maybeSingle();
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

// Priority order: whatsapp/calendar/drive first, then gmail with body
const SOURCE_PRIORITY = ["whatsapp", "whatsapp_echo", "google_calendar", "google_drive", "gmail", "gmail_sent"];

const BODY_TEXT_FILTER = "body_text.not.is.null,source_type.eq.whatsapp,source_type.eq.whatsapp_echo,source_type.eq.google_calendar,source_type.eq.google_drive";

// Default: filter promotions, social, forums. Updates ARE actionable by
// default (per user spec). When the user has rows in rules_memory with
// trigger='category=<key>', those override these defaults.
const DEFAULT_FILTERED_CATEGORY_KEYS = new Set(["promotions", "social", "forums"]);
const CATEGORY_KEY_TO_GMAIL_LABEL: Record<string, string> = {
  promotions: "CATEGORY_PROMOTIONS",
  social:     "CATEGORY_SOCIAL",
  updates:    "CATEGORY_UPDATES",
  forums:     "CATEGORY_FORUMS",
};
const ALL_CATEGORY_KEYS = Object.keys(CATEGORY_KEY_TO_GMAIL_LABEL);

interface CategoryRuleRow { trigger: string; is_active: boolean }

/**
 * Build the per-user "treat as informational" Gmail label set. For each of
 * the four categories: if rules_memory has a row, respect is_active. If no
 * row, apply the default (promotions/social/forums = filter; updates = not).
 * The user toggles these from /settings/smrttask/rules.
 */
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

/**
 * For WhatsApp source_messages the conversation history (last 20 messages)
 * is stored in raw_content, while body_text holds only the last single
 * message. Classification needs the conversation context, otherwise it
 * builds tasks blind. For Gmail/Drive/Calendar the body_text IS the full
 * content.
 */
function bodyForAI(msg: any): string {
  if (msg.source_type === "whatsapp" || msg.source_type === "whatsapp_echo") {
    return String(msg.raw_content ?? msg.body_text ?? "");
  }
  return String(msg.body_text ?? "");
}

function preClassify(msg: any, settings: any, sys: SystemParams): { result: string; skipReason?: string } {
  const sender = (msg.sender_email || msg.sender || "").toLowerCase();
  const recipient = (msg.recipient || "").toLowerCase();
  const sourceType = msg.source_type || "";
  const myEmails = (settings.my_emails || []).map((e: string) => e.toLowerCase());
  const officeAddresses = (settings.office_addresses || []).map((e: string) => e.toLowerCase());
  const skipSenders = (settings.skip_senders || []).map((e: string) => e.toLowerCase());
  const skipRecipients = (settings.skip_recipients || []).map((e: string) => e.toLowerCase());
  const gmailLabels: string[] = Array.isArray(msg.metadata?.labels) ? msg.metadata.labels : [];

  // Gmail category filter — built once per cron tick per user (see Deno.serve
  // below) and attached to settings as a Set. It already reflects rules_memory
  // category= rules + smart defaults.
  const categoryFilter: Set<string> =
    settings.__category_filter instanceof Set ? settings.__category_filter : new Set();

  for (const sr of skipRecipients) {
    if (recipient.includes(sr)) return { result: "skip", skipReason: `recipient: ${sr}` };
  }

  // Calendar events: only process if within the system-configured window.
  if (sourceType === "google_calendar" && msg.received_at) {
    const eventDate = new Date(msg.received_at);
    const now = new Date();
    const pastCutoff   = new Date(now.getTime() - sys.calendar_past_days   * 86_400_000);
    const futureCutoff = new Date(now.getTime() + sys.calendar_future_days * 86_400_000);
    if (eventDate < pastCutoff) {
      return { result: "skip", skipReason: "past_calendar_event" };
    }
    if (eventDate > futureCutoff) {
      return { result: "defer", skipReason: "future_calendar_event" };
    }
  }

  if (sourceType === "whatsapp_echo") return { result: "check_followup" };
  if (sourceType === "gmail_sent") return { result: "check_followup" };
  if (myEmails.some((e: string) => sender.includes(e))) return { result: "check_followup" };
  if (officeAddresses.some((e: string) => sender.includes(e))) return { result: "customer_inquiry" };
  if (skipSenders.some((e: string) => sender.includes(e))) return { result: "informational", skipReason: `skip_sender: ${sender}` };

  // Gmail category check — controlled per-user via gmail_skip_categories.
  // Only applies to messages that gmail-sync tagged with labelIds in metadata.
  // WhatsApp / Drive / Calendar source_messages have no labels and skip this branch.
  // If the user's category filter is empty, this becomes a no-op.
  if (categoryFilter.size > 0) {
    const informationalLabel = gmailLabels.find((l) => categoryFilter.has(l));
    if (informationalLabel) {
      return { result: "informational", skipReason: `gmail_category:${informationalLabel}` };
    }
  }

  return { result: "needs_claude" };
}

async function callClaude(model: string, systemPrompt: string, userMessage: string, maxTokens: number = 1024) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }),
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error(`Claude API ${resp.status}: ${err}`); }
  const data = await resp.json();
  return { text: data.content?.[0]?.text || "", inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 };
}

async function classifyMessage(msg: any, settings: any, sys: SystemParams) {
  const model = sys.classification_model;

  // Per-user identity context. my_emails are the addresses the user sends
  // FROM (treat as outgoing/personal); office_addresses are the user's
  // customer-facing addresses (treat their content as inbound business,
  // never spam). Replaces a hardcoded reference to a specific tenant.
  const myEmails: string[] = settings.my_emails ?? [];
  const officeAddresses: string[] = settings.office_addresses ?? [];
  const identityLines: string[] = [];
  if (myEmails.length > 0) {
    identityLines.push(`User's own addresses (outgoing): ${myEmails.join(", ")}`);
  }
  if (officeAddresses.length > 0) {
    identityLines.push(`User's office/customer-facing addresses: ${officeAddresses.join(", ")}. Mail addressed to or from these is business correspondence — classify by content, never spam.`);
  }
  const identityBlock = identityLines.length > 0 ? `\n\n${identityLines.join("\n")}` : "";

  const systemPrompt = `You are a message classifier for a personal task management system.${identityBlock}

Rules:
- Outgoing mail (from the user's own addresses) → informational
- Payment confirmations of completed transactions → informational
- Mail to/from the user's office addresses → classify by content (NOT spam)

Respond: WORD | reason in Hebrew. WORD must be one of: ACTIONABLE | INFORMATIONAL | SPAM`;

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
  const result = await callClaude(model, `Given these projects:\n${projectList}\n\nDoes this message belong to one of them? Respond with ONLY the project ID or 'none'.`, `From: ${msg.sender_email}\nSubject: ${msg.subject}\n${bodyForAI(msg).substring(0, sys.body_truncate_project)}`, 50);
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

async function createTasksFromMessage(msg: any, sys: SystemParams, projectContext?: { projectId: string; brief: string }) {
  const model = sys.summary_model;
  const truncate = sys.body_truncate_task;
  let systemPrompt = `You are a task builder for a personal task system.
Extract concrete actionable tasks from this message.
Return ONLY a JSON Array, no markdown, no commentary.

═══ EMPTY-ARRAY RULE ═══
Return [] (empty array) when the message is purely informational:
  • Marketing / newsletter / sale / promotion
  • Bank/payment confirmation of an already-completed transaction
  • System receipts already handled by the recipient
  • Status updates that need no human action
The caller will record an empty result as informational.

═══ TASK SHAPE ═══
{
  "title_he":     "Hebrew, starts with action verb",
  "description":  "Hebrew, 2-3 sentences: WHAT / WHO / WHEN / consequences",
  "priority":     "urgent|high|medium|low",
  "reason_he":    "Why this task and why this priority — cite ONE concrete fact",
  "due_date":     "YYYY-MM-DD or null",
  "ai_actions": [
    { "label":  "3-7 Hebrew words naming recipient or next step",
      "prompt": "Full instruction for the AI to run, in English or Hebrew" }
  ],
  "owner_contact": "name + phone + email or null"
}

═══ TITLE RULES (mandatory) ═══
Verb-first only: לענות / לאשר / להחליט / להעביר / לבדוק / להתקשר /
לפגוש / לתאם / להזמין / להגיש / להכין / לדחות / לבטל / לחתום / לשלם.

BAD:  "תיאום פגישה"     (noun, not a command)
BAD:  "מייל מ-X"         (passive)
GOOD: "לתאם פגישת קליטה עם Amalgamated Bank עד 25/5"
GOOD: "לאשר לדינה את הזמן (שני 09:00 או רביעי 15:00)"

═══ PRIORITY RULES (mandatory) ═══
urgent : deadline today/tomorrow AND a concrete fact (amount, named
         person, blocked system).
high   : deadline within 7 days AND impacts people other than the user.
medium : deadline within 30 days OR routine follow-up.
low    : no clear deadline OR soft/optional action OR upcoming auto-renewal.

Never default to urgent. If you can't cite a concrete urgency fact, drop
to medium.

Auto-system notifications (Vercel, Railway, GitHub, monitoring services)
→ max medium, unless production is currently down.

═══ CONTENT-SPECIFIC RULES ═══
1. Subscription renewal notice ("your X plan renews on Y for $Z"):
   priority: "low". description MUST list, in this order:
     • מה מתחדש (service + plan)
     • כמה ייחויב (amount + currency)
     • מתי (date)
     • איך לבטל / לשנות (link or step from the message)
   ai_actions should include "draft cancel" or "review subscription".

2. Bank / payment confirmation of a completed transaction → return [].

═══ AI_ACTIONS RULES ═══
2-3 actions per task. The label is the button text the user sees — it
MUST name the recipient or the concrete next step, not the generic
action name. The prompt is what the AI will run on click; include enough
context that the AI doesn't need to re-read this message.`;
  if (projectContext?.brief) {
    systemPrompt += `\n\nProject context (use for better extraction):\n${projectContext.brief}`;
  }
  const userMessage = `From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${bodyForAI(msg).substring(0, truncate)}`;
  const result = await callClaude(model, systemPrompt, userMessage, 2048);
  let tasks: any[] = [];
  let parsed = true;
  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) tasks = JSON.parse(jsonMatch[0]);
    else parsed = false;
  } catch { parsed = false; }
  if (!parsed) {
    // Parse failure — preserve the raw text as the description so the user can
    // still see what the AI tried to say. Priority is medium; the prompt rules
    // forbid defaulting to urgent.
    tasks = [{ title_he: msg.subject || "משימה חדשה", description: result.text, priority: "medium", reason_he: "Sonnet output failed to parse — raw text preserved", due_date: null, ai_actions: [], owner_contact: null }];
  }
  return { tasks, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model, projectId: projectContext?.projectId || null };
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
  if ((msg.source_type === "gmail" || msg.source_type === "gmail_sent") && msg.source_id) {
    return `https://mail.google.com/mail/u/0/#all/${msg.source_id}`;
  }
  return null;
}

function msgLogFields(msg: any) {
  return {
    source_message_id: msg.id,
    source_type: msg.source_type,
    source_id: msg.source_id,
    source_url: resolveSourceUrl(msg),
    sender: msg.sender,
    sender_email: msg.sender_email,
    subject: msg.subject,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up linking via Gmail threadId
//
// Before producing a NEW task for an incoming Gmail message, see whether the
// same Gmail conversation already has an open task. If yes, append an update
// to that task and skip task-creation (saves the Sonnet call + avoids the
// duplicate). Returns null when there's no linkable task — caller proceeds
// with the existing flow.
//
// Gated to source_type === "gmail" because:
//   • threadId only exists for Gmail
//   • gmail_sent goes through the outgoing follow-up path before this point
//   • whatsapp/drive/calendar use their own source_id semantics
// ─────────────────────────────────────────────────────────────────────────────
async function tryLinkToExistingTask(
  msg: any,
  userId: string,
): Promise<{ id: string; updates: any[] } | null> {
  // ── WhatsApp path ─────────────────────────────────────────────────────
  // The WhatsApp webhook (Vercel route at src/app/api/webhooks/whatsapp)
  // upserts ONE source_message per chat and resets processing_status to
  // 'pending' on every incoming message. Without this dedup, ai-process
  // would create a fresh task for every chat reply.
  // Match on the same source_message_id and append to the existing task.
  if (msg.source_type === "whatsapp" || msg.source_type === "whatsapp_echo") {
    const { data: openTask, error: taskErr } = await supabase
      .from("tasks")
      .select("id, updates")
      .eq("user_id", userId)
      .in("status", ["inbox", "in_progress"])
      .eq("source_message_id", msg.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (taskErr || !openTask) return null;
    return {
      id: openTask.id as string,
      updates: Array.isArray(openTask.updates) ? openTask.updates : [],
    };
  }

  // ── Gmail path: match by threadId across sibling source_messages ──────
  if (msg.source_type !== "gmail") return null;
  const threadId = msg.metadata?.threadId;
  if (!threadId) return null;

  const { data: siblings, error: sibErr } = await supabase
    .from("source_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("source_type", "gmail")
    .neq("id", msg.id)
    .filter("metadata->>threadId", "eq", threadId);
  if (sibErr || !siblings || siblings.length === 0) return null;

  const siblingIds = siblings.map((r) => r.id);

  const { data: openTask, error: taskErr } = await supabase
    .from("tasks")
    .select("id, updates")
    .eq("user_id", userId)
    .in("status", ["inbox", "in_progress"])
    .in("source_message_id", siblingIds)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (taskErr || !openTask) return null;

  const updates = Array.isArray(openTask.updates) ? openTask.updates : [];
  return { id: openTask.id as string, updates };
}

async function processMessage(msg: any, settings: any, sys: SystemParams) {
  const startTime = Date.now();
  let totalInputTokens = 0, totalOutputTokens = 0, aiModel = "", classification = "", classificationReason = "";

  const preResult = preClassify(msg, settings, sys);

  // Defer: release lock, keep pending — will be picked up when date arrives
  if (preResult.result === "defer") {
    await supabase.from("source_messages").update({ processing_lock_at: null }).eq("id", msg.id);
    return "deferred";
  }

  if (preResult.result === "skip") {
    await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "skip", skip_reason: preResult.skipReason, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
    await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "skipped", ...msgLogFields(msg), pre_classification: preResult.result, ai_classification: "skip", classification_reason: preResult.skipReason, processing_duration_ms: Date.now() - startTime });
    return;
  }

  if (preResult.result === "check_followup") {
    const followup = await checkFollowup(msg, sys);
    totalInputTokens += followup.inputTokens; totalOutputTokens += followup.outputTokens;
    if (!followup.isFollowup) {
      await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "informational", processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
      await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "ok", ...msgLogFields(msg), pre_classification: "check_followup", ai_classification: "informational", classification_reason: followup.reason, ai_input_tokens: totalInputTokens, ai_output_tokens: totalOutputTokens, ai_cost_usd: estimateCost(totalInputTokens, totalOutputTokens, "haiku"), processing_duration_ms: Date.now() - startTime });
      return;
    }
    classification = "actionable"; classificationReason = followup.reason;
  } else if (preResult.result === "customer_inquiry") {
    classification = "actionable"; classificationReason = "customer_inquiry (office address)";
    await supabase.from("source_messages").update({ is_customer_inquiry: true }).eq("id", msg.id);
  } else if (preResult.result === "informational") {
    await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: "informational", skip_reason: preResult.skipReason, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
    await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "ok", ...msgLogFields(msg), pre_classification: preResult.result, ai_classification: "informational", classification_reason: preResult.skipReason, processing_duration_ms: Date.now() - startTime });
    return;
  } else {
    try {
      const classResult = await classifyMessage(msg, settings, sys);
      classification = classResult.classification; classificationReason = classResult.reason;
      totalInputTokens += classResult.inputTokens; totalOutputTokens += classResult.outputTokens;
      aiModel = classResult.model;
    } catch (e) {
      const retryCount = (msg.retry_count || 0) + 1;
      await supabase.from("source_messages").update({ processing_status: retryCount >= 3 ? "processed" : "pending", ai_classification: retryCount >= 3 ? "informational" : "pending", retry_count: retryCount, dead_letter: retryCount >= 3, processing_lock_at: null }).eq("id", msg.id);
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "error", category: "ai_process", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message, retry_count: retryCount });
      return;
    }
  }

  if (classification === "actionable") {
    // ── Thread-aware follow-up: if this Gmail message belongs to a thread
    // that already has an open task, append an update and skip task creation.
    // Saves a Sonnet call and prevents the duplicate the user has been seeing.
    try {
      const linkedTask = await tryLinkToExistingTask(msg, msg.user_id);
      if (linkedTask) {
        await supabase.from("tasks").update({
          updates: [...linkedTask.updates, {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            type: "ai_update",
            actor: "system",
            content: classificationReason || msg.subject || "הודעת המשך בשרשור",
            source_message_id: msg.id,
            source_type: msg.source_type,
          }],
          last_interaction_at: new Date().toISOString(),
        }).eq("id", linkedTask.id);

        await supabase.from("task_activities").insert({
          user_id: msg.user_id,
          task_id: linkedTask.id,
          activity_type: "thread_followup",
          note: `Linked via Gmail thread`,
          actor: "system",
        });

        await supabase.from("source_messages").update({
          processing_status: "processed",
          ai_classification: "actionable_followup",
          processed_at: new Date().toISOString(),
          processing_lock_at: null,
        }).eq("id", msg.id);

        await supabase.from("log_entries").insert({
          user_id: msg.user_id,
          category: "ai_process",
          status: "ok",
          ...msgLogFields(msg),
          pre_classification: preResult.result,
          ai_classification: "actionable_followup",
          classification_reason: `linked to task ${linkedTask.id} via thread`,
          task_id: linkedTask.id,
          ai_model_used: aiModel,
          ai_input_tokens: totalInputTokens,
          ai_output_tokens: totalOutputTokens,
          ai_cost_usd: estimateCost(totalInputTokens, totalOutputTokens, modelTypeFromName(aiModel)),
          processing_duration_ms: Date.now() - startTime,
        });
        return;
      }
    } catch (e) {
      // Linking is opportunistic — if anything goes wrong, fall through to
      // the regular task-creation flow so we never lose the message.
      await supabase.from("log_entries").insert({
        user_id: msg.user_id,
        level: "warning",
        category: "ai_process_link",
        status: "failed",
        ...msgLogFields(msg),
        error_message: (e as Error).message,
      });
    }

    try {
      let projectContext: { projectId: string; brief: string } | undefined;
      const projectMatch = await detectProject(msg, sys, msg.user_id);
      if (projectMatch) {
        totalInputTokens += projectMatch.inputTokens; totalOutputTokens += projectMatch.outputTokens;
        const brief = await getProjectBrief(projectMatch.projectId);
        if (brief) projectContext = { projectId: projectMatch.projectId, brief };
      }

      const taskResult = await createTasksFromMessage(msg, sys, projectContext);
      totalInputTokens += taskResult.inputTokens; totalOutputTokens += taskResult.outputTokens;

      // Sonnet returned no tasks — message is informational despite Haiku's
      // initial guess. Flip classification so the final log_entries reflects
      // the true outcome and the UI doesn't show an empty actionable.
      if (taskResult.tasks.length === 0) {
        classification = "informational";
        classificationReason = "Sonnet returned no actionable tasks (marketing, receipt, or status update).";
        aiModel = taskResult.model;
      } else {
        // Sonnet's reason_he is task-specific; prefer it over the brief Haiku
        // classification reason for the AI Trail block.
        const firstReason = taskResult.tasks.find((t: any) => t.reason_he)?.reason_he;
        if (firstReason) classificationReason = firstReason;
        // Sonnet dominates the cost; record its model for the final log row.
        aiModel = taskResult.model;

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
            await supabase.from("task_activities").insert({ user_id: msg.user_id, task_id: newTask.id, activity_type: "created", new_value: "inbox", note: `Created from ${msg.source_type}: ${msg.subject || "(no subject)"}`, actor: "system" });
          }
        }

        if (!projectContext) {
          await supabase.from("source_messages").update({ needs_project_check: true }).eq("id", msg.id);
        }
      }
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "error", category: "ai_process_tasks", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: classification, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
  const costType = modelTypeFromName(aiModel);
  await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "ok", ...msgLogFields(msg), pre_classification: preResult.result, ai_classification: classification, classification_reason: classificationReason, ai_model_used: aiModel, ai_input_tokens: totalInputTokens, ai_output_tokens: totalOutputTokens, ai_cost_usd: estimateCost(totalInputTokens, totalOutputTokens, costType), processing_duration_ms: Date.now() - startTime });
}

// Cost rates per 1M tokens, keyed by what `modelTypeFromName` returns. Update
// these when Anthropic pricing changes or when a new model is added to
// smrttask_system_params.
function estimateCost(input: number, output: number, type: string): number {
  if (type === "haiku") return (input * 0.80 + output * 4)  / 1_000_000;
  if (type === "opus")  return (input * 15   + output * 75) / 1_000_000;
  return (input * 3 + output * 15) / 1_000_000; // sonnet (default)
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

    // Load system-wide knobs once per cron tick. Used for batch size,
    // lock window, calendar window, model selection, and body truncation.
    const sys = await loadSystemParams();

    await supabase.from("source_messages")
      .update({ processing_lock_at: null })
      .lt("processing_lock_at", new Date(Date.now() - sys.processing_lock_minutes * 60_000).toISOString())
      .not("processing_lock_at", "is", null);

    const { data: pendingUsers } = await supabase
      .from("source_messages")
      .select("user_id")
      .eq("processing_status", "pending")
      .is("processing_lock_at", null)
      .or("dead_letter.eq.false,dead_letter.is.null")
      .or(BODY_TEXT_FILTER)
      .limit(100);
    const uniqueUserIds = [...new Set((pendingUsers || []).map((r) => r.user_id))];
    let totalProcessed = 0;
    let totalDeferred = 0;

    for (const userId of uniqueUserIds) {
      // Load settings + the user's category= skip rules in parallel.
      const [settingsRes, categoryRulesRes] = await Promise.all([
        supabase.from("user_settings").select("*").eq("user_id", userId).single(),
        supabase.from("rules_memory").select("trigger, is_active").eq("user_id", userId).ilike("trigger", "category=%"),
      ]);
      const settings = settingsRes.data;
      if (!settings) continue;

      // Compute the effective Gmail label set once per user per tick.
      // preClassify reads it from settings.__category_filter.
      settings.__category_filter = buildCategoryFilter(categoryRulesRes.data ?? []);

      const withinBudget = await checkDailyBudget(userId, settings.daily_ai_budget_usd || 1.0);
      if (!withinBudget) continue;

      // Fetch priority messages first (whatsapp, calendar, drive), then gmail
      let allMessages: any[] = [];
      for (const st of SOURCE_PRIORITY) {
        if (allMessages.length >= sys.batch_size) break;
        const remaining = sys.batch_size - allMessages.length;
        const { data: msgs } = await supabase
          .from("source_messages")
          .select("*")
          .eq("user_id", userId)
          .eq("processing_status", "pending")
          .eq("source_type", st)
          .is("processing_lock_at", null)
          .or("dead_letter.eq.false,dead_letter.is.null")
          .or(BODY_TEXT_FILTER)
          .order("received_at", { ascending: true })
          .limit(remaining);
        if (msgs && msgs.length > 0) allMessages = allMessages.concat(msgs);
      }

      for (const msg of allMessages) {
        const { data: claimed } = await supabase.from("source_messages").update({ processing_lock_at: new Date().toISOString() }).eq("id", msg.id).is("processing_lock_at", null).select("id").single();
        if (!claimed) continue;
        try {
          const result = await processMessage(msg, settings, sys);
          if (result === "deferred") { totalDeferred++; }
          else { totalProcessed++; }
        }
        catch (e) {
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
