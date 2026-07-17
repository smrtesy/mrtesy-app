/**
 * POST /events — create a Google Calendar event from a task/suggestion, and
 * turn that task into an in-app event reminder.
 *
 * Body: {
 *   task_id:          string,   // the task/suggestion to convert
 *   title:            string,   // event title (Hebrew)
 *   due_date:         string,   // "YYYY-MM-DD"
 *   due_time:         string,   // "HH:MM" (24h, Asia/Jerusalem wall-clock)
 *   description?:     string,   // event body — keep source deep-links verbatim
 *   duration_minutes?:number,   // defaults to 60
 *   snoozed_until?:   string,   // ISO — when to resurface as a reminder
 *                               //   (one working day before; frontend-computed).
 *                               //   Omit to surface the reminder immediately.
 * }
 * Returns: { task, event: { id, htmlLink } }
 *
 * The event is written to the connected Google Calendar and its Google id is
 * stored in tasks.calendar_event_id; when the calendar sync re-ingests that
 * event, ai-process (calendarForceActionable) matches the id and skips building
 * a duplicate "meeting" task. The event is also tagged with extendedProperties
 * (smrtesy_task_id/origin) as a durable provenance marker.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireFullTask } from "../lib/access";
import { createCalendarEvent, listEvents } from "../../../services/calendar";
import { simpleCall, parseJsonResponse } from "../../../anthropic";

const router = Router();

router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

const EVENT_TZ = "Asia/Jerusalem";
const pad = (n: number) => String(n).padStart(2, "0");

interface ExtractedEvent {
  title: string;
  date: string | null;
  time: string | null;
  description: string;
}

/**
 * POST /events/extract — best-effort AI extraction of event fields from a task
 * and its source, to pre-fill the "add event" dialog. Always resolves (falls
 * back to the task's own fields) so the dialog never blocks on the model.
 */
router.post("/events/extract", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { task_id } = (req.body ?? {}) as Record<string, unknown>;
  if (!task_id) return res.status(400).json({ error: "task_id required" });

  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("id, title, title_he, description, due_date, due_time, source_link, source_message_id, related_contact, action_links")
    .eq("id", task_id)
    .eq("user_id", userId)
    .single();
  if (taskErr || !task) return res.status(404).json({ error: "Task not found" });

  // Deep links (Zoom/Teams/Meet join, etc.) now live in action_links, not the
  // description — carry them into the calendar event so the join link survives
  // the "add to calendar" prefill even on the model-failure fallback path.
  const actionLinkLines: string[] = Array.isArray(task.action_links)
    ? (task.action_links as Array<{ label?: string; url?: string }>)
        .filter((a) => a && typeof a.url === "string")
        .map((a) => (a.label ? `${a.label}: ${a.url}` : String(a.url)))
    : [];

  let source: { subject: string | null; body_text: string | null } | null = null;
  if (task.source_message_id) {
    const { data } = await db
      .from("source_messages")
      .select("subject, body_text")
      .eq("id", task.source_message_id)
      .eq("user_id", userId)
      .maybeSingle();
    source = data ?? null;
  }

  const fallback: ExtractedEvent = {
    title: task.title_he || task.title || "אירוע",
    date: task.due_date ?? null,
    time: task.due_time ? String(task.due_time).slice(0, 5) : null,
    description: [task.description, ...actionLinkLines, task.source_link].filter(Boolean).join("\n"),
  };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const system = `You extract calendar-event details from a task and its source. Output STRICT JSON only, no prose:
{"title":"<concise Hebrew event title — what it IS, e.g. 'פגישה עם דני'; NOT 'לקבוע פגישה'>","date":"YYYY-MM-DD or null","time":"HH:MM (24h) or null","description":"<Hebrew, 1-3 lines of context. CRITICAL: include any source URL / deep-link (Gmail, WhatsApp, Drive, Calendar, http...) EXACTLY as it appears — never shorten it to a domain.>"}
Today is ${today}. Resolve relative dates ("מחר", "יום שלישי הקרוב") to an absolute date; use null when unknown.`;
    const userMsg = [
      `Title: ${task.title_he || task.title || ""}`,
      `Description: ${task.description ?? ""}`,
      task.related_contact ? `Contact: ${task.related_contact}` : "",
      actionLinkLines.length ? `Action links (keep any URL verbatim):\n${actionLinkLines.join("\n")}` : "",
      task.source_link ? `Source link: ${task.source_link}` : "",
      source?.subject ? `Source subject: ${source.subject}` : "",
      source?.body_text ? `Source body:\n${String(source.body_text).slice(0, 1500)}` : "",
    ].filter(Boolean).join("\n");

    const { content } = await simpleCall("sonnet", system, userMsg, 500);
    const parsed = parseJsonResponse<ExtractedEvent>(content);
    if (!parsed || !parsed.title) return res.json(fallback);
    return res.json({
      title: parsed.title || fallback.title,
      date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? "") ? parsed.date : fallback.date,
      time: /^\d{2}:\d{2}$/.test(parsed.time ?? "") ? parsed.time : fallback.time,
      description: parsed.description || fallback.description,
    });
  } catch {
    return res.json(fallback);
  }
});

router.post("/events", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { task_id, title, due_date, due_time, description, duration_minutes, snoozed_until } =
    (req.body ?? {}) as Record<string, unknown>;

  if (!task_id || !title || !due_date || !due_time) {
    return res.status(400).json({ error: "task_id, title, due_date and due_time are required" });
  }
  if (typeof due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due_date)
      || typeof due_time !== "string" || !/^\d{2}:\d{2}$/.test(due_time)) {
    return res.status(400).json({ error: "due_date must be YYYY-MM-DD and due_time HH:MM" });
  }

  // Load the task (owner-scoped, same boundary as /actions/execute).
  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("id")
    .eq("id", task_id)
    .eq("user_id", userId)
    .single();
  if (taskErr || !task) return res.status(404).json({ error: "Task not found" });

  // Build the event window as Israel wall-clock strings. Google interprets them
  // in EVENT_TZ (via the timeZone field), so we do the +duration arithmetic on a
  // UTC scratch date to stay independent of the server's own timezone.
  const durMin = Number.isFinite(Number(duration_minutes)) && Number(duration_minutes) > 0
    ? Number(duration_minutes)
    : 60;
  const [y, mo, d] = due_date.split("-").map((n) => parseInt(n, 10));
  const [h, mi] = due_time.split(":").map((n) => parseInt(n, 10));
  const scratch = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const end = new Date(scratch.getTime() + durMin * 60_000);
  const startLocal = `${due_date}T${pad(h)}:${pad(mi)}:00`;
  const endLocal = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}T${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:00`;

  // Write the event to Google Calendar. Its id is stored below in
  // calendar_event_id, which is what stops the sync from re-ingesting it as a
  // duplicate task; the extendedProperties tag is a redundant provenance marker.
  let event;
  try {
    event = await createCalendarEvent(
      userId,
      title as string,
      startLocal,
      endLocal,
      typeof description === "string" && description ? description : undefined,
      {
        timeZone: EVENT_TZ,
        extendedProperties: { private: { smrtesy_task_id: String(task_id), smrtesy_origin: "smrttask" } },
      },
    );
  } catch (e) {
    return res.status(502).json({ error: `לא ניתן ליצור אירוע ב-Google Calendar: ${(e as Error).message}` });
  }

  // Convert the task into the in-app event reminder. It hides until the reminder
  // moment (one working day before) and resurfaces as a "תזכורת" suggestion —
  // exactly like a calendar-ingested meeting.
  const willSnooze = typeof snoozed_until === "string" && snoozed_until.length > 0;
  const { data: updated, error: updErr } = await db
    .from("tasks")
    .update({
      title: title as string,
      title_he: title as string,
      description: typeof description === "string" ? description : null,
      due_date,
      due_time,
      task_type: "meeting",
      calendar_event_id: event.id ?? null,
      manually_verified: false,
      status: willSnooze ? "snoozed" : "inbox",
      snoozed_until: willSnooze ? (snoozed_until as string) : null,
    })
    .eq("id", task_id)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (updErr) {
    // The Google event was created but the task update failed — surface it so
    // the client can retry rather than silently losing the link.
    return res.status(500).json({
      error: `האירוע נוצר ביומן אך עדכון המשימה נכשל: ${updErr.message}`,
      event: { id: event.id, htmlLink: event.htmlLink },
    });
  }

  return res.json({ task: updated, event: { id: event.id, htmlLink: event.htmlLink } });
});

interface AgendaEvent {
  id: string;
  title: string;
  start: string;              // ISO datetime, or "YYYY-MM-DD" for all-day
  end: string | null;
  allDay: boolean;
  location: string | null;
  htmlLink: string | null;
  source: "google" | "app";
  taskId: string | null;
}

/**
 * GET /events?days=7 — the coming-week agenda. Merges the live Google Calendar
 * (the real events, most of which only become tasks a day before) with in-app
 * events created from the chip (which never round-trip to Google), so the panel
 * shows the whole week regardless of where an event lives. Deduped by not
 * re-listing app events that were pushed to Google (calendar_event_id set) or
 * ingested FROM Google (ai_model_used = "calendar").
 */
router.get("/events", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const daysRaw = parseInt(String(req.query.days ?? "7"), 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 31) : 7;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + days * 86_400_000);

  const items: AgendaEvent[] = [];

  // 1. Live Google Calendar (primary) — the real agenda for the window.
  try {
    const gEvents = await listEvents(userId, now.toISOString(), windowEnd.toISOString(), 50, "primary");
    for (const ev of gEvents) {
      if (ev.status === "cancelled") continue;
      const start = ev.start?.dateTime ?? ev.start?.date ?? null;
      if (!start) continue;
      items.push({
        id: `g:${ev.id}`,
        title: ev.summary ?? "(ללא כותרת)",
        start,
        end: ev.end?.dateTime ?? ev.end?.date ?? null,
        allDay: !ev.start?.dateTime,
        location: ev.location ?? null,
        htmlLink: ev.htmlLink ?? null,
        source: "google",
        taskId: null,
      });
    }
  } catch {
    // Calendar not connected or token issue — still return in-app events below.
  }

  // 2. In-app-only events (chip-created reminders not pushed to / from Google).
  const todayStr = now.toISOString().slice(0, 10);
  const maxStr = windowEnd.toISOString().slice(0, 10);
  const { data: appTasks, error: appErr } = await db
    .from("tasks")
    .select("id, title, title_he, due_date, due_time, ai_model_used")
    .eq("user_id", userId)
    .eq("task_type", "meeting")
    .is("calendar_event_id", null)
    .not("due_date", "is", null)
    .gte("due_date", todayStr)
    .lte("due_date", maxStr)
    .not("status", "in", "(completed,archived,dismissed)");
  if (appErr) console.error("agenda app-events query failed:", appErr);
  for (const tk of appTasks ?? []) {
    // Meetings ingested FROM Google are already in the Google list above.
    if (tk.ai_model_used === "calendar") continue;
    const timeShort = tk.due_time ? String(tk.due_time).slice(0, 5) : null;
    items.push({
      id: `t:${tk.id}`,
      title: tk.title_he || tk.title || "אירוע",
      start: timeShort ? `${tk.due_date}T${timeShort}:00` : (tk.due_date as string),
      end: null,
      allDay: !timeShort,
      location: null,
      htmlLink: null,
      source: "app",
      taskId: tk.id,
    });
  }

  items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return res.json({ events: items, count: items.length });
});

export default router;
