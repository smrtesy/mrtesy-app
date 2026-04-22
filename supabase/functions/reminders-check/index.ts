import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const now = new Date().toISOString();

    // Find due reminders
    const { data: dueReminders } = await supabase
      .from("reminders")
      .select("*, tasks(id, title, title_he, status)")
      .eq("is_active", true)
      .eq("is_sent", false)
      .lte("remind_at", now)
      .order("remind_at", { ascending: true })
      .limit(100);

    let processed = 0;

    for (const reminder of dueReminders || []) {
      // Skip if task is already archived/completed
      if (reminder.tasks?.status === "archived" || reminder.tasks?.status === "completed") {
        await supabase.from("reminders").update({
          is_active: false,
          is_sent: true,
          sent_at: now,
        }).eq("id", reminder.id);
        continue;
      }

      // Mark reminder as sent
      await supabase.from("reminders").update({
        is_sent: true,
        sent_at: now,
      }).eq("id", reminder.id);

      // Add update to task
      if (reminder.task_id) {
        const { data: task } = await supabase
          .from("tasks")
          .select("updates")
          .eq("id", reminder.task_id)
          .single();

        const updates = task?.updates || [];
        updates.push({
          id: crypto.randomUUID(),
          created_at: now,
          type: "reminder",
          actor: "system",
          content: reminder.message_he || reminder.message || "\u05ea\u05d6\u05db\u05d5\u05e8\u05ea",
        });

        await supabase.from("tasks").update({
          updates,
          last_updated_reason: "reminder",
          updated_at: now,
        }).eq("id", reminder.task_id);
      }

      // Handle recurrence
      if (reminder.recurrence_rule) {
        try {
          // Simple recurrence: parse next occurrence
          // For now, just deactivate. Full RRULE support via npm:rrule in future.
          await supabase.from("reminders").update({
            is_sent: false,
            is_active: true,
            remind_at: calculateNextOccurrence(reminder.remind_at, reminder.recurrence_rule),
          }).eq("id", reminder.id);
        } catch (_e) {
          // Invalid rule — deactivate
          await supabase.from("reminders").update({ is_active: false }).eq("id", reminder.id);
        }
      }

      processed++;
    }

    // Also check for snoozed tasks that should wake up
    const { data: snoozedTasks } = await supabase
      .from("tasks")
      .select("id, user_id, title_he")
      .lte("snoozed_until", now)
      .not("snoozed_until", "is", null)
      .neq("status", "archived");

    for (const task of snoozedTasks || []) {
      await supabase.from("tasks").update({
        snoozed_until: null,
        status: "inbox",
        last_updated_reason: "snooze_expired",
        updated_at: now,
      }).eq("id", task.id);
    }

    return new Response(JSON.stringify({
      reminders_processed: processed,
      snoozed_woken: snoozedTasks?.length || 0,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

function calculateNextOccurrence(currentRemindAt: string, rule: string): string {
  // Simple daily/weekly/monthly recurrence
  const date = new Date(currentRemindAt);
  if (rule.includes("DAILY")) {
    date.setDate(date.getDate() + 1);
  } else if (rule.includes("WEEKLY")) {
    date.setDate(date.getDate() + 7);
  } else if (rule.includes("MONTHLY")) {
    date.setMonth(date.getMonth() + 1);
  } else {
    // Default: 1 day
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString();
}
