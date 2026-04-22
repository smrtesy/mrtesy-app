import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
    if (!user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const userId = user.id;

    const { data: settings } = await supabase
      .from("user_settings")
      .select("initial_scan_started_at, initial_scan_days_back, calendar_initial_scan_months, gmail_connected, calendar_connected, drive_connected")
      .eq("user_id", userId)
      .single();

    if (settings?.initial_scan_started_at) {
      return new Response(JSON.stringify({ skipped: true, reason: "Already started" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase.from("user_settings").update({
      initial_scan_started_at: new Date().toISOString(),
    }).eq("user_id", userId);

    const daysBack = settings?.initial_scan_days_back || 30;
    const calMonths = settings?.calendar_initial_scan_months || 12;
    let gmailCount = 0;
    let calendarCount = 0;

    // ============ GMAIL SCAN — IDs only (fast) ============
    if (settings?.gmail_connected) {
      try {
        const token = await refreshGoogleToken(userId, "gmail");
        const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
        let pageToken = "";
        let allMsgIds: string[] = [];

        do {
          const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${after}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`;
          const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!resp.ok) break;
          const data = await resp.json();
          const ids = (data.messages || []).map((m: any) => m.id);
          allMsgIds = [...allMsgIds, ...ids];
          pageToken = data.nextPageToken || "";
        } while (pageToken);

        const batchSize = 500;
        for (let i = 0; i < allMsgIds.length; i += batchSize) {
          const batch = allMsgIds.slice(i, i + batchSize).map((id) => ({
            user_id: userId,
            source_type: "gmail",
            source_id: id,
            processing_status: "pending",
            ai_classification: "pending",
          }));
          if (batch.length > 0) {
            await supabase.from("source_messages").upsert(batch, {
              onConflict: "user_id,source_type,source_id",
              ignoreDuplicates: true,
            });
          }
        }
        gmailCount = allMsgIds.length;

        const profileResp = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (profileResp.ok) {
          const profile = await profileResp.json();
          await supabase.from("sync_state").upsert({
            user_id: userId, source: "gmail",
            checkpoint: profile.historyId,
            last_synced_at: new Date().toISOString(),
            messages_synced_total: gmailCount,
            consecutive_failures: 0,
          }, { onConflict: "user_id,source" });
        }
      } catch (e) {
        await supabase.from("log_entries").insert({
          user_id: userId, level: "error", category: "initial_scan_gmail",
          status: "failed", error_message: (e as Error).message,
        });
      }
    }

    // ============ CALENDAR SCAN (deduplicate recurring events) ============
    if (settings?.calendar_connected) {
      try {
        const token = await refreshGoogleToken(userId, "google_calendar");
        const timeMin = new Date();
        const timeMax = new Date();
        timeMax.setMonth(timeMax.getMonth() + Math.min(calMonths, 12));
        let pageToken = "";
        // Track recurring events — only save the first (nearest) occurrence
        const seenRecurring = new Set<string>();
        do {
          const params = new URLSearchParams({
            timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
            maxResults: "250", singleEvents: "true", orderBy: "startTime",
          });
          if (pageToken) params.set("pageToken", pageToken);
          const resp = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!resp.ok) break;
          const data = await resp.json();
          const batch = (data.items || [])
            .filter((e: any) => e.status !== "cancelled")
            .filter((event: any) => {
              // Deduplicate recurring events: keep only the first occurrence
              if (event.recurringEventId) {
                if (seenRecurring.has(event.recurringEventId)) return false;
                seenRecurring.add(event.recurringEventId);
              }
              return true;
            })
            .map((event: any) => ({
              user_id: userId, source_type: "google_calendar",
              // Use recurringEventId as source_id for recurring events (master ID)
              source_id: event.recurringEventId || event.id,
              subject: event.summary || "(No title)", source_url: event.htmlLink,
              received_at: event.start?.dateTime || event.start?.date || new Date().toISOString(),
              processing_status: "pending", ai_classification: "pending",
            }));
          if (batch.length > 0) {
            await supabase.from("source_messages").upsert(batch, {
              onConflict: "user_id,source_type,source_id", ignoreDuplicates: true,
            });
            calendarCount += batch.length;
          }
          pageToken = data.nextPageToken || "";
        } while (pageToken);

        const syncResp = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (syncResp.ok) {
          const syncData = await syncResp.json();
          if (syncData.nextSyncToken) {
            await supabase.from("sync_state").upsert({
              user_id: userId, source: "google_calendar",
              checkpoint: syncData.nextSyncToken,
              last_synced_at: new Date().toISOString(),
            }, { onConflict: "user_id,source" });
          }
        }
      } catch (e) {
        await supabase.from("log_entries").insert({
          user_id: userId, level: "error", category: "initial_scan_calendar",
          status: "failed", error_message: (e as Error).message,
        });
      }
    }

    // ============ DRIVE SYNC (server-to-server, no CORS) ============
    if (settings?.drive_connected) {
      try {
        const cronSecret = Deno.env.get("CRON_SECRET") || "";
        fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/drive-sync`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cronSecret}`,
              "Content-Type": "application/json",
            },
          }
        ).catch(() => { /* ignore */ });
      } catch { /* ignore drive errors */ }
    }

    // Mark scan + onboarding as complete
    await supabase.from("user_settings").update({
      initial_scan_completed_at: new Date().toISOString(),
      initial_setup_completed: true,
      onboarding_completed: true,
    }).eq("user_id", userId);

    await supabase.from("log_entries").insert({
      user_id: userId, category: "initial_scan", status: "ok",
      details: { gmail_ids: gmailCount, calendar_events: calendarCount },
    });

    return new Response(JSON.stringify({
      success: true, gmail_ids: gmailCount, calendar_events: calendarCount,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
