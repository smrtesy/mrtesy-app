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

  // Stop existing watch (ignore errors)
  try {
    await fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: `calendar-${userId}`,
        resourceId: "primary",
      }),
    });
  } catch (_e) { /* ignore */ }

  // Create new watch
  const resp = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: `calendar-${userId}`,
        type: "web_hook",
        address: webhookUrl,
        params: { ttl: "604800" }, // 7 days
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Watch creation failed: ${resp.status} ${err}`);
  }

  const watch = await resp.json();
  return { channelId: watch.id, expiration: watch.expiration };
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
