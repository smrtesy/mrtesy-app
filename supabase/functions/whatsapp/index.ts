import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const WA_VERIFY_TOKEN = Deno.env.get("WA_VERIFY_TOKEN") || "ny9umJPez_PkrnIoK5D2byHm3aQzfapX";
const WA_MEDIA_TOKEN = Deno.env.get("WA_MEDIA_TOKEN") || "EAAemLg1NRY8BRNZAckI5iaa2X0plQRtb3ZCZBMQDwZCBYZB5dwLYOIOnuwrN1MJrHGsnFvLtFZCkK00yU4zFRlkAWDt67cGQdPbvgu3jMfRDXtJMambjnlNKs5gUNvWJE9X9FnHAU1RrMmtiSrmpfIlENCYlqOrI18oPiGL1GVPvTGzZAtoZAxUbeFy9XhCnEAZDZD";

async function getMediaUrl(mediaId: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WA_MEDIA_TOKEN}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.url || null;
  } catch {
    return null;
  }
}

async function parseWhatsAppPayload(payload: any, userId: string) {
  const rows: any[] = [];
  const entries = payload?.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value;
      const contacts = value.contacts || [];
      const messages = value.messages || [];
      const statuses = value.statuses || [];
      const businessPhone = value.metadata?.display_phone_number || null;

      console.log(`[whatsapp] change field=${change.field} messages=${messages.length} statuses=${statuses.length} contacts=${contacts.length}`);

      // --- INCOMING MESSAGES ---
      for (const msg of messages) {
        const contact = contacts.find((c: any) => c.wa_id === msg.from);
        const senderName = contact?.profile?.name || msg.from;

        let bodyText = "";
        let mediaUrl: string | null = null;
        let hasAttachments = false;

        if (msg.type === "text" && msg.text?.body) {
          bodyText = msg.text.body;
        } else if (msg.type === "image" && msg.image) {
          bodyText = msg.image.caption || `[Image]`;
          mediaUrl = await getMediaUrl(msg.image.id);
          hasAttachments = true;
        } else if (msg.type === "document" && msg.document) {
          bodyText = msg.document.caption || `[Document: ${msg.document.filename || 'file'}]`;
          mediaUrl = await getMediaUrl(msg.document.id);
          hasAttachments = true;
        } else if (msg.type === "video" && msg.video) {
          bodyText = msg.video.caption || `[Video]`;
          mediaUrl = await getMediaUrl(msg.video.id);
          hasAttachments = true;
        } else if (msg.type === "audio" && msg.audio) {
          bodyText = `[Audio message]`;
          mediaUrl = await getMediaUrl(msg.audio.id);
          hasAttachments = true;
        } else {
          console.log(`[whatsapp] Skipping msg type=${msg.type} id=${msg.id}`);
          continue;
        }

        console.log(`[whatsapp] Saving INCOMING from=${senderName} type=${msg.type} body=${bodyText.substring(0, 50)}`);

        rows.push({
          user_id: userId,
          source_type: "whatsapp",
          source_id: msg.id,
          sender: senderName,
          sender_phone: msg.from,
          recipient: businessPhone,
          subject: bodyText.substring(0, 200),
          body_text: bodyText,
          source_url: mediaUrl,
          has_attachments: hasAttachments,
          received_at: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
          processing_status: "pending",
          ai_classification: "pending",
        });
      }

      // --- OUTGOING / ECHO MESSAGES (from statuses with conversation context) ---
      // WhatsApp Cloud API sends statuses for outgoing messages with recipient info
      // Some providers (dualhook etc.) send the actual outgoing message content
      for (const status of statuses) {
        // Only process 'sent' status (first delivery event for outgoing)
        if (status.status !== "sent") continue;
        
        const recipientPhone = status.recipient_id;
        if (!recipientPhone) continue;

        // Check if we already have this message (avoid duplicates from delivered/read statuses)
        const existingId = `out_${status.id}`;
        
        // Build outgoing message record
        // The conversation object tells us about the conversation context
        const conversation = status.conversation || {};
        const origin = conversation.origin?.type || "unknown";
        
        console.log(`[whatsapp] OUTGOING status=${status.status} to=${recipientPhone} msg_id=${status.id} origin=${origin}`);

        rows.push({
          user_id: userId,
          source_type: "whatsapp_echo",
          source_id: existingId,
          sender: businessPhone || "me",
          sender_phone: businessPhone,
          recipient: recipientPhone,
          subject: `[Outgoing to ${recipientPhone}]`,
          body_text: `Outgoing WhatsApp message to ${recipientPhone}. Conversation type: ${origin}. Status: ${status.status}.`,
          received_at: new Date(parseInt(status.timestamp) * 1000).toISOString(),
          processing_status: "pending",
          ai_classification: "pending",
        });
      }
    }
  }
  return rows;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    console.log(`[whatsapp] POST user_id=${userId || 'MISSING'}`);

    if (!userId) {
      return new Response("OK", { status: 200 });
    }

    try {
      const bodyText = await req.text();
      console.log(`[whatsapp] payload_size=${bodyText.length} first200=${bodyText.substring(0, 200)}`);

      const payload = JSON.parse(bodyText);
      const rows = await parseWhatsAppPayload(payload, userId);
      console.log(`[whatsapp] Parsed ${rows.length} messages (incoming + outgoing)`);

      if (rows.length > 0) {
        const { error } = await supabase.from("source_messages").upsert(rows, {
          onConflict: "user_id,source_type,source_id",
          ignoreDuplicates: true,
        });
        if (error) {
          console.error(`[whatsapp] DB error: ${error.message}`);
        } else {
          console.log(`[whatsapp] Saved ${rows.length} msgs to DB`);
        }
      }
    } catch (e) {
      console.error(`[whatsapp] Error: ${(e as Error).message}`);
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
