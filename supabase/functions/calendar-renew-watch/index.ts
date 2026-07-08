import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);

  const tokens = await resp.json();
  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", "google_calendar");

  return tokens.access_token;
}

async function renewWatch(userId: string) {
  const token = await refreshGoogleToken(userId);
  const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/calendar-webhook`;

  // Look up the previous channel so we can stop it cleanly. Select * to avoid
  // coupling to columns that may not exist yet (graceful pre-migration deploy).
  const { data: prev } = await supabase
    .from("sync_state")
    .select("*")
    .eq("user_id", userId)
    .eq("source", "google_calendar")
    .maybeSingle();

  // Create the NEW watch FIRST, and only stop the old channel once it exists.
  // The old stop-then-create order meant a failed creation left NO live watch
  // until the next cron run — a silent notification gap. Google allows
  // multiple simultaneous watch channels on the same calendar as long as
  // their channel ids differ (and ours are unique per renewal), so briefly
  // having both old + new alive is safe — the webhook processing is
  // idempotent anyway.
  //
  // A UNIQUE channel id every renewal also makes channelIdNotUnique
  // impossible even if a previous channel is still alive (the 6-day renew
  // cron overlaps the 7-day ttl, and stop is best-effort).
  const channelId = `calendar-${userId}-${Date.now()}`;
  // Opaque per-watch secret. Google echoes it back on every notification as the
  // X-Goog-Channel-Token header; the webhook validates it so a forged
  // X-Goog-Channel-ID alone can't trigger processing for another user.
  const channelToken = crypto.randomUUID();
  const resp = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        token: channelToken,
        params: { ttl: "604800" }, // 7 days
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    // The old channel (if any) is deliberately left running — it keeps
    // notifications flowing until the next renewal attempt succeeds.
    console.error(`[calendar-renew-watch] watch creation failed for ${userId} — keeping previous channel alive: ${resp.status} ${err}`);
    throw new Error(`Watch creation failed: ${resp.status} ${err}`);
  }

  const watch = await resp.json();

  // New watch is live — now stop the previous one using its stored channel id
  // + opaque resourceId. Google's channels.stop requires the resourceId
  // returned at creation time — NOT the calendar id "primary". Passing
  // "primary" silently fails and leaves the old channel alive, which is what
  // produced channelIdNotUnique on renew (before ids were unique).
  if (prev?.watch_channel_id && prev?.watch_resource_id) {
    try {
      await fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: prev.watch_channel_id,
          resourceId: prev.watch_resource_id,
        }),
      });
    } catch (_e) { /* best-effort cleanup — worst case the old channel expires at its ttl */ }
  }

  // Persist the new channel + resourceId so the next renewal can stop it.
  // Upsert so a missing sync_state row (user connected but never synced yet)
  // still records the channel. The watch is already live at this point, so a
  // persistence error must not fail the renewal — log it and move on.
  const { error: persistErr } = await supabase
    .from("sync_state")
    .upsert({
      user_id: userId,
      source: "google_calendar",
      watch_channel_id: channelId,
      watch_resource_id: watch.resourceId,
      watch_token: channelToken,
      watch_expiration: watch.expiration
        ? new Date(Number(watch.expiration)).toISOString()
        : null,
    }, { onConflict: "user_id,source" });
  if (persistErr) {
    console.error(`Failed to persist calendar watch state for ${userId}: ${persistErr.message}`);
  }

  return { channelId, resourceId: watch.resourceId, expiration: watch.expiration };
}

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");

    if (authHeader === cronSecret || req.headers.get("x-cron-secret") === cronSecret) {
      const { data: users } = await supabase
        .from("user_settings")
        .select("user_id")
        .eq("calendar_connected", true);

      const results = [];
      for (const user of users || []) {
        try {
          const result = await renewWatch(user.user_id);
          results.push({ user_id: user.user_id, ...result });
        } catch (e) {
          results.push({ user_id: user.user_id, error: (e as Error).message });
          await supabase.from("log_entries").insert({
            user_id: user.user_id,
            level: "error",
            category: "calendar_renew_watch",
            status: "failed",
            error_message: (e as Error).message,
          });
        }
      }
      return new Response(JSON.stringify({ results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Unauthorized", { status: 401 });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
