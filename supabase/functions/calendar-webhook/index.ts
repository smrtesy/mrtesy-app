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
    if (resp.status === 401 || resp.status === 400) {
      await supabase.from("user_settings").update({ calendar_connected: false }).eq("user_id", userId);
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", "google_calendar");

  return tokens.access_token;
}

Deno.serve(async (req) => {
  // Google sends a POST with X-Goog-Channel-ID and X-Goog-Resource-State headers
  if (req.method === "POST") {
    const channelId = req.headers.get("X-Goog-Channel-ID") || "";
    const resourceState = req.headers.get("X-Goog-Resource-State") || "";

    // channelId format: "calendar-{userId}"
    const userId = channelId.replace("calendar-", "");

    if (!userId || resourceState === "sync") {
      // Initial sync confirmation — just acknowledge
      return new Response("OK", { status: 200 });
    }

    try {
      const token = await refreshGoogleToken(userId);

      // Get sync token from sync_state
      const { data: syncState } = await supabase
        .from("sync_state")
        .select("checkpoint")
        .eq("user_id", userId)
        .eq("source", "google_calendar")
        .single();

      // Fetch recent events
      const params = new URLSearchParams({
        maxResults: "50",
        singleEvents: "true",
        orderBy: "updated",
      });
      if (syncState?.checkpoint) {
        params.set("syncToken", syncState.checkpoint);
      } else {
        // No sync token — get events from last 24h
        params.set("timeMin", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      }

      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!resp.ok) {
        // If sync token is invalid, clear it and try again next time
        if (resp.status === 410) {
          await supabase.from("sync_state").upsert({
            user_id: userId,
            source: "google_calendar",
            checkpoint: null,
            last_error: "Sync token expired, will resync",
          }, { onConflict: "user_id,source" });
          return new Response("OK", { status: 200 });
        }
        throw new Error(`Calendar API: ${resp.status}`);
      }

      const data = await resp.json();
      const events = data.items || [];

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

      // Save new sync token
      if (data.nextSyncToken) {
        await supabase.from("sync_state").upsert({
          user_id: userId,
          source: "google_calendar",
          checkpoint: data.nextSyncToken,
          last_synced_at: new Date().toISOString(),
          last_error: null,
          consecutive_failures: 0,
        }, { onConflict: "user_id,source" });
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
