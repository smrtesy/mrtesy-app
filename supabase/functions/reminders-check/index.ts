import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { nextOccurrence, recurrenceFreq } from "../_shared/recurrence.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// UTC instant of `hour`:00 local time in `tz` on `dateStr` (YYYY-MM-DD).
// Mirror of the helper in server/.../tasks/routes.ts so a materialised
// occurrence wakes at the same 07:00-local moment a completed one would.
function utcInstantForLocalHour(dateStr: string, hour: number, tz: string): Date {
  const target = Date.parse(`${dateStr}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const wallAsUtc = (instant: number): number => {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date(instant))) parts[p.type] = p.value;
    const hh = parts.hour === "24" ? "00" : parts.hour;
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}.000Z`);
  };
  let x = target - (wallAsUtc(target) - target);
  x = x - (wallAsUtc(x) - target);
  return new Date(x);
}

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
        const { error: deactivateError } = await supabase.from("reminders").update({
          is_active: false,
          is_sent: true,
          sent_at: now,
        }).eq("id", reminder.id);
        if (deactivateError) console.error("reminders deactivate failed:", deactivateError);
        continue;
      }

      // Mark reminder as sent
      const { error: markSentError } = await supabase.from("reminders").update({
        is_sent: true,
        sent_at: now,
      }).eq("id", reminder.id);
      if (markSentError) console.error("reminders mark-sent update failed:", markSentError);

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

        const { error: taskUpdatesError } = await supabase.from("tasks").update({
          updates,
          last_updated_reason: "reminder",
          updated_at: now,
        }).eq("id", reminder.task_id);
        if (taskUpdatesError) console.error("tasks reminder update failed:", taskUpdatesError);
      }

      // Handle recurrence
      if (reminder.recurrence_rule) {
        try {
          // Simple recurrence: parse next occurrence
          // For now, just deactivate. Full RRULE support via npm:rrule in future.
          const { error: recurrenceUpdateError } = await supabase.from("reminders").update({
            is_sent: false,
            is_active: true,
            remind_at: calculateNextOccurrence(reminder.remind_at, reminder.recurrence_rule),
          }).eq("id", reminder.id);
          if (recurrenceUpdateError) console.error("reminders recurrence update failed:", recurrenceUpdateError);
        } catch (_e) {
          // Invalid rule — deactivate
          const { error: ruleDeactivateError } = await supabase.from("reminders").update({ is_active: false }).eq("id", reminder.id);
          if (ruleDeactivateError) console.error("reminders deactivate failed:", ruleDeactivateError);
        }
      }

      processed++;
    }

    // Also check for snoozed tasks that should wake up. Skip terminal
    // statuses (archived/completed/dismissed) — a dismissed task with an
    // old snoozed_until from before dismissal must NOT bounce back into inbox.
    const { data: snoozedTasks } = await supabase
      .from("tasks")
      .select("id, user_id, title_he, task_type, source_message_id, status, completion_signal_detected")
      .lte("snoozed_until", now)
      .not("snoozed_until", "is", null)
      .not("status", "in", "(archived,completed,dismissed)");

    let suppressed = 0;
    for (const task of snoozedTasks || []) {
      // Follow-up suggestions are only worth surfacing if the other side never
      // replied. If a reply has arrived on the same thread since we sent the
      // message, the loop USUALLY closed itself — but a reply is not always a
      // resolution: on a pending-outcome matter (a donation that must go
      // through, a payment to fix) the reply may be a mere clarifying exchange
      // ("Which cc?" → the user answers) while the outcome is still pending.
      // Consult the classifier-maintained thread state: when it says the
      // matter is still open, WAKE the follow-up for a one-click decision
      // instead of silently dropping a live matter; auto-dismiss only when the
      // thread is resolved or we have no signal (legacy behavior).
      if (task.task_type === "followup" && (await replyArrived(task))) {
        // A completion signal already recorded on the task (pending_completion
        // surface, or completion_signal_detected) means the reply DID close the
        // loop — never wipe that state with an inbox wake; fall through to the
        // legacy auto-dismiss below.
        const completionRecorded =
          task.status === "pending_completion" || task.completion_signal_detected === true;
        if (!completionRecorded && (await matterStillPending(task))) {
          // Surface with a visible explanation (tasks.updates feeds the task's
          // activity trail in the UI) — the reply alone did not close the matter.
          const { data: taskRow } = await supabase
            .from("tasks").select("updates").eq("id", task.id).single();
          const updates = taskRow?.updates || [];
          updates.push({
            id: crypto.randomUUID(),
            created_at: now,
            type: "reminder",
            actor: "system",
            content: "התקבלה תגובה בשיחה, אך העניין עדיין לא נסגר — המעקב הוחזר לתיבה לבדיקה",
          });
          const { error: pendingWakeError } = await supabase.from("tasks").update({
            snoozed_until: null,
            status: "inbox",
            updates,
            last_updated_reason: "followup_reply_pending_outcome",
            woke_from_snooze_at: now,
            updated_at: now,
          }).eq("id", task.id);
          if (pendingWakeError) console.error("tasks followup pending wake failed:", pendingWakeError);
          continue;
        }
        const { error: suppressError } = await supabase.from("tasks").update({
          snoozed_until: null,
          status: "dismissed",
          dismissal_reason_code: "reply_received",
          dismissal_reason_text: "התקבלה תגובה — המעקב נסגר אוטומטית",
          last_updated_reason: "followup_reply_received",
          status_changed_at: now,
          updated_at: now,
        }).eq("id", task.id);
        if (suppressError) console.error("tasks followup suppress failed:", suppressError);
        suppressed++;
        continue;
      }
      const { error: wakeError } = await supabase.from("tasks").update({
        snoozed_until: null,
        status: "inbox",
        last_updated_reason: "snooze_expired",
        // Drives the "returned from snooze" chip in the UI; cleared on the
        // user's first interaction with the row.
        woke_from_snooze_at: now,
        updated_at: now,
      }).eq("id", task.id);
      if (wakeError) console.error("tasks snooze wake failed:", wakeError);
    }

    // ── Recurring materialisation ──────────────────────────────────────────
    // complete-spawn only advances a recurring task when the user COMPLETES the
    // current occurrence, so a task they never close (e.g. a daily "check the
    // log") never produces its next instance and just lingers overdue. Advance
    // each series whose latest open occurrence is already overdue — i.e. nothing
    // is scheduled for today or later:
    //   DAILY / WEEKLY      → roll the SAME row forward to its next date (one
    //                         fresh item per period; no pile-up of missed days).
    //   MONTHLY / YEARLY /  → spawn the next occurrence snoozed to its date,
    //   HEBREW_*              leaving the overdue one visible (a missed monthly
    //                         obligation stays on the desk).
    const today = now.slice(0, 10);
    const yesterday = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 86_400_000)
      .toISOString().slice(0, 10);

    const { data: openRec } = await supabase
      .from("tasks")
      .select("id, user_id, organization_id, status, due_date, due_time, reminder_at, recurrence_rule, recurrence_until, recurrence_parent_id, title, title_he, description, priority, task_type, size, context, project_id, tags, checklist")
      .not("recurrence_rule", "is", null)
      .in("status", ["inbox", "in_progress", "snoozed", "pending_completion"]);

    // Per series (recurrence_parent_id ?? id), keep only the latest occurrence.
    const latestPerSeries = new Map<string, Record<string, unknown>>();
    for (const t of openRec || []) {
      if (!t.due_date) continue;
      const key = (t.recurrence_parent_id as string | null) ?? (t.id as string);
      const cur = latestPerSeries.get(key);
      if (!cur || (t.due_date as string) > (cur.due_date as string)) latestPerSeries.set(key, t);
    }
    const toAdvance = [...latestPerSeries.values()].filter((t) => (t.due_date as string) < today);

    // Batch-load owners' timezones for the 07:00-local wake of stacked/snoozed rows.
    const tzByUser = new Map<string, string>();
    if (toAdvance.length) {
      const userIds = [...new Set(toAdvance.map((t) => t.user_id as string).filter(Boolean))];
      const { data: settings } = await supabase
        .from("user_settings").select("user_id, timezone").in("user_id", userIds);
      for (const s of settings || []) {
        tzByUser.set(s.user_id as string, (s.timezone as string | null) || "Asia/Jerusalem");
      }
    }

    let rolledForward = 0;
    let stacked = 0;
    for (const t of toAdvance) {
      // Don't advance a series whose current occurrence the user is actively
      // engaged with: roll-forward would wipe in-progress checklist state, and a
      // pending_completion row is awaiting the user's confirm (after which
      // complete-spawn handles the next one). Leave it; advance on a later run.
      if (t.status === "in_progress" || t.status === "pending_completion") continue;
      const rule = t.recurrence_rule as string;
      // First scheduled date strictly after yesterday → on/after today.
      const next = nextOccurrence(rule, t.due_date as string, yesterday);
      if (!next || next < today) continue; // unparseable, or catch-up cap left it stale
      const until = t.recurrence_until as string | null;
      if (until && next > until) continue; // series ended

      const tz = tzByUser.get(t.user_id as string) || "Asia/Jerusalem";
      const isToday = next === today; // next >= today guaranteed; equal → due today
      const status = isToday ? "inbox" : "snoozed";
      const snoozedUntil = isToday ? null : utcInstantForLocalHour(next, 7, tz).toISOString();

      // Carry the reminder offset (gap between due_date and reminder_at) forward.
      let nextReminder: string | null = null;
      if (t.reminder_at && t.due_date) {
        const offsetMs = new Date(t.reminder_at as string).getTime()
          - new Date(`${t.due_date}T00:00:00.000Z`).getTime();
        nextReminder = new Date(new Date(`${next}T00:00:00.000Z`).getTime() + offsetMs).toISOString();
      }
      const checklist = Array.isArray(t.checklist)
        ? (t.checklist as Record<string, unknown>[]).map((c) => ({ ...c, done: false, completed_at: null }))
        : t.checklist;

      const freq = recurrenceFreq(rule);
      const rollForward = freq === "DAILY" || freq === "WEEKLY";

      if (rollForward) {
        const { error: updErr } = await supabase.from("tasks").update({
          due_date: next,
          reminder_at: nextReminder,
          status,
          snoozed_until: snoozedUntil,
          woke_from_snooze_at: isToday ? now : null,
          completion_signal_detected: false,
          completion_signal_reason: null,
          checklist,
          last_updated_reason: "recurrence_rolled_forward",
          status_changed_at: now,
          updated_at: now,
        }).eq("id", t.id as string);
        if (!updErr) rolledForward++;
        else console.error(`[reminders-check] failed to roll forward recurrence ${t.id}: ${updErr.message}`);
      } else {
        const { error: insErr } = await supabase.from("tasks").insert({
          user_id: t.user_id,
          organization_id: t.organization_id,
          title: t.title, title_he: t.title_he, description: t.description,
          priority: t.priority, task_type: t.task_type ?? "action",
          // Inherit the parent's effort size/context — don't fall back to the DB default.
          size: t.size ?? "medium", context: t.context,
          status, manually_verified: true,
          snoozed_until: snoozedUntil,
          due_date: next, due_time: t.due_time,
          reminder_at: nextReminder,
          recurrence_rule: t.recurrence_rule,
          recurrence_until: t.recurrence_until,
          recurrence_parent_id: (t.recurrence_parent_id as string | null) ?? (t.id as string),
          project_id: t.project_id, tags: t.tags, checklist,
        });
        if (!insErr) stacked++;
        else console.error(`[reminders-check] failed to stack recurrence for ${t.id}: ${insErr.message}`);
      }
    }

    return new Response(JSON.stringify({
      reminders_processed: processed,
      snoozed_woken: (snoozedTasks?.length || 0) - suppressed,
      followups_suppressed: suppressed,
      recurrences_rolled_forward: rolledForward,
      recurrences_stacked: stacked,
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

// A reply arrived — but is the matter this follow-up tracks still OPEN?
// thread_memory is the classifier-maintained per-thread state (one slot per
// Gmail thread / WhatsApp chat, upserted on every classified burst). If it
// says the thread is anything other than resolved, the reply did NOT close
// the loop (e.g. a clarifying "which card?" on a donation that must still go
// through) and the follow-up should surface for a one-click decision rather
// than silently die. No thread key / no memory row → unknown → false, which
// keeps the legacy auto-dismiss for cases the classifier never saw.
// Key format must mirror threadKey() in ai-process: gmail:<threadId> for
// gmail/gmail_sent, <source_type>:<chatId> for whatsapp/sms.
async function matterStillPending(task: { id: string; user_id: string | null; source_message_id: string | null }): Promise<boolean> {
  if (!task.source_message_id || !task.user_id) return false;
  const { data: sent, error: sentError } = await supabase
    .from("source_messages")
    .select("source_type, metadata")
    .eq("id", task.source_message_id)
    .maybeSingle();
  if (sentError) console.error("matterStillPending source_messages read failed:", sentError);
  if (!sent) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (sent.metadata ?? {}) as any;
  let key: string | null = null;
  if (sent.source_type === "gmail" || sent.source_type === "gmail_sent") {
    key = meta.threadId ? `gmail:${meta.threadId}` : null;
  } else if (sent.source_type === "whatsapp" || sent.source_type === "sms") {
    key = meta.chatId ? `${sent.source_type}:${meta.chatId}` : null;
  }
  // gmail_sent rows often carry no threadId (see replyArrived's fallback for
  // the same gap). When there is no thread key, fall back to the memory row
  // that POINTS AT this task — same classifier-maintained state, keyed from
  // the other side.
  let query = supabase.from("thread_memory").select("state").eq("user_id", task.user_id);
  query = key ? query.eq("thread_key", key) : query.eq("related_task_id", task.id);
  const { data: memory, error: memoryError } = await query.limit(1).maybeSingle();
  if (memoryError) console.error("matterStillPending thread_memory read failed:", memoryError);
  if (!memory?.state) return false;
  return memory.state !== "resolved";
}

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
  // Simple daily/weekly/monthly recurrence. This legacy path can't route
  // through _shared/recurrence.ts's nextOccurrence(): that helper is
  // date-only (drops the reminder's time-of-day) and requires a well-formed
  // "FREQ=..." RRULE, while legacy reminder rules may be bare keywords.
  const date = new Date(currentRemindAt);
  if (rule.includes("DAILY")) {
    date.setDate(date.getDate() + 1);
  } else if (rule.includes("WEEKLY")) {
    date.setDate(date.getDate() + 7);
  } else if (rule.includes("MONTHLY")) {
    // Clamp the day-of-month like _shared/recurrence.ts does: a naive
    // setMonth(+1) overflows short months (Jan 31 → Mar 3) and the reminder
    // drifts off its anchor day forever. Advance from the 1st, then take
    // min(anchor day, days in target month) — Jan 31 → Feb 28/29.
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, daysInMonth));
  } else {
    // Default: 1 day
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString();
}
