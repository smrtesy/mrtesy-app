import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseSkipRules } from "../_shared/rule-filters.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function notifyDisconnect(userId: string, reason: string) {
  const { data: membership } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  await supabase.from("log_entries").insert({
    user_id: userId,
    category: "gmail_sync",
    status: "failed",
    error_message: `Gmail disconnected — ${reason}. User must reconnect in Settings.`,
  }).catch(() => {});

  if (membership?.org_id) {
    // type MUST satisfy the notifications CHECK constraint
    // ('info','warning','success','action_required'). "sync_disconnected"
    // violated it and the insert was silently dropped by the .catch — so the
    // user never got a cron-time disconnect notification.
    await supabase.from("notifications").insert({
      user_id: userId,
      org_id: membership.org_id,
      app_slug: "smrttask",
      type: "action_required",
      title: "Gmail התנתק",
      body: `החיבור ל-Gmail פג תוקף (${reason}). לחץ כדי להתחבר מחדש — סנכרון לא ירוץ עד שתעשה את זה.`,
      link: "/account",
    }).catch(() => {});
  }
}

async function loadSkipRules(userId: string) {
  const { data } = await supabase
    .from("rules_memory")
    .select("trigger, rule_type, is_active")
    .eq("user_id", userId)
    .eq("is_active", true);
  return parseSkipRules(data ?? []);
}

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
    // invalid_client = OUR OAuth client_id/secret failed to authenticate, NOT a
    // user revocation. Reconnecting won't help and the real fix is an env
    // correction, so don't disable gmail or prompt a pointless reconnect — just
    // log it so the next cron run self-heals once the secret is fixed.
    const isClientMismatch = /invalid_client/i.test(err);
    if (isClientMismatch) {
      await supabase
        .from("sync_state")
        .update({
          last_error: `Token refresh failed (invalid_client — check GOOGLE_CLIENT_ID/SECRET): ${err}`.slice(0, 1000),
        })
        .eq("user_id", userId)
        .eq("source", "gmail");
      await supabase.from("log_entries").insert({
        user_id: userId,
        level: "error",
        category: "gmail_sync",
        status: "failed",
        error_message: `gmail: invalid_client — OAuth client auth failed; check GOOGLE_CLIENT_ID/SECRET`,
      }).catch(() => {});
    } else if (resp.status === 401 || resp.status === 400) {
      // Token revoked or expired — soft disconnect
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
      await notifyDisconnect(userId, `token refresh failed (${resp.status})`);
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

  // Clear any stale last_error now that the token is healthy again.
  await supabase
    .from("sync_state")
    .update({ last_error: null })
    .eq("user_id", userId)
    .eq("source", "gmail")
    .not("last_error", "is", null);

  return tokens.access_token;
}

async function gmailHistorySync(userId: string, token: string, historyId: string) {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    // 404 = historyId too old; 400 = historyId invalid/malformed. Both mean the
    // stored checkpoint is unusable — self-heal by resetting it (next run does a
    // fresh fetch) instead of throwing a 500 that wedges the whole cron.
    if (resp.status === 404 || resp.status === 400) {
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
  // BCC visibility: Gmail strips the `Bcc` header from delivered mail
  // (recipients can't see each other), but when YOUR mailbox is the BCC
  // recipient Gmail keeps a `Delivered-To` header listing the address
  // the message was actually delivered to. `X-Forwarded-To` and
  // `X-Original-To` cover the forwarding case (outbox@maor.org → us).
  // For SENT mail we still have access to our own Bcc/Cc headers.
  return {
    from: get("From"),
    to: get("To"),
    cc: get("Cc"),
    bcc: get("Bcc"),
    deliveredTo: get("Delivered-To"),
    forwardedTo: get("X-Forwarded-To"),
    originalTo: get("X-Original-To"),
    subject: get("Subject"),
    date: get("Date"),
  };
}

// Parse a comma-separated address-list header into normalised emails:
// '"Name" <a@b>, c@d' → ['a@b', 'c@d']. Lowercased; deduped by caller.
function parseAddressList(value: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1] : s).trim().toLowerCase();
    })
    .filter((s) => s.includes("@"));
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
    const errMsg = (e as Error).message;
    await supabase.from("sync_state").upsert(
      {
        user_id: userId,
        source: "gmail",
        last_error: errMsg,
        consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
      },
      { onConflict: "user_id,source" }
    );
    return { error: errMsg };
  }

  const skipFilter = await loadSkipRules(userId);

  const checkpoint = syncState?.checkpoint;
  let messageIds: string[] = [];
  let newCheckpoint: string | null = null;

  if (checkpoint) {
    // Incremental sync via history
    const result = await gmailHistorySync(userId, token, checkpoint);
    if (result.needsReconcile) {
      // Checkpoint unusable (Gmail returned 404/400). Clear it so the NEXT run
      // takes the no-checkpoint path: fresh fetch of unread + a new valid
      // historyId. Without this reset the bad checkpoint would 404/400 forever.
      await supabase
        .from("sync_state")
        .update({ checkpoint: null })
        .eq("user_id", userId)
        .eq("source", "gmail");
      await supabase.from("log_entries").insert({
        user_id: userId,
        level: "warning",
        category: "gmail_sync",
        status: "failed",
        error_message: "historyId invalid — checkpoint reset for fresh fetch",
      });
      return { error: "historyId reset" };
    }
    messageIds = result.newMessages;
    newCheckpoint = result.newHistoryId;

    // Gmail sometimes omits historyId from the history response when there are
    // no new messages. Fall back to the profile endpoint so we always get a
    // valid checkpoint and last_synced_at is updated on every run.
    if (!newCheckpoint) {
      const profileResp = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (profileResp.ok) {
        const profile = await profileResp.json();
        newCheckpoint = profile.historyId;
      }
    }
  } else {
    // No checkpoint — initial fetch of unread (with skip rules applied to query).
    // Paginate through ALL matching pages instead of a single 50-message page.
    // After a historyId reset this fallback is the only collector running until
    // the daily reconcile, so capping it at 50 silently dropped everything older
    // than the 50 most-recent unread messages — a multi-day backlog would sit
    // invisible until reconcile swept it. maxResults=500 is Gmail's per-page max;
    // the loop follows nextPageToken with a 2000-id runaway guard.
    const queryParts = ["is:unread", ...skipFilter.gmailQueryFilters];
    const q = encodeURIComponent(queryParts.join(" "));
    let pageToken: string | undefined = undefined;
    do {
      const pageParam = pageToken ? `&pageToken=${pageToken}` : "";
      const resp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=500${pageParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) break;
      const data = await resp.json();
      messageIds.push(...(data.messages || []).map((m: any) => m.id));
      pageToken = data.nextPageToken;
    } while (pageToken && messageIds.length < 2000);
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

    // Apply skip rules from rules_memory (single source of truth). Pass
    // subject too so composite rules `from=X&subject_contains=Y` can match
    // at runtime — Gmail's query exclusion catches most of these at fetch
    // time, but the runtime check is the safety net.
    if (skipFilter.shouldSkip({ from: h.from, to: h.to, senderEmail, subject: h.subject })) {
      continue;
    }

    // Collect every recipient-side address we can see — To, Cc, Bcc (when
    // the user is the sender), plus Delivered-To / X-Forwarded-To /
    // X-Original-To (which surface the actual BCC mailbox when WE are
    // a BCC recipient that arrived via forwarding). Skip rules of the
    // form `to=<addr>` need to match against ALL of these, not just To.
    const allRecipients = Array.from(new Set([
      ...parseAddressList(h.to),
      ...parseAddressList(h.cc),
      ...parseAddressList(h.bcc),
      ...parseAddressList(h.deliveredTo),
      ...parseAddressList(h.forwardedTo),
      ...parseAddressList(h.originalTo),
    ]));

    await supabase.from("source_messages").upsert(
      {
        user_id: userId,
        source_type: isSent ? "gmail_sent" : "gmail",
        source_id: msgId,
        source_url: `https://mail.google.com/mail/u/0/#all/${msgId}`,
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
        // metadata.labels carries Gmail's own categorisation
        // (CATEGORY_PROMOTIONS / SOCIAL / UPDATES / FORUMS / PERSONAL etc.).
        // ai-process uses these in preClassify to decide informational vs
        // needs_claude — replacing the previous hardcoded keyword list.
        // threadId powers the follow-up linking in ai-process.
        // recipients[] captures every address-side header so `to=` skip
        // rules can match BCC/forwarding cases (T367-style false positives).
        metadata: { to: h.to, threadId: msg.threadId, labels: msg.labelIds || [], recipients: allRecipients },
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
