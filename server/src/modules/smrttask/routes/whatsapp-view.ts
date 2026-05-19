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
      "chat_id, direction, body_text, received_at, from_phone, from_name, message_type, is_history",
    )
    .eq("user_id", req.user!.id)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

  // Group by chat_id, keep only the newest message per chat (data is
  // already DESC by received_at).
  const seen = new Map<string, NonNullable<typeof data>[number]>();
  for (const row of data ?? []) {
    if (!seen.has(row.chat_id)) seen.set(row.chat_id, row);
  }

  // Tack on a count of unread/history messages per chat — useful badges
  // for the UI later. Skip for now; we can add via a second query if needed.

  const threads = [...seen.entries()].map(([chatId, m]) => ({
    chat_id: chatId,
    last_message_at: m.received_at,
    last_direction: m.direction,
    last_message_type: m.message_type,
    last_body_text: m.body_text,
    from_phone: m.from_phone,
    from_name: m.from_name,
    is_history: m.is_history,
  }));

  return res.json({ threads });
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
      "id, wamid, chat_id, direction, from_phone, from_name, to_phone, message_type, body_text, media_id, media_mime, media_url, media_filename, media_size, reply_to_wamid, reaction_emoji, is_reaction, is_history, history_phase, received_at",
    )
    .eq("user_id", req.user!.id)
    .eq("chat_id", chatId)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ messages: [...(data ?? [])].reverse() });
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

export default router;
