import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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
    category: "calendar_webhook",
    status: "failed",
    error_message: `Calendar disconnected — ${reason}. User must reconnect in Settings → Connections.`,
  }).then(() => {}, () => {});

  if (membership?.org_id) {
    await supabase.from("notifications").insert({
      user_id: userId,
      org_id: membership.org_id,
      app_slug: "smrttask",
      // notifications.type CHECK allows only info|warning|success|action_required.
      // A dead connection needs a re-OAuth → action_required.
      type: "action_required",
      title: "יומן Google מנותק",
      body: `חיבור יומן Google נותק (${reason}). יש להתחבר מחדש בהגדרות → חיבורים.`,
      link: "/settings",
    }).then(({ error }) => { if (error) console.error("notifications insert failed:", error); }, () => {});
  }
}

async function refreshGoogleToken(userId: string): Promise<string> {
  const { data: cred } = await supabase
    .from("user_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("service", "google_calendar")
    .single();

  if (!cred) throw new Error("No Calendar credentials found");

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

  if (!resp.ok) {
    const err = await resp.text();
    // Token refresh rejected. Do NOT disconnect on the first failure — Google
    // returns transient 400/401s, and a single blip used to flip
    // calendar_connected=false and silently kill calendar sync. Same 3-strike
    // policy as gmail-sync: count consecutive failures in sync_state and only
    // disconnect (+notify) after DISCONNECT_AFTER_FAILURES in a row; a
    // successful refresh resets the counter below.
    if (resp.status === 401 || resp.status === 400) {
      const DISCONNECT_AFTER_FAILURES = 3;
      const { data: ss } = await supabase
        .from("sync_state")
        .select("consecutive_failures")
        .eq("user_id", userId)
        .eq("source", "google_calendar")
        .maybeSingle();
      const failures = (Number(ss?.consecutive_failures) || 0) + 1;
      const { error: failureCountUpsertError } = await supabase
        .from("sync_state")
        .upsert({
          user_id: userId,
          source: "google_calendar",
          last_error: `Token refresh failed (${resp.status}), attempt ${failures}/${DISCONNECT_AFTER_FAILURES}: ${err.slice(0, 300)}`,
          consecutive_failures: failures,
        }, { onConflict: "user_id,source" });
      if (failureCountUpsertError) console.error("sync_state failure count upsert failed:", failureCountUpsertError);
      if (failures >= DISCONNECT_AFTER_FAILURES) {
        const { error: disconnectUpdateError } = await supabase
          .from("user_settings")
          .update({ calendar_connected: false })
          .eq("user_id", userId);
        if (disconnectUpdateError) console.error("user_settings disconnect update failed:", disconnectUpdateError);
        await notifyDisconnect(userId, `token refresh failed ${failures}× (${resp.status})`);
      }
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", "google_calendar");

  // Reset the failure streak now that the token is healthy again — the
  // disconnect threshold above counts CONSECUTIVE failures only.
  const { error: failureResetError } = await supabase
    .from("sync_state")
    .update({ consecutive_failures: 0 })
    .eq("user_id", userId)
    .eq("source", "google_calendar")
    .gt("consecutive_failures", 0);
  if (failureResetError) console.error("sync_state failure reset failed:", failureResetError);

  return tokens.access_token;
}

// Constant-time string compare (length leak only; both sides are fixed-length
// random UUID tokens). Avoids a node:crypto import in the edge runtime.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// Safety valve for both the incremental sync loop and token capture.
const MAX_SYNC_PAGES = 20;
// timeMax bound for the token-capture listing: with singleEvents=true a
// never-ending weekly recurrence otherwise expands into unbounded future
// instances, the page cap is hit on every run, and the token is never
// captured (permanent bootstrap mode).
const SYNC_TOKEN_TIME_MAX_MS = 365 * 24 * 60 * 60 * 1000; // now + 1 year

// Capture a fresh Calendar sync token, returning the events fetched along the
// way so the bootstrap path can process the SAME window it stamps a token
// over (a separate scan would miss changes landing between scan and capture).
// nextSyncToken only appears on the LAST page of an events.list response, so
// page through to the end. singleEvents=true must match what the incremental
// path sends alongside the token; the 24h timeMin window keeps the page count
// small and gets encoded into the token (it must NOT be re-sent with
// syncToken later). No orderBy — it is incompatible with sync tokens and
// suppresses nextSyncToken.
// Trade-off of timeMax: the constraint is baked into the sync token, so
// events further than a year out won't appear in incremental syncs until the
// next re-bootstrap (410 resets rebuild the window) — acceptable for a task
// app.
async function captureCalendarSyncToken(
  accessToken: string,
  userId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ token: string | null; events: any[] }> {
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + SYNC_TOKEN_TIME_MAX_MS).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_SYNC_PAGES; page++) {
    const params = new URLSearchParams({
      maxResults: "250",
      singleEvents: "true",
      timeMin,
      timeMax,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const resp = await fetch(`${CALENDAR_EVENTS_URL}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      console.warn(`[calendar-webhook] sync token capture failed for ${userId}: ${resp.status}`);
      return { token: null, events };
    }
    const data = await resp.json();
    events.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) return { token: data.nextSyncToken || null, events };
  }
  console.warn(`[calendar-webhook] sync token capture hit ${MAX_SYNC_PAGES}-page cap for ${userId} — skipping capture this run`);
  return { token: null, events };
}

Deno.serve(async (req) => {
  // Google sends a POST with X-Goog-Channel-ID and X-Goog-Resource-State headers
  if (req.method === "POST") {
    const channelId = req.headers.get("X-Goog-Channel-ID") || "";
    const resourceState = req.headers.get("X-Goog-Resource-State") || "";
    const channelToken = req.headers.get("X-Goog-Channel-Token") || "";

    // channelId format: "calendar-{userId}" (legacy) or "calendar-{userId}-{ts}"
    // (current — a unique suffix is appended on each renewal). The userId is a
    // 36-char UUID, so take the first 36 chars after the prefix either way.
    const userId = channelId.replace(/^calendar-/, "").slice(0, 36);

    if (!userId || resourceState === "sync") {
      // Initial sync confirmation — just acknowledge
      return new Response("OK", { status: 200 });
    }

    // Authenticate the channel: the userId in the header is attacker-controllable,
    // so verify the opaque token Google echoes back (set at watch creation).
    // Backward-compatible: watches created before watch_token existed have a NULL
    // token — we fail OPEN for them until they renew (~weekly) and gain one.
    const { data: syncState } = await supabase
      .from("sync_state")
      .select("checkpoint, watch_token")
      .eq("user_id", userId)
      .eq("source", "google_calendar")
      .maybeSingle();

    if (syncState?.watch_token && !safeEqual(syncState.watch_token, channelToken)) {
      console.warn(`[calendar-webhook] channel token mismatch for ${userId} — rejecting`);
      return new Response("forbidden", { status: 401 });
    }

    try {
      const token = await refreshGoogleToken(userId);

      let events: any[] = [];
      let newSyncToken: string | null = null;
      let checkpoint: string | null = syncState?.checkpoint || null;

      if (checkpoint) {
        // Incremental sync. syncToken is incompatible with orderBy/timeMin/q
        // (Google returns 400), so send ONLY syncToken + paging params.
        // nextSyncToken appears on the LAST page only — follow nextPageToken
        // to the end before storing it.
        let pageToken = "";
        for (let page = 0; page < MAX_SYNC_PAGES; page++) {
          const params = new URLSearchParams({
            maxResults: "250",
            // Must match the singleEvents value used when the token was
            // captured (initial-scan / the bootstrap path below).
            singleEvents: "true",
            syncToken: checkpoint,
          });
          if (pageToken) params.set("pageToken", pageToken);

          const resp = await fetch(`${CALENDAR_EVENTS_URL}?${params}`, {
            headers: { Authorization: `Bearer ${token}` },
          });

          if (resp.status === 410) {
            // Sync token expired — clear it and fall through to the
            // bootstrap path below to rescan and capture a fresh token.
            const { error } = await supabase.from("sync_state").upsert({
              user_id: userId,
              source: "google_calendar",
              checkpoint: null,
              last_error: "Sync token expired, resyncing",
            }, { onConflict: "user_id,source" });
            if (error) {
              console.error(`[calendar-webhook] failed to clear expired sync token: ${error.message}`);
            }
            checkpoint = null;
            events = [];
            break;
          }
          if (!resp.ok) throw new Error(`Calendar API: ${resp.status}`);

          const data = await resp.json();
          events = events.concat(data.items || []);
          pageToken = data.nextPageToken || "";
          if (!pageToken) {
            newSyncToken = data.nextSyncToken || null;
            break;
          }
          if (page === MAX_SYNC_PAGES - 1) {
            // Page cap hit before the last page — process what we have; the
            // stored checkpoint stays put, so the next webhook re-fetches
            // the same changes (upserts below are idempotent).
            console.warn(`[calendar-webhook] incremental sync hit ${MAX_SYNC_PAGES}-page cap for ${userId} — checkpoint not advanced`);
          }
        }
      }

      if (!checkpoint) {
        // Bootstrap — no sync token yet (or it just expired above). One paged
        // pass both captures a fresh sync token AND returns the events it
        // fetched, so we process exactly the window the token stamps over —
        // no separate maxResults-capped scan whose cut (or the gap between
        // scan and capture) could permanently skip recent changes.
        const capture = await captureCalendarSyncToken(token, userId);
        events = capture.events;
        newSyncToken = capture.token;
      }

      for (const event of events) {
        if (event.status === "cancelled") continue;

        const start = event.start?.dateTime || event.start?.date || "";
        const isAllDay = !event.start?.dateTime;

        await supabase.from("source_messages").upsert({
          user_id: userId,
          source_type: "google_calendar",
          source_id: event.id,
          subject: event.summary || "(No title)",
          body_text: event.description || "",
          source_url: event.htmlLink,
          received_at: start || new Date().toISOString(),
          processing_status: "pending",
          ai_classification: "pending",
          ai_extraction: {
            start: event.start,
            end: event.end,
            location: event.location,
            attendees: event.attendees?.map((a: any) => a.email),
            is_all_day: isAllDay,
          },
        }, { onConflict: "user_id,source_type,source_id", ignoreDuplicates: false });
      }

      // Save new sync token / mark the sync as successful. When no token was
      // obtained this run (page cap or capture failure), still update
      // last_synced_at — omitting `checkpoint` from the payload leaves the
      // stored one untouched.
      const syncStateRow: Record<string, unknown> = {
        user_id: userId,
        source: "google_calendar",
        last_synced_at: new Date().toISOString(),
        last_error: null,
        consecutive_failures: 0,
      };
      if (newSyncToken) syncStateRow.checkpoint = newSyncToken;
      const { error: syncStateError } = await supabase
        .from("sync_state")
        .upsert(syncStateRow, { onConflict: "user_id,source" });
      if (syncStateError) {
        console.error(`[calendar-webhook] sync_state upsert failed for ${userId}: ${syncStateError.message}`);
      }
    } catch (e) {
      await supabase.from("log_entries").insert({
        user_id: userId,
        level: "error",
        category: "calendar_webhook",
        status: "failed",
        error_message: (e as Error).message,
      });
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
