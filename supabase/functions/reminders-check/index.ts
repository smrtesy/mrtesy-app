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
      // Skip if task is already archived/completed/dismissed — we don't
      // want to fire reminders on suggestions the user has thrown away.
      const taskStatus = reminder.tasks?.status;
      if (taskStatus === "archived" || taskStatus === "completed" || taskStatus === "dismissed") {
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
          content: reminder.message_he || reminder.message || "תזכורת",
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

    // Also check for snoozed tasks that should wake up. Skip terminal
    // statuses (archived/completed/dismissed) — a dismissed task with an
    // old snoozed_until from before dismissal must NOT bounce back into inbox.
    const { data: snoozedTasks } = await supabase
      .from("tasks")
      .select("id, user_id, title_he, task_type, source_message_id")
      .lte("snoozed_until", now)
      .not("snoozed_until", "is", null)
      .not("status", "in", "(archived,completed,dismissed)");

    let suppressed = 0;
    for (const task of snoozedTasks || []) {
      // Follow-up suggestions are only worth surfacing if the other side never
      // replied. If a reply has arrived on the same thread since we sent the
      // message, the loop closed itself — auto-dismiss instead of nagging.
      if (task.task_type === "followup" && (await replyArrived(task))) {
        await supabase.from("tasks").update({
          snoozed_until: null,
          status: "dismissed",
          dismissal_reason_code: "reply_received",
          dismissal_reason_text: "התקבלה תגובה — המעקב נסגר אוטומטית",
          last_updated_reason: "followup_reply_received",
          status_changed_at: now,
          updated_at: now,
        }).eq("id", task.id);
        suppressed++;
        continue;
      }
      await supabase.from("tasks").update({
        snoozed_until: null,
        status: "inbox",
        last_updated_reason: "snooze_expired",
        updated_at: now,
      }).eq("id", task.id);
    }

    return new Response(JSON.stringify({
      reminders_processed: processed,
      snoozed_woken: (snoozedTasks?.length || 0) - suppressed,
      followups_suppressed: suppressed,
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

// Did the other party reply on the same thread after we sent the message that
// spawned this follow-up? Looks the sent message up via source_message_id, then
// scans for an INBOUND message (gmail / whatsapp — not the *_sent / *_echo
// outgoing kinds) on the same thread received after the send time.
async function replyArrived(task: { user_id: string | null; source_message_id: string | null }): Promise<boolean> {
  if (!task.source_message_id || !task.user_id) return false;
  const { data: sent } = await supabase
    .from("source_messages")
    .select("source_type, received_at, metadata")
    .eq("id", task.source_message_id)
    .maybeSingle();
  if (!sent) return false;

  const sentAt = sent.received_at ?? new Date(0).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (sent.metadata ?? {}) as any;
  const threadId = meta.threadId as string | undefined;
  const chatId = meta.chatId as string | undefined;

  let q = supabase
    .from("source_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", task.user_id)
    .gt("received_at", sentAt);

  if (threadId) {
    // Gmail: same thread, inbound side only.
    q = q.eq("source_type", "gmail").filter("metadata->>threadId", "eq", threadId);
  } else if (chatId) {
    // WhatsApp: same chat, inbound messages.
    q = q.eq("source_type", "whatsapp").filter("metadata->>chatId", "eq", chatId);
  } else {
    // No thread handle to match a reply against — surface the follow-up.
    return false;
  }

  const { count } = await q;
  return (count ?? 0) > 0;
}

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
