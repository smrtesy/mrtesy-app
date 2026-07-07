import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseSkipRules } from "../_shared/rule-filters.ts";
import { GMAIL_REVIEW_LABELS, getOrCreateGmailLabels, applyReviewLabel } from "../_shared/gmail-labels.ts";
import { extractEmailBody } from "../_shared/email-body.ts";

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
    level: "error",
    category: "gmail_sync",
    status: "failed",
    error_message: `Gmail disconnected — ${reason}. User must reconnect in Settings → Connections.`,
  }).then(() => {}, () => {});

  if (membership?.org_id) {
    await supabase.from("notifications").insert({
      user_id: userId,
      org_id: membership.org_id,
      app_slug: "smrttask",
      // notifications.type CHECK allows only info|warning|success|action_required.
      // "error" was silently rejected, so this disconnect alert never reached
      // the user. A dead connection needs a re-OAuth → action_required.
      type: "action_required",
      title: "Gmail מנותק",
      body: `חיבור Gmail נותק (${reason}). יש להתחבר מחדש בהגדרות → חיבורים.`,
      link: "/settings",
    }).then(({ error }) => { if (error) console.error("notifications insert failed:", error); }, () => {});
  }
}

/** Insert a notification for the user when a sync fails.
 *  urgency="warning"  → de-duped to 1 per hour (transient errors)
 *  urgency="error"    → de-duped to 1 per 15 min (sync blocked — must be seen quickly) */
async function notifySyncError(
  userId: string,
  source: string,
  message: string,
  urgency: "warning" | "error" = "warning",
) {
  const { data: membership } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!membership?.org_id) return;

  const sourceLabel = source === "gmail" ? "Gmail" : source === "gmail_sent" ? "Gmail (Sent)" : source;
  const title = urgency === "error"
    ? `⚠️ סינכרון ${sourceLabel} מושהה`
    : `בעיה בסינכרון ${sourceLabel}`;

  const dedupMs = urgency === "error" ? 15 * 60 * 1000 : 60 * 60 * 1000;

  // notifications.type CHECK allows only info|warning|success|action_required.
  // "error" was silently rejected by the constraint, so error-urgency sync
  // alerts never reached the user. Map urgency → a valid type (blocked sync =
  // action_required) and use it for BOTH the dedup lookup and the insert so
  // de-duplication still matches.
  const notifType = urgency === "error" ? "action_required" : "warning";

  const { data: existing } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("type", notifType)
    .eq("title", title)
    .eq("is_read", false)
    .gt("created_at", new Date(Date.now() - dedupMs).toISOString())
    .limit(1)
    .maybeSingle();
  if (existing) return;

  await supabase.from("notifications").insert({
    user_id: userId,
    org_id: membership.org_id,
    app_slug: "smrttask",
    type: notifType,
    title,
    body: message.substring(0, 500),
    link: "/log",
  }).then(({ error }) => { if (error) console.error("notifications insert failed:", error); }, () => {});
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
    // Token refresh rejected. Do NOT disconnect on the first failure — Google
    // returns transient 400/401s, and a single blip used to flip
    // gmail_connected=false and silently kill ingestion (2026-06-04 and
    // 2026-06-11 incidents; the disconnect notification also crashed on a
    // broken .catch, so the user never knew). Count consecutive failures in
    // sync_state and only disconnect after DISCONNECT_AFTER_FAILURES in a
    // row; a successful refresh resets the counter below.
    if (resp.status === 401 || resp.status === 400) {
      const DISCONNECT_AFTER_FAILURES = 3;
      const { data: ss } = await supabase
        .from("sync_state")
        .select("consecutive_failures")
        .eq("user_id", userId)
        .eq("source", "gmail")
        .maybeSingle();
      const failures = (Number(ss?.consecutive_failures) || 0) + 1;
      const { error: failureCountUpdateError } = await supabase
        .from("sync_state")
        .update({
          last_error: `Token refresh failed (${resp.status}), attempt ${failures}/${DISCONNECT_AFTER_FAILURES}: ${err.slice(0, 300)}`,
          consecutive_failures: failures,
        })
        .eq("user_id", userId)
        .eq("source", "gmail");
      if (failureCountUpdateError) console.error("sync_state failure count update failed:", failureCountUpdateError);
      if (failures >= DISCONNECT_AFTER_FAILURES) {
        const { error: disconnectUpdateError } = await supabase
          .from("user_settings")
          .update({ gmail_connected: false })
          .eq("user_id", userId);
        if (disconnectUpdateError) console.error("user_settings disconnect update failed:", disconnectUpdateError);
        await notifyDisconnect(userId, `token refresh failed ${failures}× (${resp.status})`);
      } else {
        await notifySyncError(
          userId,
          "gmail",
          `רענון הטוקן של Gmail נכשל (${resp.status}) — ניסיון ${failures} מתוך ${DISCONNECT_AFTER_FAILURES} לפני ניתוק. אם זה חוזר, יש להתחבר מחדש בהגדרות → חיבורים.`,
          "warning",
        ).then(() => {}, () => {});
      }
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  const { error: credUpdateError } = await supabase
    .from("user_credentials")
    .update({
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    })
    .eq("user_id", userId)
    .eq("service", "gmail");
  if (credUpdateError) console.error("user_credentials update failed:", credUpdateError);

  // Clear any stale last_error and reset the failure streak now that the
  // token is healthy again — the disconnect threshold above counts
  // CONSECUTIVE failures only.
  const { error: failureResetError } = await supabase
    .from("sync_state")
    .update({ last_error: null, consecutive_failures: 0 })
    .eq("user_id", userId)
    .eq("source", "gmail")
    .or("last_error.not.is.null,consecutive_failures.gt.0");
  if (failureResetError) console.error("sync_state failure reset failed:", failureResetError);

  return tokens.access_token;
}

async function gmailHistorySync(userId: string, token: string, historyId: string) {
  // Paginate through ALL history pages. history.list returns at most ~100
  // records per page by default; before this fix only the first page was read
  // while the RESPONSE historyId was stored as the checkpoint — every record
  // past page 1 was skipped permanently (real mail loss on busy mailboxes).
  // Follow nextPageToken with a MAX_PAGES safety cap per invocation; if the
  // cap is hit, checkpoint on the id of the LAST PROCESSED history record
  // (history record ids are valid startHistoryId values) so the next cron run
  // resumes exactly where this one stopped instead of jumping past the
  // unread pages.
  const MAX_PAGES = 20;
  const messageIds: string[] = [];
  let pageToken: string | undefined = undefined;
  let pages = 0;
  let responseHistoryId: string | null = null;
  let lastRecordId: string | null = null;

  do {
    const pageParam = pageToken ? `&pageToken=${pageToken}` : "";
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded${pageParam}`,
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

    // Explicit annotation breaks the pageToken → pageParam → resp → data
    // inference cycle that otherwise trips TS7022 in a do-while.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: { historyId?: string; nextPageToken?: string; history?: any[] } = await resp.json();
    responseHistoryId = data.historyId ?? responseHistoryId;

    for (const record of data.history || []) {
      lastRecordId = record.id ?? lastRecordId;
      for (const added of record.messagesAdded || []) {
        // Skip drafts
        if (added.message.labelIds?.includes("DRAFT")) continue;
        messageIds.push(added.message.id);
      }
    }

    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  // Cap hit with pages still pending → resume from the last processed history
  // record next run. All pages consumed → the response historyId is safe to
  // store, exactly as before.
  const newHistoryId = pageToken && lastRecordId ? lastRecordId : responseHistoryId;

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

function extractEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader;
}

async function syncUserGmail(userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let syncState: any = null;
  try {
    return await _syncUserGmailInner(userId, (s) => { syncState = s; });
  } catch (e: unknown) {
    const errMsg = `syncUserGmail uncaught: ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`;
    await supabase.from("sync_state").upsert(
      { user_id: userId, source: "gmail", last_error: errMsg, consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1 },
      { onConflict: "user_id,source" }
    ).then(({ error }) => { if (error) console.error("sync_state upsert failed:", error); }, () => {});
    await supabase.from("log_entries").insert({
      user_id: userId, level: "error", category: "gmail_sync", status: "failed", error_message: errMsg,
    }).then(() => {}, () => {});
    await notifySyncError(userId, "gmail", errMsg).then(() => {}, () => {});
    return { error: errMsg };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _syncUserGmailInner(userId: string, setSyncState: (s: any) => void) {
  // Get sync state
  const { data: syncState } = await supabase
    .from("sync_state")
    .select("*")
    .eq("user_id", userId)
    .eq("source", "gmail")
    .single();
  setSyncState(syncState);

  // Check consecutive failures — with self-healing after a 30-minute cooldown.
  // Before this fix the function would mute itself permanently after 5 failures,
  // causing a silent multi-hour blackout when a transient API / quota error hit
  // at night (discovered: 2026-06-04, caused by Gmail quota from Apps Script).
  if (syncState && syncState.consecutive_failures >= 5) {
    const lastSynced = syncState.last_synced_at ? new Date(syncState.last_synced_at) : null;
    const msSinceLastSync = lastSynced ? Date.now() - lastSynced.getTime() : Infinity;
    const cooldownMs = 30 * 60 * 1000;

    if (msSinceLastSync < cooldownMs) {
      const minutesLeft = Math.ceil((cooldownMs - msSinceLastSync) / 60000);
      // Log every skip so the user sees it in the sources log
      await supabase.from("log_entries").insert({
        user_id: userId,
        level: "error",
        category: "gmail_sync",
        status: "failed",
        error_message: `Gmail sync paused after ${syncState.consecutive_failures} consecutive failures — auto-retry in ${minutesLeft}m. Last error: ${syncState.last_error ?? "unknown"}`,
      }).then(() => {}, () => {});
      await notifySyncError(userId, "gmail",
        `סינכרון Gmail הושהה — ${syncState.consecutive_failures} כשלים ברצף. ניסיון חוזר אוטומטי בעוד ${minutesLeft} דקות. שגיאה: ${syncState.last_error ?? "לא ידוע"}`,
        "error",
      ).then(() => {}, () => {});
      return { skipped: true, reason: `too many failures — cooldown ${minutesLeft}m` };
    }

    // Cooldown passed — auto-reset and attempt recovery instead of staying muted forever
    const { error: cooldownResetError } = await supabase.from("sync_state")
      .update({ consecutive_failures: 0, last_error: null })
      .eq("user_id", userId)
      .eq("source", "gmail");
    if (cooldownResetError) console.error("sync_state cooldown reset failed:", cooldownResetError);
    await supabase.from("log_entries").insert({
      user_id: userId,
      level: "warning",
      category: "gmail_sync",
      status: "pending",
      error_message: `Gmail sync auto-recovering after ${syncState.consecutive_failures} consecutive failures — retrying now`,
    }).then(() => {}, () => {});
    syncState.consecutive_failures = 0;
    syncState.last_error = null;
  }

  let token: string;
  try {
    token = await refreshGoogleToken(userId);
  } catch (e) {
    const errMsg = (e as Error).message;
    const { error: tokenFailUpsertError } = await supabase.from("sync_state").upsert(
      {
        user_id: userId,
        source: "gmail",
        last_error: errMsg,
        consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
      },
      { onConflict: "user_id,source" }
    );
    if (tokenFailUpsertError) console.error("sync_state upsert failed:", tokenFailUpsertError);
    return { error: errMsg };
  }

  const skipFilter = await loadSkipRules(userId);

  const checkpoint = syncState?.checkpoint;
  let messageIds: string[] = [];
  let newCheckpoint: string | null = null;

  if (checkpoint) {
    // Incremental sync via history
    let result: { newMessages: string[]; newHistoryId: string | null; needsReconcile: boolean };
    try {
      result = await gmailHistorySync(userId, token, checkpoint);
    } catch (e) {
      const errMsg = (e as Error).message;

      // 401 from the Gmail API means our cached token was rejected.
      // Force-invalidate it and retry once before counting as a failure.
      if (errMsg.includes(": 401")) {
        try {
          const { error: tokenInvalidateError } = await supabase.from("user_credentials")
            .update({ expires_at: new Date(0).toISOString() })
            .eq("user_id", userId)
            .eq("service", "gmail");
          if (tokenInvalidateError) console.error("user_credentials invalidate failed:", tokenInvalidateError);
          token = await refreshGoogleToken(userId);
          result = await gmailHistorySync(userId, token, checkpoint);
          // Retry succeeded — clear any stale error and continue
          const { error: retryClearError } = await supabase.from("sync_state")
            .update({ last_error: null })
            .eq("user_id", userId)
            .eq("source", "gmail")
            .not("last_error", "is", null);
          if (retryClearError) console.error("sync_state error clear failed:", retryClearError);
        } catch (retryErr) {
          const retryMsg = (retryErr as Error).message;
          const { error: retryFailUpsertError } = await supabase.from("sync_state").upsert(
            { user_id: userId, source: "gmail", last_error: retryMsg, consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1 },
            { onConflict: "user_id,source" }
          );
          if (retryFailUpsertError) console.error("sync_state upsert failed:", retryFailUpsertError);
          await supabase.from("log_entries").insert({
            user_id: userId, level: "error", category: "gmail_sync", status: "failed",
            error_message: `gmailHistorySync 401 retry failed: ${retryMsg}`,
          }).then(() => {}, () => {});
          await notifySyncError(userId, "gmail", `gmailHistorySync: ${retryMsg}`).then(() => {}, () => {});
          return { error: retryMsg };
        }
      } else {
        const { error: historyFailUpsertError } = await supabase.from("sync_state").upsert(
          {
            user_id: userId,
            source: "gmail",
            last_error: errMsg,
            consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
          },
          { onConflict: "user_id,source" }
        );
        if (historyFailUpsertError) console.error("sync_state upsert failed:", historyFailUpsertError);
        await supabase.from("log_entries").insert({
          user_id: userId,
          level: "error",
          category: "gmail_sync",
          status: "failed",
          error_message: `gmailHistorySync threw: ${errMsg}`,
        }).then(() => {}, () => {});
        await notifySyncError(userId, "gmail", `gmailHistorySync: ${errMsg}`).then(() => {}, () => {});
        return { error: errMsg };
      }
    }
    if (result.needsReconcile) {
      // Checkpoint unusable (Gmail returned 404/400). Clear it so the NEXT run
      // takes the no-checkpoint path: fresh fetch of unread + a new valid
      // historyId. Without this reset the bad checkpoint would 404/400 forever.
      const { error: checkpointResetError } = await supabase
        .from("sync_state")
        .update({ checkpoint: null })
        .eq("user_id", userId)
        .eq("source", "gmail");
      if (checkpointResetError) console.error("sync_state checkpoint reset failed:", checkpointResetError);
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
    // No checkpoint — initial fetch of unread. Paginate through ALL matching
    // pages instead of a single 50-message page: after a historyId reset this
    // fallback is the only collector running until the daily reconcile, so
    // capping it at 50 silently dropped everything older than the 50 most-recent
    // unread messages — a multi-day backlog would sit invisible until reconcile
    // swept it. maxResults=500 is Gmail's per-page max; the loop follows
    // nextPageToken with a 2000-id runaway guard.
    // Skip-rule exclusions are NOT applied to the query: we now WANT to fetch
    // auto-skipped emails so they can be recorded in the log (see the
    // per-message skip handling below). They're marked skip + processed without
    // hitting Claude, so no AI cost is incurred.
    const queryParts = ["is:unread"];
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
  // Lazily resolved on the first skip in this run so syncs with no skipped
  // mail pay nothing. Caches the smrtTask + smrtTask/דילוג label IDs for the
  // whole batch. null = not yet resolved; on resolution failure stays null and
  // labeling is silently skipped (best-effort, never wedges the sync).
  let skipLabelMap: Map<string, string> | null = null;
  for (const msgId of messageIds) {
    const msg = await fetchMessageDetails(token, msgId);
    if (!msg) continue;

    // Skip drafts
    if (msg.labelIds?.includes("DRAFT")) continue;

    const h = extractHeaders(msg);
    const body = extractEmailBody(msg.payload);
    const senderEmail = extractEmail(h.from);
    const isSent = msg.labelIds?.includes("SENT") || false;

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

    const sourceType = isSent ? "gmail_sent" : "gmail";
    const sourceUrl = `https://mail.google.com/mail/u/0/#all/${msgId}`;
    // Safe date parsing — new Date(invalid).toISOString() throws RangeError
    let receivedAt: string;
    try {
      receivedAt = h.date ? new Date(h.date).toISOString() : new Date(parseInt(msg.internalDate)).toISOString();
    } catch {
      receivedAt = new Date().toISOString();
    }

    const baseRow = {
      user_id: userId,
      source_type: sourceType,
      source_id: msgId,
      source_url: sourceUrl,
      sender: h.from,
      sender_email: senderEmail,
      recipient: h.to,
      subject: h.subject,
      body_text: body.substring(0, 10000),
      has_attachments: (msg.payload?.parts || []).some(
        (p: any) => p.filename && p.filename.length > 0
      ),
      received_at: receivedAt,
      // metadata.labels carries Gmail's own categorisation
      // (CATEGORY_PROMOTIONS / SOCIAL / UPDATES / FORUMS / PERSONAL etc.).
      // ai-process uses these in preClassify to decide informational vs
      // needs_claude — replacing the previous hardcoded keyword list.
      // threadId powers the follow-up linking in ai-process.
      // recipients[] captures every address-side header so `to=` skip
      // rules can match BCC/forwarding cases (T367-style false positives).
      metadata: { to: h.to, threadId: msg.threadId, labels: msg.labelIds || [], recipients: allRecipients },
    };

    // Skip rules from rules_memory (single source of truth). Pass subject too
    // so composite rules `from=X&subject_contains=Y` match at runtime.
    // Previously a match dropped the email silently (continue) and it never
    // appeared anywhere. Now we still record it as a `skip`-classified row +
    // a log entry so EVERY email shows in the log — but mark it processed so
    // ai-process never picks it up and no Claude/AI cost is incurred.
    const skipTrigger = skipFilter.skipMatch({ from: h.from, to: h.to, senderEmail, subject: h.subject });
    if (skipTrigger) {
      const skipReason = `skip_rule: ${skipTrigger}`;
      // ignoreDuplicates → .select() returns the row only on a fresh insert;
      // on conflict it returns null, so we don't write a duplicate log entry
      // when the same message is seen again on a later sync.
      const { data: inserted, error: skipUpsertErr } = await supabase.from("source_messages").upsert(
        {
          ...baseRow,
          processing_status: "processed",
          ai_classification: "skip",
          skip_reason: skipReason,
          processed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true }
      ).select("id").maybeSingle();
      // Don't throw — a single bad row shouldn't wedge the whole batch — but
      // surface the error: a silently-failed skip row leaves the email with no
      // log entry, defeating the point of recording it.
      if (skipUpsertErr) console.error(`gmail-sync skip upsert failed (${msgId}):`, skipUpsertErr.message);
      if (inserted?.id) {
        const { error: skipLogErr } = await supabase.from("log_entries").insert({
          user_id: userId,
          category: "ai_process",
          status: "skipped",
          source_message_id: inserted.id,
          source_type: sourceType,
          source_id: msgId,
          source_url: sourceUrl,
          sender: h.from,
          sender_email: senderEmail,
          subject: h.subject,
          pre_classification: "skip",
          ai_classification: "skip",
          classification_reason: skipReason,
        });
        if (skipLogErr) console.error(`gmail-sync skip log insert failed (${msgId}):`, skipLogErr.message);

        // Tag the message in Gmail exactly like the ai-process skip path:
        // smrtTask/דילוג + parent smrtTask, and drop UNREAD. Best-effort —
        // a labeling failure must never wedge the sync. Sent mail isn't
        // tagged (matches ai-process's source_type === "gmail" guard).
        if (sourceType === "gmail") {
          try {
            if (!skipLabelMap) {
              skipLabelMap = await getOrCreateGmailLabels(token, ["smrtTask", GMAIL_REVIEW_LABELS.skip]);
            }
            await applyReviewLabel(token, msgId, "skip", skipLabelMap);
          } catch (e) {
            console.error(`gmail-sync skip label failed (${msgId}):`, e instanceof Error ? e.message : String(e));
          }
        }
      }
      synced++;
      continue;
    }

    const { error: pendingUpsertError } = await supabase.from("source_messages").upsert(
      {
        ...baseRow,
        processing_status: "pending",
        ai_classification: "pending",
      },
      { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true }
    );
    if (pendingUpsertError) console.error(`gmail-sync pending upsert failed (${msgId}):`, pendingUpsertError);
    synced++;
  }

  // Update sync state
  if (newCheckpoint) {
    const { error: checkpointUpsertError } = await supabase.from("sync_state").upsert(
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
    if (checkpointUpsertError) console.error("sync_state checkpoint upsert failed:", checkpointUpsertError);
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
