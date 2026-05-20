import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    // Auth via JWT
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
    if (!user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { task_id, action_label, prompt } = await req.json();
    if (!task_id || !prompt) {
      return new Response(JSON.stringify({ error: "task_id and prompt required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Get user settings for model
    const { data: settings } = await supabase
      .from("user_settings")
      .select("summary_model")
      .eq("user_id", user.id)
      .single();

    const model = settings?.summary_model || "claude-sonnet-4-6";

    let context: string;
    let taskTitle: string;

    // CHANGED: Handle "new-task" — skip DB lookup, use prompt directly
    if (task_id === "new-task") {
      context = `User request: ${prompt}`;
      taskTitle = "new-task";
    } else {
      // Get task details from DB
      const { data: task } = await supabase
        .from("tasks")
        .select("*, source_messages(subject, body_text, sender, sender_email)")
        .eq("id", task_id)
        .eq("user_id", user.id)
        .single();

      if (!task) {
        return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      taskTitle = task.title_he || task.title;
      const sourceMsg = task.source_messages;
      context = `Task: ${task.title_he || task.title}
Description: ${task.description || ""}
From: ${sourceMsg?.sender || ""} (${sourceMsg?.sender_email || ""})
Subject: ${sourceMsg?.subject || ""}
Original message: ${(sourceMsg?.body_text || "").substring(0, 3000)}`;
    }

    // Call Claude
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: "You are a helpful assistant for a personal task management system. Respond in the same language as the original message (Hebrew or English). Be concise and actionable.",
        messages: [{
          role: "user",
          content: `${context}\n\nAction requested: ${action_label || ""}\nPrompt: ${prompt}`,
        }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Claude API: ${resp.status} ${err}`);
    }

    const data = await resp.json();
    const result = data.content?.[0]?.text || "";
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    // Save to ai_generated_content only for existing tasks (not new-task)
    if (task_id !== "new-task") {
      const { data: existingTask } = await supabase
        .from("tasks")
        .select("ai_generated_content")
        .eq("id", task_id)
        .single();

      const generated = existingTask?.ai_generated_content || [];
      generated.push({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        action_label: action_label || "quick_action",
        prompt,
        result,
        model,
        cost_usd: cost,
      });

      await supabase.from("tasks").update({
        ai_generated_content: generated,
        updated_at: new Date().toISOString(),
      }).eq("id", task_id);
    }

    // Log
    await supabase.from("log_entries").insert({
      user_id: user.id,
      category: "quick_action",
      status: "ok",
      task_id: task_id === "new-task" ? null : task_id,
      task_title: taskTitle,
      task_action: action_label,
      ai_model_used: model,
      ai_input_tokens: inputTokens,
      ai_output_tokens: outputTokens,
      ai_cost_usd: cost,
    });

    return new Response(JSON.stringify({ result, cost_usd: cost }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
