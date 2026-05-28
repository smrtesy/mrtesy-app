import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");

    if (authHeader !== cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Get all users
    const { data: users } = await supabase
      .from("user_settings")
      .select("user_id, classification_model")
      .eq("onboarding_completed", true);

    const results = [];

    for (const userSettings of users || []) {
      const userId = userSettings.user_id;

      // Find messages flagged for project check
      const { data: messages } = await supabase
        .from("source_messages")
        .select("id, sender_email, sender, subject, body_text, source_type")
        .eq("user_id", userId)
        .eq("needs_project_check", true)
        .limit(50);

      if (!messages || messages.length === 0) {
        results.push({ user_id: userId, checked: 0 });
        continue;
      }

      // Group by sender/subject pattern
      const patterns: Record<string, number> = {};
      for (const msg of messages) {
        const key = (msg.sender_email || msg.sender || "unknown").toLowerCase();
        patterns[key] = (patterns[key] || 0) + 1;
      }

      // Find senders with 3+ messages (potential project)
      const candidates = Object.entries(patterns)
        .filter(([_, count]) => count >= 3)
        .map(([sender]) => sender);

      if (candidates.length === 0) {
        // Reset flags
        await supabase.from("source_messages")
          .update({ needs_project_check: false })
          .eq("user_id", userId)
          .eq("needs_project_check", true);
        results.push({ user_id: userId, checked: messages.length, suggestions: 0 });
        continue;
      }

      // Get existing projects to avoid duplicates
      const { data: existingProjects } = await supabase
        .from("projects")
        .select("name, name_he")
        .eq("user_id", userId)
        .eq("is_active", true);

      const existingNames = (existingProjects || []).map((p) =>
        (p.name || p.name_he || "").toLowerCase()
      );

      // Use Haiku to suggest project names
      const model = userSettings.classification_model || "claude-haiku-4-5-20251001";
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

      const candidateMessages = candidates.map((sender) => {
        const msgs = messages.filter(
          (m) => (m.sender_email || m.sender || "").toLowerCase() === sender
        );
        return `Sender: ${sender} (${msgs.length} messages)\nSubjects: ${msgs.map((m) => m.subject).join(", ")}`;
      }).join("\n\n");

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          system: `You suggest project groupings for a task management system.
Existing projects: ${existingNames.join(", ") || "none"}
Do NOT suggest projects that already exist.
Return JSON array: [{"name": "English name", "name_he": "Hebrew name", "reason": "why"}]
If no new projects needed, return empty array: []
Be conservative — only suggest clear, distinct projects. NOT every sender is a project.`,
          messages: [{ role: "user", content: candidateMessages }],
        }),
      });

      let suggestions: any[] = [];
      if (resp.ok) {
        const data = await resp.json();
        const text = data.content?.[0]?.text || "[]";
        // Unified cost ledger (best-effort).
        try {
          const inTok = data.usage?.input_tokens || 0;
          const outTok = data.usage?.output_tokens || 0;
          const r = model.includes("opus") ? { i: 15, o: 75 } : model.includes("sonnet") ? { i: 3, o: 15 } : { i: 0.8, o: 4 };
          await supabase.from("ai_usage").insert({
            user_id: userId,
            provider: "anthropic",
            component: "project_detection",
            model,
            input_tokens: inTok,
            output_tokens: outTok,
            cost_usd: (inTok * r.i + outTok * r.o) / 1_000_000,
          });
        } catch (_e) { /* ledger insert must not break processing */ }
        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) suggestions = JSON.parse(jsonMatch[0]);
        } catch (_e) { /* ignore parse errors */ }
      }

      // Create suggestion tasks for each new project
      for (const suggestion of suggestions) {
        await supabase.from("tasks").insert({
          user_id: userId,
          title: `Project suggestion: ${suggestion.name}`,
          title_he: `הצעת פרויקט: ${suggestion.name_he || suggestion.name}`,
          description: suggestion.reason,
          task_type: "project_suggestion",
          priority: "low",
          status: "inbox",
          ai_model_used: model,
        });
      }

      // Reset flags
      await supabase.from("source_messages")
        .update({ needs_project_check: false })
        .eq("user_id", userId)
        .eq("needs_project_check", true);

      results.push({
        user_id: userId,
        checked: messages.length,
        suggestions: suggestions.length,
      });
    }

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
