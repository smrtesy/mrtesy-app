/**
 * Read-only API for the WhatsApp messages page (/[locale]/whatsapp).
 *
 * Three endpoints, all gated through the standard smrtTask auth chain:
 *   GET /whatsapp/threads             list of chats (one row per chat_id)
 *   GET /whatsapp/messages?chat_id=…  messages in a single chat (paginated)
 *   GET /whatsapp/media/:path         signed URL for a stored document
 *
 * Everything is scoped to the caller via the whatsapp_messages.user_id
 * column, which the service-role client respects manually (we always
 * pass `.eq("user_id", req.user!.id)`).
 */

import { Router, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { simpleCall } from "../../../anthropic";
import { transcribeAudio } from "../../../gemini";

const router = Router();
const gate = [requireAuth, requireOrg, requireApp("smrttask")];

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — long enough to open a PDF, short enough to bound exposure.

// ── Threads ───────────────────────────────────────────────────────────────
// Returns one row per chat_id with metadata about the latest message.
// We pull a fixed window of recent rows and aggregate in JS rather than
// inventing a SQL view — keeps the implementation in one place and stays
// portable across the Supabase version we're on.
router.get("/whatsapp/threads", ...gate, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "500"), 10) || 500, 2000);
  const { data, error } = await db
    .from("whatsapp_messages")
    .select(
      "chat_id, direction, body_text, media_ocr_text, audio_transcript, received_at, from_phone, from_name, message_type, is_history",
    )
    .eq("user_id", req.user!.id)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

  // Tasks created from any of these chats — surfaced as a small badge
  // on each thread row. We join tasks → source_messages and pivot on the
  // `wa:{chat_id}` source_id our pipeline writes.
  const { data: taskRows } = await db
    .from("tasks")
    .select("id, source_message_id, source_messages!inner(source_id, source_type, user_id)")
    .eq("source_messages.source_type", "whatsapp")
    .eq("source_messages.user_id", req.user!.id)
    .neq("status", "archived")
    .limit(2000);

  const tasksByChat = new Map<string, number>();
  for (const t of taskRows ?? []) {
    const sm = (t as unknown as { source_messages?: { source_id?: string } | { source_id?: string }[] }).source_messages;
    const sourceId = Array.isArray(sm) ? sm[0]?.source_id : sm?.source_id;
    if (!sourceId?.startsWith("wa:")) continue;
    // source_id is wa:<chatId> (legacy / self-chat context row) or
    // wa:<chatId>:<wamid> (per-burst rows). The chatId is the segment between
    // the "wa:" prefix and the next colon; take the whole tail when there is no
    // wamid suffix.
    const sepIdx = sourceId.indexOf(":", 3); // skip "wa:" prefix
    const chatId = sepIdx > 0 ? sourceId.slice(3, sepIdx) : sourceId.slice(3);
    tasksByChat.set(chatId, (tasksByChat.get(chatId) ?? 0) + 1);
  }

  // Per-chat state: last_read_at (unread badges) and custom_name (user-set
  // display name that overrides the WhatsApp profile name everywhere we
  // surface the contact — thread list, header, and the `sender` field on
  // source_messages, which is what the smrtTask classifier and
  // recommendations read).
  const { data: chatStates } = await db
    .from("whatsapp_chat_state")
    .select("chat_id, last_read_at, custom_name")
    .eq("user_id", req.user!.id);
  const lastReadByChat = new Map<string, string>();
  const customNameByChat = new Map<string, string>();
  for (const r of chatStates ?? []) {
    if (!r.chat_id) continue;
    if (r.last_read_at) lastReadByChat.set(r.chat_id as string, r.last_read_at as string);
    const cn = (r.custom_name as string | null)?.trim();
    if (cn) customNameByChat.set(r.chat_id as string, cn);
  }

  // Two passes over the recent-messages window:
  //   * `latestAny`     — newest message per chat, of any direction. Drives
  //                       the preview text + timestamp shown in the list.
  //   * `latestIncoming` — newest INCOMING message per chat. Drives the
  //                       contact identity (name + phone) shown as the
  //                       chat title. If we used `latestAny` for that,
  //                       a reply sent from this app would swap the
  //                       header to "אני / our own number" — exactly the
  //                       bug a user reported. The chat is always
  //                       conceptually "with the other party", regardless
  //                       of who sent last.
  // chat_id itself is the canonical contact identifier for 1:1 chats —
  // safe fallback when a chat has only outgoing messages (e.g. history
  // backfill of messages we sent before any reply).
  type Row = NonNullable<typeof data>[number];
  const latestAny = new Map<string, Row>();
  const latestIncoming = new Map<string, Row>();
  for (const row of data ?? []) {
    if (!latestAny.has(row.chat_id)) latestAny.set(row.chat_id, row);
    if (row.direction === "incoming" && !latestIncoming.has(row.chat_id)) {
      latestIncoming.set(row.chat_id, row);
    }
  }

  const threads = [...latestAny.entries()].map(([chatId, m]) => {
    const inc = latestIncoming.get(chatId);
    // Unread = count of incoming messages with received_at > last_read_at
    // for this chat. We compute against the window the SQL already
    // returned (DESC by received_at, limit 500) — enough for any
    // realistic unread count, and the badge cap at 99+ handles the rest.
    const lastReadAt = lastReadByChat.get(chatId);
    let unreadCount = 0;
    if (lastReadAt) {
      const lastReadMs = new Date(lastReadAt).getTime();
      for (const row of data ?? []) {
        if (row.chat_id !== chatId) continue;
        if (row.direction !== "incoming") continue;
        if (!row.received_at) continue;
        if (new Date(row.received_at).getTime() > lastReadMs) unreadCount++;
      }
    } else if (m.direction === "incoming") {
      // Never opened: treat every incoming as unread. Same window as above.
      for (const row of data ?? []) {
        if (row.chat_id !== chatId) continue;
        if (row.direction === "incoming") unreadCount++;
      }
    }

    return {
      chat_id: chatId,
      last_message_at: m.received_at,
      last_direction: m.direction,
      last_message_type: m.message_type,
      // Fall back to transcript/OCR so audio + caption-less images don't
      // show as empty preview lines in the chat list.
      last_body_text: m.body_text || m.audio_transcript || m.media_ocr_text || null,
      // Identity always comes from the contact side — never from "us".
      from_phone: inc?.from_phone ?? chatId,
      from_name: inc?.from_name ?? null,
      // User-defined override. UI prefers this; null = use from_name.
      custom_name: customNameByChat.get(chatId) ?? null,
      is_history: m.is_history,
      unread_count: unreadCount,
      task_count: tasksByChat.get(chatId) ?? 0,
    };
  });

  return res.json({ threads });
});

// ── Mark a chat as read ───────────────────────────────────────────────────
// Upserts whatsapp_chat_state.last_read_at to now. The next GET /threads
// uses it to compute unread_count.
router.post("/whatsapp/threads/:chat_id/read", ...gate, async (req: Request, res: Response) => {
  const { chat_id } = req.params;
  const nowIso = new Date().toISOString();
  const { error } = await db.from("whatsapp_chat_state").upsert(
    {
      user_id: req.user!.id,
      chat_id,
      last_read_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "user_id,chat_id" },
  );
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ── Set or clear the user-defined display name for a chat ────────────────
// Body: { custom_name: string | null }
//   • non-empty string → set the override (trimmed, capped at 120 chars)
//   • null / empty string → clear the override (fall back to from_name)
//
// We re-emit the thread row in source_messages with the new sender so any
// downstream consumer (smrtTask classifier, recommendation prompts) picks
// up the name immediately on the next pass instead of waiting for the
// next inbound message to refresh the row.
router.patch("/whatsapp/threads/:chat_id/name", ...gate, async (req: Request, res: Response) => {
  const { chat_id } = req.params;
  if (!chat_id) return res.status(400).json({ error: "chat_id is required" });

  const raw = (req.body ?? {}) as { custom_name?: string | null };
  const next = typeof raw.custom_name === "string"
    ? raw.custom_name.trim().slice(0, 120) || null
    : null;

  const nowIso = new Date().toISOString();
  // last_read_at is NOT NULL on whatsapp_chat_state. An upsert would
  // clobber the existing read marker → unread badge breakage. So we
  // UPDATE first, INSERT only when no row exists.
  const { data: existingRow, error: existErr } = await db
    .from("whatsapp_chat_state")
    .select("id")
    .eq("user_id", req.user!.id)
    .eq("chat_id", chat_id)
    .maybeSingle();
  if (existErr) return res.status(500).json({ error: existErr.message });

  if (existingRow) {
    const { error } = await db
      .from("whatsapp_chat_state")
      .update({ custom_name: next, updated_at: nowIso })
      .eq("id", existingRow.id);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    const { error } = await db.from("whatsapp_chat_state").insert({
      user_id: req.user!.id,
      chat_id,
      custom_name: next,
      last_read_at: nowIso,
      updated_at: nowIso,
    });
    if (error) return res.status(500).json({ error: error.message });
  }

  // If a thread-level source_messages row already exists for this chat,
  // refresh sender/subject/metadata.chatName so the classifier sees the
  // new name on the next reprocess. Runs in BOTH the set and clear paths:
  // when the user clears the rename, we need to revert sender to the
  // contact's WhatsApp profile name, otherwise the classifier keeps using
  // the stale override forever. Best-effort: a stale name is cosmetic,
  // not a correctness issue, so we log + continue on error.
  try {
    let display = next;
    if (!display) {
      // Fall back to from_name on the latest incoming message — same
      // priority order refreshSourceMessageThread() uses on a new
      // inbound webhook.
      const { data: fallbackRow } = await db
        .from("whatsapp_messages")
        .select("from_name, from_phone")
        .eq("user_id", req.user!.id)
        .eq("chat_id", chat_id)
        .eq("direction", "incoming")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      display =
        (fallbackRow?.from_name as string | null)?.trim() ||
        (fallbackRow?.from_phone as string | null) ||
        chat_id;
    }
    // A chat now fans out across many immutable burst rows
    // (wa:<chatId>:<wamid>), so update the display name on ALL of the chat's
    // source_messages — matched by metadata.chatId, format-independent. This
    // updates `sender`/`subject` (what the classifier actually reads); the
    // chatName written into future burst rows is resolved from
    // whatsapp_chat_state.custom_name by refreshSourceMessageThread(). A
    // per-row metadata JSON merge isn't expressible in one bulk update, so we
    // leave metadata.chatName on existing rows — cosmetic and self-heals on the
    // next burst. Best-effort: a stale name is cosmetic, not a correctness bug.
    const { error: updateErr } = await db
      .from("source_messages")
      .update({ sender: display, subject: display })
      .eq("user_id", req.user!.id)
      .eq("source_type", "whatsapp")
      .filter("metadata->>chatId", "eq", chat_id);
    if (updateErr) console.warn("[whatsapp] rename: source_messages update:", updateErr.message);
  } catch (e) {
    console.warn("[whatsapp] rename: source_messages refresh failed:", e);
  }

  return res.json({ ok: true, custom_name: next });
});

// ── Messages within a chat ────────────────────────────────────────────────
router.get("/whatsapp/messages", ...gate, async (req: Request, res: Response) => {
  const chatId = String(req.query.chat_id ?? "");
  if (!chatId) return res.status(400).json({ error: "chat_id is required" });

  const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1000);

  // We return chronological (oldest → newest) so the page renders like a
  // chat: most-recent at the bottom. Database query stays DESC so LIMIT
  // gives us the right *recent* window, then we reverse in JS.
  const { data, error } = await db
    .from("whatsapp_messages")
    .select(
      "id, wamid, chat_id, direction, from_phone, from_name, to_phone, message_type, body_text, media_ocr_text, audio_transcript, media_id, media_mime, media_url, media_filename, media_size, reply_to_wamid, reaction_emoji, is_reaction, is_history, history_phase, received_at, status, status_error, sent_at, delivered_at, read_at",
    )
    .eq("user_id", req.user!.id)
    .eq("chat_id", chatId)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

  // Tasks created from this chat. Two source-message shapes can produce
  // tasks for the SAME chat:
  //   1. WhatsApp burst rows: source_type='whatsapp', source_id='wa:<chatId>'
  //      (legacy single-row threads) or 'wa:<chatId>:<wamid>' (current
  //      immutable per-burst rows). We match these by metadata.chatId so the
  //      query is independent of the source_id format and covers both shapes.
  //   2. Per-message rows: source_type='whatsapp_echo',
  //      source_id='wa:<chatId>:<wamid>' — one row per outgoing voice memo
  //      in a self-chat thread. Each gets its own classification.
  // We need both. PostgREST doesn't let us OR across two columns through
  // an !inner join cleanly, so issue two queries and merge.
  const [legacyTasksRes, echoTasksRes] = await Promise.all([
    db
      .from("tasks")
      .select(
        "id, title, title_he, status, priority, manually_verified, created_at, due_date, source_messages!inner(id, source_id, source_type, user_id, metadata)",
      )
      .eq("source_messages.source_type", "whatsapp")
      .eq("source_messages.metadata->>chatId", chatId)
      .eq("source_messages.user_id", req.user!.id)
      .order("created_at", { ascending: true })
      .limit(500),
    db
      .from("tasks")
      .select(
        "id, title, title_he, status, priority, manually_verified, created_at, due_date, source_message_id, source_messages!inner(id, source_id, source_type, user_id)",
      )
      .eq("source_messages.source_type", "whatsapp_echo")
      .like("source_messages.source_id", `wa:${chatId}:%`)
      .eq("source_messages.user_id", req.user!.id)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);

  // Map echo source_message.id → wamid (parsed from source_id suffix) so
  // the frontend can pair each task with its exact originating whatsapp
  // message — no heuristic guesswork needed for the per-message path.
  const echoWamidByTaskId = new Map<string, string>();
  for (const t of echoTasksRes.data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sm = (t as any).source_messages;
    const row = (Array.isArray(sm) ? sm[0] : sm) as { source_id?: string } | null;
    const srcId = row?.source_id ?? "";
    const idx = srcId.indexOf(":", 3); // skip "wa:" prefix
    if (idx > 0) {
      const wamid = srcId.slice(idx + 1);
      if (wamid) echoWamidByTaskId.set(t.id as string, wamid);
    }
  }

  const tasks = [
    ...(legacyTasksRes.data ?? []),
    ...(echoTasksRes.data ?? []),
  ].map((t) => ({
    id: t.id,
    title: t.title,
    title_he: t.title_he,
    status: t.status,
    priority: t.priority,
    manually_verified: t.manually_verified,
    created_at: t.created_at,
    due_date: t.due_date,
    // Exact wamid the task came from (only for whatsapp_echo per-message
    // rows). When present, frontend prefers this over the time heuristic.
    source_wamid: echoWamidByTaskId.get(t.id as string) ?? null,
  }));

  return res.json({ messages: [...(data ?? [])].reverse(), tasks });
});

// ── Full-text-ish search across a chat's message content ──────────────────
// GET /whatsapp/search?q=<term>&limit=
// Returns the set of chat_ids whose message content (body_text, audio
// transcript, or image OCR) matches the term, each with the newest matching
// snippet. Names are matched client-side over the already-loaded thread list
// (which carries custom_name / from_name / phone); this endpoint covers the
// "search inside messages" half. Scoped to the caller via user_id.
router.get("/whatsapp/search", ...gate, async (req: Request, res: Response) => {
  const raw = String(req.query.q ?? "").trim();
  if (raw.length < 2) return res.json({ results: [] });

  const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1000);

  // Sanitize for PostgREST's or()/ilike syntax (same approach as smrtcrm's
  // contact search): ',' '(' ')' delimit or-branches, '*' is a wildcard, and
  // '%'/'_' are SQL LIKE metacharacters. Strip them all so user input can't
  // break the filter, inject branches, or smuggle in wildcards. '%' wraps the
  // term as the substring wildcard.
  const term = raw.replace(/[%_*(),\\]/g, " ").trim();
  if (!term) return res.json({ results: [] });
  const pattern = `%${term}%`;

  const { data, error } = await db
    .from("whatsapp_messages")
    .select("chat_id, body_text, audio_transcript, media_ocr_text, received_at")
    .eq("user_id", req.user!.id)
    .or(
      [
        `body_text.ilike.${pattern}`,
        `audio_transcript.ilike.${pattern}`,
        `media_ocr_text.ilike.${pattern}`,
      ].join(","),
    )
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

  // Newest matching snippet per chat (data is already DESC by received_at).
  const byChat = new Map<string, { chat_id: string; snippet: string; received_at: string }>();
  for (const row of data ?? []) {
    if (!row.chat_id || byChat.has(row.chat_id)) continue;
    const snippet =
      (row.body_text || row.audio_transcript || row.media_ocr_text || "").slice(0, 160);
    byChat.set(row.chat_id, {
      chat_id: row.chat_id,
      snippet,
      received_at: row.received_at as string,
    });
  }

  return res.json({ results: [...byChat.values()] });
});

// ── Signed URL for a stored document ──────────────────────────────────────
// The frontend never gets the storage path directly — it asks this endpoint
// for a fresh signed URL each time. Cheap (one Storage API call) and keeps
// us from leaking long-lived public links if we ever ship the bucket
// public-by-accident.
router.get("/whatsapp/media", ...gate, async (req: Request, res: Response) => {
  const path = String(req.query.path ?? "");
  if (!path) return res.status(400).json({ error: "path is required" });

  // Defense in depth: even though Storage's RLS would block reads, the
  // service-role client bypasses RLS, so we enforce ownership ourselves.
  // Path convention is "<user_id>/<wamid>-<filename>".
  if (!path.startsWith(`${req.user!.id}/`)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const { data, error } = await db.storage
    .from("whatsapp-media")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ url: data.signedUrl });
});

// ── Send a WhatsApp message via Meta Cloud API ───────────────────────────
//
// Meta only allows free-form text replies within a 24-hour window starting
// at the customer's most recent message. Outside that window, businesses
// must use pre-approved template messages — that's a separate flow we're
// not building yet, so we reject sends outside the window with a clear
// error the UI can surface.
//
// Body: { to_phone: string, text: string, reply_to_wamid?: string }
// Returns: { ok: true, wamid: string }
const META_API_VERSION = process.env.META_API_VERSION ?? "v21.0";
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

// Outgoing image constraints. Meta's Cloud API documents JPEG and PNG as the
// supported still-image formats; anything else is rejected at the API anyway,
// so we fail fast with a clear message. 5 MB is Meta's hard cap for images.
const SEND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SEND_IMAGE_ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);

/**
 * Refresh (or create) the per-burst source_messages row for an outgoing
 * WhatsApp message so the smrtTask classifier / dashboards see it on the next
 * pass. Reads the last 20 messages straight from whatsapp_messages, so the
 * caller must have inserted the new outgoing row BEFORE calling this. Keyed by
 * `wa:<chatId>:<wamid>` (one immutable row per burst, mirrors the webhook's
 * refreshSourceMessageThread). Best-effort: never throws — a stale thread row
 * is cosmetic, and the webhook echo refreshes it later.
 */
async function refreshThreadSourceMessageRow(
  userId: string,
  chatId: string,
  wamid: string,
  nowIso: string,
): Promise<void> {
  try {
    const { data: lastMsgs } = await db
      .from("whatsapp_messages")
      .select("direction, body_text, received_at, from_phone, from_name")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .order("received_at", { ascending: false })
      .limit(20);

    if (!lastMsgs || lastMsgs.length === 0) return;

    const ordered = [...lastMsgs].reverse();
    const last = ordered[ordered.length - 1];
    const latestIncoming = [...ordered].reverse().find((m) => m.direction === "incoming");
    // User-defined name overrides everything else if set.
    const { data: stateRow } = await db
      .from("whatsapp_chat_state")
      .select("custom_name")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .maybeSingle();
    const customName = (stateRow?.custom_name as string | null)?.trim() || null;
    const chatName =
      customName ||
      (latestIncoming?.from_name as string | null) ||
      (last.from_name as string | null) ||
      (last.from_phone as string | null) ||
      chatId;
    const fromPhone =
      (latestIncoming?.from_phone as string | null) ||
      (last.from_phone as string | null) ||
      chatId;
    const conversationLines = ordered
      .map((mm) => {
        const ts = String(mm.received_at ?? "").slice(0, 16);
        const dir = String(mm.direction ?? "incoming").toUpperCase();
        const t = String(mm.body_text ?? "").replace(/\s+/g, " ").trim();
        return `[${dir} ${ts}] ${t}`;
      })
      .join("\n");
    const rawContent = [
      `Chat: ${chatName}`,
      `Phone: ${fromPhone}`,
      `Group: false`,
      `\n--- CONVERSATION (last 20 messages) ---`,
      conversationLines,
    ].join("\n");

    // One IMMUTABLE source_message per burst, keyed by the sent message's
    // wamid (wa:<chatId>:<wamid>). The message we just sent is OUTGOING,
    // stamped as lastDirection so the pipeline defers it as a follow-up.
    // ignoreDuplicates so the webhook echo of the same wamid is a no-op.
    const burstSourceId = `wa:${chatId}:${wamid}`;
    await db.from("source_messages").upsert(
      {
        user_id: userId,
        source_type: "whatsapp",
        source_id: burstSourceId,
        sender: chatName,
        subject: chatName,
        body_text: (last.body_text as string | null)?.trim().slice(0, 1000) ?? "",
        raw_content: rawContent.slice(0, 3000),
        received_at: nowIso,
        source_url: `https://wa.me/${String(fromPhone).replace(/\D/g, "")}`,
        reply_to_context: fromPhone,
        processing_status: "pending",
        metadata: { chatId, chatName, fromPhone, isGroup: false, lastDirection: "outgoing", lastWamid: wamid },
      },
      { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true },
    );
    // Supersede any earlier still-pending, unlocked burst row for this chat so
    // only the newest burst reaches the classifier (coalescing).
    await db
      .from("source_messages")
      .update({ processing_status: "processed", ai_classification: "superseded", processed_at: nowIso })
      .eq("user_id", userId)
      .eq("source_type", "whatsapp")
      .eq("processing_status", "pending")
      .is("processing_lock_at", null)
      .filter("metadata->>chatId", "eq", chatId)
      .lte("received_at", nowIso)
      .neq("source_id", burstSourceId);
  } catch (e) {
    console.warn("[whatsapp-send] source_messages refresh failed:", e);
  }
}

router.post("/whatsapp/messages/send", ...gate, async (req: Request, res: Response) => {
  const { to_phone, text, reply_to_wamid } = (req.body ?? {}) as {
    to_phone?: string;
    text?: string;
    reply_to_wamid?: string;
  };

  if (!to_phone || typeof to_phone !== "string") {
    return res.status(400).json({ error: "to_phone is required" });
  }
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  // Find the caller's active WhatsApp connection (the WABA we'll send from).
  // For single-tenant there's only one row; for multi-tenant we'll pick the
  // one matching this user.
  const { data: conn, error: connErr } = await db
    .from("whatsapp_connections")
    .select("phone_number_id, access_token_secret_id")
    .eq("user_id", req.user!.id)
    .is("disconnected_at", null)
    .maybeSingle();
  if (connErr) return res.status(500).json({ error: connErr.message });
  if (!conn) return res.status(404).json({ error: "no_whatsapp_connection" });

  // Decrypt the access token from Vault.
  const secretId = conn.access_token_secret_id as string | null;
  if (!secretId) {
    return res.status(400).json({ error: "access_token_not_configured" });
  }
  const { data: tokenPlain, error: tokenErr } = await db.rpc("vault_read_secret", {
    secret_id: secretId,
  });
  if (tokenErr) return res.status(500).json({ error: `vault: ${tokenErr.message}` });
  const accessToken = typeof tokenPlain === "string" ? tokenPlain : null;
  if (!accessToken) return res.status(500).json({ error: "access_token_unreadable" });

  // 24h-window check: latest incoming message FROM this chat partner must
  // be within the last 24h. We use chat_id (= the other party's phone for
  // 1:1 conversations) since to_phone might be normalized differently.
  // chat_id stays exactly as Meta delivered it on incoming events.
  const chatId = to_phone.replace(/\D/g, ""); // canonical digits-only
  const { data: lastIncoming } = await db
    .from("whatsapp_messages")
    .select("received_at")
    .eq("user_id", req.user!.id)
    .eq("chat_id", chatId)
    .eq("direction", "incoming")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastIncomingAt = lastIncoming?.received_at
    ? new Date(lastIncoming.received_at).getTime()
    : null;
  const withinWindow =
    lastIncomingAt !== null && Date.now() - lastIncomingAt < SEND_WINDOW_MS;
  if (!withinWindow) {
    return res.status(403).json({
      error: "outside_24h_window",
      last_incoming_at: lastIncoming?.received_at ?? null,
    });
  }

  // Build the Meta payload. Cloud API expects the recipient as a plain
  // digits string (no '+').
  const recipient = chatId;
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: { body: text.trim(), preview_url: true },
  };
  if (reply_to_wamid) {
    payload.context = { message_id: reply_to_wamid };
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${conn.phone_number_id}/messages`;
  const sendRes = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const sendJson = (await sendRes.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number };
  };

  if (!sendRes.ok) {
    const msg = sendJson.error?.message ?? `meta_${sendRes.status}`;
    return res.status(502).json({ error: msg });
  }

  const wamid = sendJson.messages?.[0]?.id ?? null;
  if (!wamid) return res.status(502).json({ error: "meta_no_wamid" });

  // Optimistically insert the outgoing message so the UI sees it immediately.
  // When Meta's echo arrives via the webhook, the upsert on (user_id, wamid)
  // is a no-op.
  const nowIso = new Date().toISOString();
  await db.from("whatsapp_messages").upsert(
    {
      user_id: req.user!.id,
      wamid,
      chat_id: chatId,
      direction: "outgoing",
      from_phone: conn.phone_number_id,
      from_name: "אני (מהמערכת)",
      to_phone: recipient,
      message_type: "text",
      body_text: text.trim(),
      reply_to_wamid: reply_to_wamid ?? null,
      is_reaction: false,
      is_history: false,
      received_at: nowIso,
      raw_payload: { sent_via: "smrttask", api_payload: payload },
    },
    { onConflict: "user_id,wamid" },
  );

  // Respond immediately — the client renders the message optimistically and
  // only needs the wamid. The source_messages thread refresh (several DB
  // queries, for Part 3 / dashboards) runs fire-and-forget so it never adds
  // latency to the send round-trip. It's self-contained + best-effort.
  res.json({ ok: true, wamid });
  void refreshThreadSourceMessageRow(req.user!.id, chatId, wamid, nowIso);
  return;
});

// ── Send an image via Meta Cloud API ─────────────────────────────────────
//
// Two-step Meta flow: (1) upload the bytes to /{phone_number_id}/media to get
// a media id, (2) send a type=image message referencing that id. We also
// persist the bytes to our own whatsapp-media bucket and insert an outgoing
// whatsapp_messages row so the image renders inline immediately (the same way
// incoming images do), without waiting for Meta's echo webhook.
//
// Body: { to_phone: string, image_base64: string, mime_type: string,
//         caption?: string, filename?: string }
// Returns: { ok: true, wamid: string }
router.post("/whatsapp/messages/send-image", ...gate, async (req: Request, res: Response) => {
  const { to_phone, image_base64, mime_type, caption, filename } = (req.body ?? {}) as {
    to_phone?: string;
    image_base64?: string;
    mime_type?: string;
    caption?: string;
    filename?: string;
  };

  if (!to_phone || typeof to_phone !== "string") {
    return res.status(400).json({ error: "to_phone is required" });
  }
  if (!image_base64 || typeof image_base64 !== "string") {
    return res.status(400).json({ error: "image_base64 is required" });
  }
  const mime = (mime_type ?? "").toLowerCase().split(";")[0].trim();
  if (!SEND_IMAGE_ALLOWED_MIME.has(mime)) {
    return res.status(400).json({ error: "unsupported_image_type" });
  }

  // Strip a data: URL prefix if the client sent one, then decode.
  const cleaned = image_base64.replace(/^data:[^;]+;base64,/, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(cleaned, "base64");
  } catch {
    return res.status(400).json({ error: "invalid_base64" });
  }
  if (buf.length === 0) return res.status(400).json({ error: "empty_image" });
  if (buf.length > SEND_IMAGE_MAX_BYTES) {
    return res.status(400).json({ error: "image_too_large" });
  }

  const captionText = typeof caption === "string" ? caption.trim() : "";

  // Resolve the caller's active connection + access token (same as text send).
  const { data: conn, error: connErr } = await db
    .from("whatsapp_connections")
    .select("phone_number_id, access_token_secret_id")
    .eq("user_id", req.user!.id)
    .is("disconnected_at", null)
    .maybeSingle();
  if (connErr) return res.status(500).json({ error: connErr.message });
  if (!conn) return res.status(404).json({ error: "no_whatsapp_connection" });

  const secretId = conn.access_token_secret_id as string | null;
  if (!secretId) return res.status(400).json({ error: "access_token_not_configured" });

  const { data: tokenPlain, error: tokenErr } = await db.rpc("vault_read_secret", {
    secret_id: secretId,
  });
  if (tokenErr) return res.status(500).json({ error: `vault: ${tokenErr.message}` });
  const accessToken = typeof tokenPlain === "string" ? tokenPlain : null;
  if (!accessToken) return res.status(500).json({ error: "access_token_unreadable" });

  // 24h window — identical rule to the text send path.
  const chatId = to_phone.replace(/\D/g, "");
  const { data: lastIncoming } = await db
    .from("whatsapp_messages")
    .select("received_at")
    .eq("user_id", req.user!.id)
    .eq("chat_id", chatId)
    .eq("direction", "incoming")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastIncomingAt = lastIncoming?.received_at
    ? new Date(lastIncoming.received_at).getTime()
    : null;
  if (lastIncomingAt === null || Date.now() - lastIncomingAt >= SEND_WINDOW_MS) {
    return res.status(403).json({
      error: "outside_24h_window",
      last_incoming_at: lastIncoming?.received_at ?? null,
    });
  }

  // Step 1 — upload the bytes to Meta to obtain a media id.
  const ext = mime === "image/png" ? "png" : "jpg";
  const safeName =
    (filename && /\.[A-Za-z0-9]{1,8}$/.test(filename) ? filename : `image.${ext}`).slice(0, 80);
  let mediaId: string;
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([buf], { type: mime }), safeName);
    const uploadRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${conn.phone_number_id}/media`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form },
    );
    const uploadJson = (await uploadRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!uploadRes.ok || !uploadJson.id) {
      return res
        .status(502)
        .json({ error: uploadJson.error?.message ?? `meta_upload_${uploadRes.status}` });
    }
    mediaId = uploadJson.id;
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }

  // Step 2 — send the image message referencing the uploaded media id.
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: chatId,
    type: "image",
    image: { id: mediaId, ...(captionText ? { caption: captionText } : {}) },
  };
  const sendRes = await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${conn.phone_number_id}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const sendJson = (await sendRes.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  };
  if (!sendRes.ok) {
    return res.status(502).json({ error: sendJson.error?.message ?? `meta_${sendRes.status}` });
  }
  const wamid = sendJson.messages?.[0]?.id ?? null;
  if (!wamid) return res.status(502).json({ error: "meta_no_wamid" });

  // Persist the bytes to our bucket so the bubble renders inline (mirrors the
  // webhook's storage convention: "<user_id>/<wamid>.<ext>"). Best-effort —
  // a storage failure shouldn't fail an already-sent message; the body_text
  // caption still shows and the row is recorded.
  const safeBase = wamid.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  const storagePath = `${req.user!.id}/${safeBase}.${ext}`;
  let mediaUrl: string | null = null;
  const { error: uploadErr } = await db.storage
    .from("whatsapp-media")
    .upload(storagePath, buf, { contentType: mime, upsert: true });
  if (uploadErr) {
    console.warn("[whatsapp-send-image] storage upload failed:", uploadErr.message);
  } else {
    mediaUrl = storagePath;
  }

  // Optimistically insert the outgoing image so the UI sees it immediately.
  // The webhook echo upserts on (user_id, wamid) → no-op.
  const nowIso = new Date().toISOString();
  await db.from("whatsapp_messages").upsert(
    {
      user_id: req.user!.id,
      wamid,
      chat_id: chatId,
      direction: "outgoing",
      from_phone: conn.phone_number_id,
      from_name: "אני (מהמערכת)",
      to_phone: chatId,
      message_type: "image",
      body_text: captionText || null,
      media_id: mediaId,
      media_mime: mime,
      media_url: mediaUrl,
      media_filename: safeName,
      media_size: buf.length,
      is_reaction: false,
      is_history: false,
      received_at: nowIso,
      raw_payload: { sent_via: "smrttask", api_payload: payload },
    },
    { onConflict: "user_id,wamid" },
  );

  // Respond immediately; refresh the thread row in the background (see the
  // text-send route for the same rationale).
  res.json({ ok: true, wamid });
  void refreshThreadSourceMessageRow(req.user!.id, chatId, wamid, nowIso);
  return;
});

// ── Send a reaction (emoji) on an existing message ──────────────────────
//
// Meta Cloud API: POST /v{ver}/{phone_number_id}/messages with
//   type: "reaction", reaction: { message_id, emoji }
//
// Same 24h-window rule applies as for free-form text. Sending an emoji
// replaces any prior reaction we set on that message (WhatsApp UX).
// Passing emoji = "" REMOVES our reaction.
//
// Body: { target_wamid: string, emoji: string }
// Returns: { ok: true, wamid: string }
router.post("/whatsapp/messages/react", ...gate, async (req: Request, res: Response) => {
  const { target_wamid, emoji } = (req.body ?? {}) as {
    target_wamid?: string;
    emoji?: string;
  };

  if (!target_wamid || typeof target_wamid !== "string") {
    return res.status(400).json({ error: "target_wamid is required" });
  }
  if (typeof emoji !== "string") {
    return res.status(400).json({ error: "emoji is required (empty string = remove reaction)" });
  }

  // Find the original message so we know which chat and recipient to send to.
  const { data: original, error: origErr } = await db
    .from("whatsapp_messages")
    .select("chat_id, from_phone, to_phone, direction")
    .eq("user_id", req.user!.id)
    .eq("wamid", target_wamid)
    .maybeSingle();
  if (origErr) return res.status(500).json({ error: origErr.message });
  if (!original) return res.status(404).json({ error: "original message not found" });

  const chatId = original.chat_id as string;
  // Recipient = the OTHER side of the conversation. For an incoming
  // message that's the original sender; for one we sent ourselves that's
  // who we sent it to.
  const recipient =
    original.direction === "incoming"
      ? (original.from_phone as string)
      : (original.to_phone as string) || chatId;

  // Resolve the user's connection + access token.
  const { data: conn } = await db
    .from("whatsapp_connections")
    .select("phone_number_id, access_token_secret_id")
    .eq("user_id", req.user!.id)
    .is("disconnected_at", null)
    .maybeSingle();
  if (!conn) return res.status(404).json({ error: "no_whatsapp_connection" });

  const secretId = conn.access_token_secret_id as string | null;
  if (!secretId) return res.status(400).json({ error: "access_token_not_configured" });

  const { data: tokenPlain, error: tokenErr } = await db.rpc("vault_read_secret", {
    secret_id: secretId,
  });
  if (tokenErr) return res.status(500).json({ error: `vault: ${tokenErr.message}` });
  const accessToken = typeof tokenPlain === "string" ? tokenPlain : null;
  if (!accessToken) return res.status(500).json({ error: "access_token_unreadable" });

  // 24h window — same rule as text sends.
  const { data: lastIncoming } = await db
    .from("whatsapp_messages")
    .select("received_at")
    .eq("user_id", req.user!.id)
    .eq("chat_id", chatId)
    .eq("direction", "incoming")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastIncomingAt = lastIncoming?.received_at
    ? new Date(lastIncoming.received_at).getTime()
    : null;
  if (lastIncomingAt === null || Date.now() - lastIncomingAt >= 24 * 60 * 60 * 1000) {
    return res.status(403).json({ error: "outside_24h_window" });
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient.replace(/\D/g, ""),
    type: "reaction",
    reaction: {
      message_id: target_wamid,
      emoji, // empty string removes the reaction (Meta convention)
    },
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${conn.phone_number_id}/messages`;
  const sendRes = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const sendJson = (await sendRes.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  };
  if (!sendRes.ok) {
    return res.status(502).json({ error: sendJson.error?.message ?? `meta_${sendRes.status}` });
  }

  const wamid = sendJson.messages?.[0]?.id ?? null;
  if (!wamid) return res.status(502).json({ error: "meta_no_wamid" });

  // Optimistically reflect the new reaction in the local store. We REPLACE
  // any earlier outgoing reaction on this target (WhatsApp behavior: one
  // reaction per user per message). Empty emoji = removal.
  const nowIso = new Date().toISOString();

  // Soft-delete prior outgoing reactions on the same target so the UI
  // doesn't render them alongside the new one. We can do this by setting
  // their reaction_emoji to "" — the ThreadView filters empties out.
  await db
    .from("whatsapp_messages")
    .update({ reaction_emoji: "" })
    .eq("user_id", req.user!.id)
    .eq("direction", "outgoing")
    .eq("is_reaction", true)
    .eq("reply_to_wamid", target_wamid)
    .neq("wamid", wamid);

  if (emoji.trim()) {
    await db.from("whatsapp_messages").upsert(
      {
        user_id: req.user!.id,
        wamid,
        chat_id: chatId,
        direction: "outgoing",
        from_phone: conn.phone_number_id,
        from_name: "אני (מהמערכת)",
        to_phone: recipient,
        message_type: "reaction",
        body_text: emoji,
        reaction_emoji: emoji,
        reply_to_wamid: target_wamid,
        is_reaction: true,
        is_history: false,
        received_at: nowIso,
        raw_payload: { sent_via: "smrttask", api_payload: payload },
      },
      { onConflict: "user_id,wamid" },
    );
  }

  return res.json({ ok: true, wamid });
});

// ── Voice transcription for the compose box ──────────────────────────────
//
// Body: { audio_base64: string, mime_type: string }
// Returns: { text: string }
//
// Uses the same Gemini Hebrew-aware transcription prompt our webhook uses
// for incoming WhatsApp voice notes. The frontend records via the
// browser's MediaRecorder API and posts the resulting blob here. The
// transcript lands in the compose textarea so the user can review/edit
// before sending.
router.post("/whatsapp/compose/transcribe", ...gate, async (req: Request, res: Response) => {
  const { audio_base64, mime_type } = (req.body ?? {}) as {
    audio_base64?: string;
    mime_type?: string;
  };
  if (!audio_base64 || typeof audio_base64 !== "string") {
    return res.status(400).json({ error: "audio_base64 is required" });
  }
  const cleaned = audio_base64.replace(/^data:[^;]+;base64,/, "");
  try {
    const text = await transcribeAudio(cleaned, mime_type || "audio/webm");
    return res.json({ text });
  } catch (e) {
    return res
      .status(502)
      .json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── English quality check (Claude Haiku) ─────────────────────────────────
//
// Body: { text: string }
// Returns: { suggestion: string, changed: boolean, cost_usd: number }
//
// Cheap copy-edit pass on outgoing English text. Catches grammar, missing
// articles, awkward phrasing — the kind of polish the operator wants
// before a one-off note. Haiku is the cheapest Claude model in the
// codebase and well-suited to a non-creative rewrite.
router.post("/whatsapp/compose/check-english", ...gate, async (req: Request, res: Response) => {
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const trimmed = text.trim();
  if (trimmed.length > 4000) {
    return res.status(400).json({ error: "text too long (max 4000 chars)" });
  }

  const systemPrompt =
    "You are a copy-editor for short business WhatsApp messages. " +
    "Given a draft, return a polished English version: fix grammar, punctuation, " +
    "missing articles, awkward phrasing. Preserve the original meaning, tone, " +
    "and length. Do NOT add greetings the original doesn't have. Do NOT add " +
    "explanations. Return ONLY the polished message — no quotes, no markdown, " +
    "no commentary. If the original is already correct, return it unchanged.";

  try {
    const { content, costUsd } = await simpleCall("haiku", systemPrompt, trimmed, 1024);
    const suggestion = content.trim();
    return res.json({
      suggestion,
      changed: suggestion !== trimmed,
      cost_usd: costUsd,
    });
  } catch (e) {
    return res
      .status(502)
      .json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
