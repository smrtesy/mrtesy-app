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
        // Drives the "returned from snooze" chip in the UI; cleared on the
        // user's first interaction with the row.
        woke_from_snooze_at: now,
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
    .select("source_type, received_at, metadata, recipient, subject")
    .eq("id", task.source_message_id)
    .maybeSingle();
  if (!sent) return false;

  const sentAt = sent.received_at ?? new Date(0).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (sent.metadata ?? {}) as any;
  const threadId = meta.threadId as string | undefined;
  const chatId = meta.chatId as string | undefined;

  if (threadId) {
    // Gmail: same thread, inbound side only. source_messages keeps one row per
    // inbound email, so an inbound after the send time means a reply arrived.
    const { count } = await supabase
      .from("source_messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", task.user_id)
      .eq("source_type", "gmail")
      .gt("received_at", sentAt)
      .filter("metadata->>threadId", "eq", threadId);
    if ((count ?? 0) > 0) return true;
    // Fall through to the recipient fallback — threadId is not always stamped
    // consistently on the outgoing row, so a thread miss is NOT proof the other
    // side stayed silent (the "היא ענתה, למה המעקב חזר אחרי 48ש'?" bug).
  }

  // Gmail fallback (no threadId, or thread match found nothing): a reply is an
  // inbound gmail FROM the address we wrote to, arriving after we sent. Catches
  // the common case where the outgoing row carried no usable threadId.
  if (!chatId) {
    const recipientRaw =
      (sent.recipient as string | undefined) ||
      (meta.to as string | undefined) ||
      null;
    if (recipientRaw) {
      const addr = (recipientRaw.match(/<([^>]+)>/)?.[1] ?? recipientRaw).trim();
      if (addr) {
        // Scope by SUBJECT too, not just the address: a high-frequency
        // correspondent (or a newsletter from the same address) would otherwise
        // mark an unrelated later email as "the reply" and wrongly suppress the
        // reminder. Strip Re:/Fwd: prefixes so the reply's "Re: <x>" matches the
        // original "<x>"; escape LIKE wildcards in the subject.
        const baseSubject = String(sent.subject ?? "")
          .replace(/^((re|fwd|fw|aw|תשובה|הועבר)\s*:\s*)+/i, "")
          .trim();
        let q = supabase
          .from("source_messages")
          .select("id", { count: "exact", head: true })
          .eq("user_id", task.user_id)
          .eq("source_type", "gmail")
          .gt("received_at", sentAt)
          .ilike("sender_email", addr);
        if (baseSubject) {
          const escaped = baseSubject.replace(/[%_\\]/g, "\\$&");
          q = q.ilike("subject", `%${escaped}%`);
        }
        const { count } = await q;
        if ((count ?? 0) > 0) return true;
      }
    }
    return false;
  }

  if (chatId) {
    // WhatsApp: the authoritative per-message log is whatsapp_messages
    // (real direction + immutable received_at per message). The source_messages
    // burst rows carry the transcript for classification but aren't the
    // per-message ledger, so we answer "did a reply arrive?" straight from
    // whatsapp_messages. We're still waiting iff the latest non-reaction message
    // in the chat is outgoing — i.e. no inbound reply exists AFTER our last
    // outgoing message.
    const { data: lastOut } = await supabase
      .from("whatsapp_messages")
      .select("received_at")
      .eq("user_id", task.user_id)
      .eq("chat_id", chatId)
      .eq("direction", "outgoing")
      .eq("is_reaction", false)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Nothing sent on this chat → no outgoing to wait on; surface the follow-up.
    if (!lastOut?.received_at) return false;
    const { count } = await supabase
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", task.user_id)
      .eq("chat_id", chatId)
      .eq("direction", "incoming")
      .eq("is_reaction", false)
      .gt("received_at", lastOut.received_at);
    return (count ?? 0) > 0;
  }

  // No thread handle to match a reply against — surface the follow-up.
  return false;
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
