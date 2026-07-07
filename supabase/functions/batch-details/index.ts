import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { extractEmailBody } from "../_shared/email-body.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const BATCH_SIZE = 100;
const CONCURRENCY = 20;

async function refreshGoogleToken(userId: string, service: string): Promise<string> {
  const { data: cred } = await supabase
    .from("user_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("service", service)
    .single();

  if (!cred) throw new Error(`No ${service} credentials`);

  if (cred.expires_at && new Date(cred.expires_at) > new Date(Date.now() + 5 * 60 * 1000)) {
    return cred.access_token;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: cred.refresh_token!,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const tokens = await resp.json();

  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", service);

  return tokens.access_token;
}

async function fetchMessageDetails(token: string, messageId: string) {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) return null;
  return await resp.json();
}

function extractHeaders(msg: any) {
  const headers = msg.payload?.headers || [];
  const get = (name: string) =>
    headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  return {
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
  };
}


function extractEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Step 0: Idle probe — most cron ticks have nothing to fetch, so bail
    // with one cheap query before the lock sweep. Deliberately probed
    // WITHOUT the processing_lock_at filter: a stuck-locked row still has
    // body_text null, which makes this probe return work and lets the
    // stale-lock sweep below run and recover it.
    const { data: probe, error: probeErr } = await supabase
      .from("source_messages")
      .select("id")
      .in("source_type", ["gmail", "gmail_sent"])
      .is("body_text", null)
      .or("dead_letter.eq.false,dead_letter.is.null")
      .limit(1);
    if (!probeErr && (probe?.length ?? 0) === 0) {
      return new Response(JSON.stringify({ processed: 0, idle: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 1: Clean up stuck locks (older than 10 minutes)
    await supabase
      .from("source_messages")
      .update({ processing_lock_at: null })
      .lt("processing_lock_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
      .is("body_text", null)
      .in("source_type", ["gmail", "gmail_sent"]);

    // Step 2: Find messages needing details (no body_text, not locked, not dead)
    const { data: messages, error } = await supabase
      .from("source_messages")
      .select("id, user_id, source_type, source_id, retry_count")
      .in("source_type", ["gmail", "gmail_sent"])
      .is("body_text", null)
      .is("processing_lock_at", null)
      .or("dead_letter.eq.false,dead_letter.is.null")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: "No messages need details" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 3: Lock the batch
    const messageIds = messages.map((m) => m.id);
    await supabase
      .from("source_messages")
      .update({ processing_lock_at: new Date().toISOString() })
      .in("id", messageIds);

    // Group by user to minimize token refreshes
    const byUser: Record<string, typeof messages> = {};
    for (const msg of messages) {
      if (!byUser[msg.user_id]) byUser[msg.user_id] = [];
      byUser[msg.user_id].push(msg);
    }

    let processed = 0;
    let failed = 0;

    for (const [userId, userMsgs] of Object.entries(byUser)) {
      let token: string;
      try {
        token = await refreshGoogleToken(userId, "gmail");
      } catch (e) {
        await supabase
          .from("source_messages")
          .update({ processing_lock_at: null })
          .in("id", userMsgs.map((m) => m.id));
        failed += userMsgs.length;
        continue;
      }

      // Process in parallel chunks of CONCURRENCY
      for (let i = 0; i < userMsgs.length; i += CONCURRENCY) {
        const chunk = userMsgs.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(async (msg) => {
            // Retry cap: a row whose detail-fetch THROWS (rather than cleanly
            // returning null) used to retry forever — 10 rows from May 31
            // looped on every 3-minute tick for 11 days, reported only as an
            // opaque failed-count. After MAX_DETAIL_RETRIES the row is
            // dead-lettered with the error preserved, so it shows up in the
            // log instead of silently burning quota.
            const MAX_DETAIL_RETRIES = 5;
            try {
            const detail = await fetchMessageDetails(token, msg.source_id);
            if (!detail) {
              await supabase
                .from("source_messages")
                .update({
                  processing_lock_at: null,
                  dead_letter: true,
                  processing_status: "processed",
                  skip_reason: "Message not found in Gmail",
                })
                .eq("id", msg.id);
              return { id: msg.id, success: false };
            }

            const h = extractHeaders(detail);
            const body = extractEmailBody(detail.payload);
            const senderEmail = extractEmail(h.from);
            const isSent = detail.labelIds?.includes("SENT") || false;
            const isDraft = detail.labelIds?.includes("DRAFT") || false;

            if (isDraft) {
              await supabase
                .from("source_messages")
                .update({
                  processing_lock_at: null,
                  dead_letter: true,
                  processing_status: "processed",
                  skip_reason: "Draft message",
                })
                .eq("id", msg.id);
              return { id: msg.id, success: false };
            }

            // Safe date resolution: an unparseable Date header (or missing
            // internalDate) used to throw "Invalid time value" inside this
            // map, rejecting the row forever. Prefer the header, fall back to
            // internalDate, fall back to now.
            const headerDate = h.date ? new Date(h.date) : null;
            const internalMs = Number(detail.internalDate);
            const receivedAt =
              headerDate && !isNaN(headerDate.getTime()) ? headerDate
                : Number.isFinite(internalMs) && internalMs > 0 ? new Date(internalMs)
                : new Date();

            await supabase
              .from("source_messages")
              .update({
                source_type: isSent ? "gmail_sent" : "gmail",
                source_url: `https://mail.google.com/mail/u/0/#all/${msg.source_id}`,
                sender: h.from,
                sender_email: senderEmail,
                recipient: h.to,
                subject: h.subject,
                body_text: body.substring(0, 10000),
                has_attachments: (detail.payload?.parts || []).some(
                  (p: any) => p.filename && p.filename.length > 0
                ),
                received_at: receivedAt.toISOString(),
                processing_lock_at: null,
              })
              .eq("id", msg.id);

            return { id: msg.id, success: true };
            } catch (e) {
              const retries = (Number((msg as any).retry_count) || 0) + 1;
              await supabase
                .from("source_messages")
                .update({
                  processing_lock_at: null,
                  retry_count: retries,
                  ...(retries >= MAX_DETAIL_RETRIES
                    ? { dead_letter: true, processing_status: "processed", skip_reason: `details_failed_${retries}x: ${(e as Error).message}`.slice(0, 300) }
                    : {}),
                })
                .eq("id", msg.id);
              return { id: msg.id, success: false };
            }
          })
        );

        for (const r of results) {
          if (r.status === "fulfilled" && r.value.success) processed++;
          else failed++;
        }
      }
    }

    // Unlock any still-locked messages (safety net)
    await supabase
      .from("source_messages")
      .update({ processing_lock_at: null })
      .in("id", messageIds)
      .not("processing_lock_at", "is", null);

    return new Response(JSON.stringify({ processed, failed, total: messages.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
