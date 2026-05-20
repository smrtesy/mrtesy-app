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
      "chat_id, direction, body_text, media_ocr_text, audio_transcript, received_at, from_phone, from_name, message_type, is_history",
    )
    .eq("user_id", req.user!.id)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

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
      is_history: m.is_history,
    };
  });

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
      "id, wamid, chat_id, direction, from_phone, from_name, to_phone, message_type, body_text, media_ocr_text, audio_transcript, media_id, media_mime, media_url, media_filename, media_size, reply_to_wamid, reaction_emoji, is_reaction, is_history, history_phase, received_at, status, status_error, sent_at, delivered_at, read_at",
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

  // Refresh the source_messages thread row so Part 3 / dashboards see the
  // new message right away. Same shape part2-whatsapp used to produce.
  // (We don't fail the send response if this errors — the row is in
  // whatsapp_messages already and the webhook echo will refresh later.)
  try {
    const { data: lastMsgs } = await db
      .from("whatsapp_messages")
      .select("direction, body_text, received_at, from_phone, from_name")
      .eq("user_id", req.user!.id)
      .eq("chat_id", chatId)
      .order("received_at", { ascending: false })
      .limit(20);

    if (lastMsgs && lastMsgs.length > 0) {
      const ordered = [...lastMsgs].reverse();
      const last = ordered[ordered.length - 1];
      const latestIncoming = [...ordered]
        .reverse()
        .find((m) => m.direction === "incoming");
      const chatName =
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

      await db.from("source_messages").upsert(
        {
          user_id: req.user!.id,
          source_type: "whatsapp",
          source_id: `wa:${chatId}`,
          sender: chatName,
          subject: chatName,
          body_text: text.trim().slice(0, 1000),
          raw_content: rawContent.slice(0, 3000),
          received_at: nowIso,
          source_url: `https://wa.me/${String(fromPhone).replace(/\D/g, "")}`,
          reply_to_context: fromPhone,
          processing_status: "pending",
          metadata: { chatId, chatName, fromPhone, isGroup: false },
        },
        { onConflict: "user_id,source_type,source_id" },
      );
    }
  } catch (e) {
    console.warn("[whatsapp-send] source_messages refresh failed:", e);
  }

  return res.json({ ok: true, wamid });
});

export default router;
