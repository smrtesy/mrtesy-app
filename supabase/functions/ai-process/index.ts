import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const BATCH_SIZE = 40;

// Priority order: whatsapp/calendar/drive first, then gmail with body
const SOURCE_PRIORITY = ["whatsapp", "whatsapp_echo", "google_calendar", "google_drive", "gmail", "gmail_sent"];

const BODY_TEXT_FILTER = "body_text.not.is.null,source_type.eq.whatsapp,source_type.eq.whatsapp_echo,source_type.eq.google_calendar,source_type.eq.google_drive";

function preClassify(msg: any, settings: any): { result: string; skipReason?: string } {
  const sender = (msg.sender_email || msg.sender || "").toLowerCase();
  const recipient = (msg.recipient || "").toLowerCase();
  const body = (msg.body_text || "").toLowerCase();
  const sourceType = msg.source_type || "";
  const myEmails = (settings.my_emails || []).map((e: string) => e.toLowerCase());
  const officeAddresses = (settings.office_addresses || []).map((e: string) => e.toLowerCase());
  const skipSenders = (settings.skip_senders || []).map((e: string) => e.toLowerCase());
  const skipRecipients = (settings.skip_recipients || []).map((e: string) => e.toLowerCase());

  for (const sr of skipRecipients) {
    if (recipient.includes(sr)) return { result: "skip", skipReason: `recipient: ${sr}` };
  }

  // Calendar events: only process if within window (yesterday to +1 day)
  if (sourceType === "google_calendar" && msg.received_at) {
    const eventDate = new Date(msg.received_at);
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (eventDate < oneDayAgo) {
      return { result: "skip", skipReason: "past_calendar_event" };
    }
    if (eventDate > oneDayFromNow) {
      return { result: "defer", skipReason: "future_calendar_event" };
    }
  }

  if (sourceType === "whatsapp_echo") return { result: "check_followup" };
  if (sourceType === "gmail_sent") return { result: "check_followup" };
  if (myEmails.some((e: string) => sender.includes(e))) return { result: "check_followup" };
  if (officeAddresses.some((e: string) => sender.includes(e))) return { result: "customer_inquiry" };
  if (skipSenders.some((e: string) => sender.includes(e))) return { result: "informational", skipReason: `skip_sender: ${sender}` };
  const skipPatterns = ["unsubscribe", "no-reply", "noreply", "newsletter", "marketing"];
  if (skipPatterns.some((p) => body.includes(p) || sender.includes(p))) {
    return { result: "informational", skipReason: "skip_pattern" };
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

async function classifyMessage(msg: any, settings: any) {
  const model = settings.classification_model || "claude-haiku-4-5-20251001";
  const systemPrompt = `You are a message classifier for a personal task management system.\nRules: outbox@maor.org\u2192informational | Payment confirmations\u2192informational | maor.org emails\u2192classify by content (NOT spam!)\nRespond: WORD | reason in Hebrew. WORD: ACTIONABLE | INFORMATIONAL | SPAM`;
  const userMessage = `From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${(msg.body_text || "").substring(0, 2000)}`;
  const result = await callClaude(model, systemPrompt, userMessage, 100);
  const text = result.text.trim().toUpperCase();
  let classification = "informational";
  if (text.startsWith("ACTIONABLE")) classification = "actionable";
  else if (text.startsWith("SPAM")) classification = "spam";
  return { classification, reason: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model };
}

async function detectProject(msg: any, settings: any, userId: string) {
  const { data: projects } = await supabase.from("projects").select("id, name, name_he").eq("user_id", userId).eq("is_active", true);
  if (!projects || projects.length === 0) return null;
  const model = settings.classification_model || "claude-haiku-4-5-20251001";
  const projectList = projects.map((p: any) => `${p.id}: ${p.name_he || p.name}`).join("\n");
  const result = await callClaude(model, `Given these projects:\n${projectList}\n\nDoes this message belong to one of them? Respond with ONLY the project ID or 'none'.`, `From: ${msg.sender_email}\nSubject: ${msg.subject}\n${(msg.body_text || "").substring(0, 500)}`, 50);
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

async function createTasksFromMessage(msg: any, settings: any, projectContext?: { projectId: string; brief: string }) {
  const model = settings.summary_model || "claude-sonnet-4-6";
  let systemPrompt = `You are a task extraction AI. Always return a JSON Array.\nFor each task: {"title_he":"Hebrew title","description":"detailed summary","priority":"urgent|high|medium|low","due_date":"YYYY-MM-DD or null","ai_actions":[{"label":"string","prompt":"string"}],"owner_contact":"string or null"}\nRespond with ONLY the JSON array.`;
  if (projectContext?.brief) {
    systemPrompt += `\n\nProject context (use for better task extraction):\n${projectContext.brief}`;
  }
  const userMessage = `From: ${msg.sender_email || msg.sender}\nTo: ${msg.recipient || ""}\nSubject: ${msg.subject || ""}\n\n${(msg.body_text || "").substring(0, 4000)}`;
  const result = await callClaude(model, systemPrompt, userMessage, 2048);
  let tasks: any[] = [];
  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) tasks = JSON.parse(jsonMatch[0]);
  } catch { tasks = [{ title_he: msg.subject || "\u05de\u05e9\u05d9\u05de\u05d4 \u05d7\u05d3\u05e9\u05d4", description: result.text, priority: "medium", due_date: null, ai_actions: [], owner_contact: null }]; }
  return { tasks, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model, projectId: projectContext?.projectId || null };
}

async function checkFollowup(msg: any, settings: any) {
  const model = settings.classification_model || "claude-haiku-4-5-20251001";
  const result = await callClaude(model, `Determine if this outgoing message requires follow-up tracking.\nRespond: FOLLOWUP | reason OR INFO | reason`, `Subject: ${msg.subject || ""}\n\n${(msg.body_text || "").substring(0, 2000)}`, 100);
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

async function processMessage(msg: any, settings: any) {
  const startTime = Date.now();
  let totalInputTokens = 0, totalOutputTokens = 0, aiModel = "", classification = "", classificationReason = "";

  const preResult = preClassify(msg, settings);

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
    const followup = await checkFollowup(msg, settings);
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
      const classResult = await classifyMessage(msg, settings);
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
    try {
      let projectContext: { projectId: string; brief: string } | undefined;
      const projectMatch = await detectProject(msg, settings, msg.user_id);
      if (projectMatch) {
        totalInputTokens += projectMatch.inputTokens; totalOutputTokens += projectMatch.outputTokens;
        const brief = await getProjectBrief(projectMatch.projectId);
        if (brief) projectContext = { projectId: projectMatch.projectId, brief };
      }

      const taskResult = await createTasksFromMessage(msg, settings, projectContext);
      totalInputTokens += taskResult.inputTokens; totalOutputTokens += taskResult.outputTokens;

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
    } catch (e) {
      await supabase.from("log_entries").insert({ user_id: msg.user_id, level: "error", category: "ai_process_tasks", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
    }
  }

  await supabase.from("source_messages").update({ processing_status: "processed", ai_classification: classification, processed_at: new Date().toISOString(), processing_lock_at: null }).eq("id", msg.id);
  const costType = aiModel.includes("haiku") ? "haiku" : "sonnet";
  await supabase.from("log_entries").insert({ user_id: msg.user_id, category: "ai_process", status: "ok", ...msgLogFields(msg), pre_classification: preResult.result, ai_classification: classification, classification_reason: classificationReason, ai_model_used: aiModel, ai_input_tokens: totalInputTokens, ai_output_tokens: totalOutputTokens, ai_cost_usd: estimateCost(totalInputTokens, totalOutputTokens, costType), processing_duration_ms: Date.now() - startTime });
}

function estimateCost(input: number, output: number, type: string): number {
  if (type === "haiku") return (input * 0.25 + output * 1.25) / 1_000_000;
  return (input * 3 + output * 15) / 1_000_000;
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

    await supabase.from("source_messages").update({ processing_lock_at: null }).lt("processing_lock_at", new Date(Date.now() - 10 * 60 * 1000).toISOString()).not("processing_lock_at", "is", null);

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
      const { data: settings } = await supabase.from("user_settings").select("*").eq("user_id", userId).single();
      if (!settings) continue;

      const withinBudget = await checkDailyBudget(userId, settings.daily_ai_budget_usd || 1.0);
      if (!withinBudget) continue;

      // Fetch priority messages first (whatsapp, calendar, drive), then gmail
      let allMessages: any[] = [];
      for (const st of SOURCE_PRIORITY) {
        if (allMessages.length >= BATCH_SIZE) break;
        const remaining = BATCH_SIZE - allMessages.length;
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
          const result = await processMessage(msg, settings);
          if (result === "deferred") { totalDeferred++; }
          else { totalProcessed++; }
        }
        catch (e) {
          await supabase.from("source_messages").update({ processing_lock_at: null, retry_count: (msg.retry_count || 0) + 1 }).eq("id", msg.id);
          await supabase.from("log_entries").insert({ user_id: userId, level: "error", category: "ai_process", status: "failed", ...msgLogFields(msg), error_message: (e as Error).message });
        }
      }
    }
    return new Response(JSON.stringify({ processed: totalProcessed, deferred: totalDeferred, batchSize: BATCH_SIZE }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
