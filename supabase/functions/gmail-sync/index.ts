import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function refreshGoogleToken(userId: string): Promise<string> {
  const { data: cred } = await supabase
    .from("user_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("service", "gmail")
    .single();

  if (!cred) throw new Error("No Gmail credentials found");

  // Check if token is still valid (with 5 min buffer)
  if (cred.expires_at && new Date(cred.expires_at) > new Date(Date.now() + 5 * 60 * 1000)) {
    return cred.access_token;
  }

  // Refresh token
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

  if (!resp.ok) {
    const err = await resp.text();
    // Token revoked or expired — soft disconnect
    if (resp.status === 401 || resp.status === 400) {
      await supabase
        .from("user_settings")
        .update({ gmail_connected: false })
        .eq("user_id", userId);
      await supabase
        .from("sync_state")
        .update({
          last_error: `Token refresh failed: ${err}`,
          consecutive_failures: 999,
        })
        .eq("user_id", userId)
        .eq("source", "gmail");
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  await supabase
    .from("user_credentials")
    .update({
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    })
    .eq("user_id", userId)
    .eq("service", "gmail");

  return tokens.access_token;
}

async function gmailHistorySync(userId: string, token: string, historyId: string) {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    if (resp.status === 404) {
      // historyId expired — trigger reconcile
      return { newMessages: [], newHistoryId: null, needsReconcile: true };
    }
    throw new Error(`Gmail history API: ${resp.status}`);
  }

  const data = await resp.json();
  const newHistoryId = data.historyId;
  const messageIds: string[] = [];

  for (const record of data.history || []) {
    for (const added of record.messagesAdded || []) {
      // Skip drafts
      if (added.message.labelIds?.includes("DRAFT")) continue;
      messageIds.push(added.message.id);
    }
  }

  return { newMessages: messageIds, newHistoryId, needsReconcile: false };
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
  const get = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  return {
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
  };
}

function extractBody(msg: any): string {
  const parts = msg.payload?.parts || [];
  // Try text/plain first
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    }
  }
  // Fallback to payload body
  if (msg.payload?.body?.data) {
    return atob(msg.payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
  }
  return "";
}

function extractEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader;
}

async function syncUserGmail(userId: string) {
  // Get sync state
  const { data: syncState } = await supabase
    .from("sync_state")
    .select("*")
    .eq("user_id", userId)
    .eq("source", "gmail")
    .single();

  // Check consecutive failures
  if (syncState && syncState.consecutive_failures >= 5) {
    return { skipped: true, reason: "Too many failures — reconnect Gmail" };
  }

  let token: string;
  try {
    token = await refreshGoogleToken(userId);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const checkpoint = syncState?.checkpoint;
  let messageIds: string[] = [];
  let newCheckpoint: string | null = null;

  if (checkpoint) {
    // Incremental sync via history
    const result = await gmailHistorySync(userId, token, checkpoint);
    if (result.needsReconcile) {
      // Trigger gmail-reconcile via pg_net (if available)
      await supabase.from("log_entries").insert({
        user_id: userId,
        level: "warning",
        category: "gmail_sync",
        status: "failed",
        error_message: "historyId expired — needs reconcile",
      });
      return { error: "historyId expired" };
    }
    messageIds = result.newMessages;
    newCheckpoint = result.newHistoryId;
  } else {
    // No checkpoint — initial fetch of unread
    const resp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=50",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      messageIds = (data.messages || []).map((m: any) => m.id);
    }
    // Get current historyId as checkpoint
    const profileResp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (profileResp.ok) {
      const profile = await profileResp.json();
      newCheckpoint = profile.historyId;
    }
  }

  // Fetch details and upsert
  let synced = 0;
  for (const msgId of messageIds) {
    const msg = await fetchMessageDetails(token, msgId);
    if (!msg) continue;

    // Skip drafts
    if (msg.labelIds?.includes("DRAFT")) continue;

    const h = extractHeaders(msg);
    const body = extractBody(msg);
    const senderEmail = extractEmail(h.from);
    const isSent = msg.labelIds?.includes("SENT") || false;

    await supabase.from("source_messages").upsert(
      {
        user_id: userId,
        source_type: isSent ? "gmail_sent" : "gmail",
        source_id: msgId,
        sender: h.from,
        sender_email: senderEmail,
        recipient: h.to,
        subject: h.subject,
        body_text: body.substring(0, 10000), // Limit body size
        has_attachments: (msg.payload?.parts || []).some(
          (p: any) => p.filename && p.filename.length > 0
        ),
        received_at: h.date
          ? new Date(h.date).toISOString()
          : new Date(parseInt(msg.internalDate)).toISOString(),
        processing_status: "pending",
        ai_classification: "pending",
      },
      { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true }
    );
    synced++;
  }

  // Update sync state
  if (newCheckpoint) {
    await supabase.from("sync_state").upsert(
      {
        user_id: userId,
        source: "gmail",
        checkpoint: newCheckpoint,
        last_synced_at: new Date().toISOString(),
        messages_synced_total: (syncState?.messages_synced_total || 0) + synced,
        last_error: null,
        consecutive_failures: 0,
      },
      { onConflict: "user_id,source" }
    );
  }

  return { synced, newCheckpoint };
}

Deno.serve(async (req) => {
  try {
    // Auth: accept either JWT or cron secret
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");

    // If called by pg_cron, sync ALL users with gmail_connected=true
    if (authHeader === cronSecret || req.headers.get("x-cron-secret") === cronSecret) {
      const { data: users } = await supabase
        .from("user_settings")
        .select("user_id")
        .eq("gmail_connected", true);

      const results = [];
      for (const user of users || []) {
        const result = await syncUserGmail(user.user_id);
        results.push({ user_id: user.user_id, ...result });
      }

      return new Response(JSON.stringify({ results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // If called by user (JWT), sync only that user
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const result = await syncUserGmail(user.id);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
