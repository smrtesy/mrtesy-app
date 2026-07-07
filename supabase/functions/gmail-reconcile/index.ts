import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseSkipRules } from "../_shared/rule-filters.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

  if (!cred) throw new Error("No Gmail credentials");

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

  if (!resp.ok) throw new Error(`Token refresh: ${resp.status}`);
  const tokens = await resp.json();

  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", "gmail");

  return tokens.access_token;
}

async function reconcileUser(userId: string) {
  const token = await refreshGoogleToken(userId);

  // Get last 7 days of Gmail message IDs. Scope the query the same way the
  // live sync (gmail-sync) and initial-scan do: restrict to the inbox, exclude
  // drafts, and apply the user's skip-rule query filters. Without this the
  // reconcile sweep would re-ingest archived/non-inbox mail and resurrect
  // exactly the senders/subjects the user has skip rules for — and because it
  // runs daily, it would do so every morning.
  const skipFilter = await loadSkipRules(userId);
  const after = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const queryParts = [`after:${after}`, "in:inbox", "-in:drafts", ...skipFilter.gmailQueryFilters];
  const q = encodeURIComponent(queryParts.join(" "));
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=500`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) throw new Error(`Gmail API: ${resp.status}`);
  const data = await resp.json();
  const gmailIds = new Set((data.messages || []).map((m: any) => m.id));

  // Get DB message IDs for the same period
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: dbMessages } = await supabase
    .from("source_messages")
    .select("source_id")
    .eq("user_id", userId)
    .eq("source_type", "gmail")
    .gte("received_at", sevenDaysAgo);

  const dbIds = new Set((dbMessages || []).map((m) => m.source_id));

  // Find missing messages (in Gmail but not in DB)
  const missing = [...gmailIds].filter((id) => !dbIds.has(id));

  if (missing.length === 0) {
    return { missing: 0 };
  }

  // Insert missing IDs as pending
  const batch = missing.map((id) => ({
    user_id: userId,
    source_type: "gmail",
    source_id: id,
    processing_status: "pending",
    ai_classification: "pending",
  }));

  await supabase.from("source_messages").upsert(batch, {
    onConflict: "user_id,source_type,source_id",
    ignoreDuplicates: true,
  });

  // Bootstrap the historyId checkpoint ONLY when none exists yet (first run).
  // Overwriting an existing checkpoint here discarded gmail-sync's position —
  // anything between the old checkpoint and now that is not in:inbox within
  // the last 7 days was skipped forever (real mail loss). gmail-sync owns the
  // checkpoint; reconcile must never move it forward.
  const { data: existingState } = await supabase
    .from("sync_state")
    .select("checkpoint")
    .eq("user_id", userId)
    .eq("source", "gmail")
    .maybeSingle();
  if (!existingState?.checkpoint) {
    const profileResp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (profileResp.ok) {
      const profile = await profileResp.json();
      const { error: checkpointBootstrapError } = await supabase.from("sync_state").upsert({
        user_id: userId,
        source: "gmail",
        checkpoint: profile.historyId,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      }, { onConflict: "user_id,source" });
      if (checkpointBootstrapError) console.error("sync_state checkpoint bootstrap failed:", checkpointBootstrapError);
    }
  }

  await supabase.from("log_entries").insert({
    user_id: userId,
    category: "gmail_reconcile",
    status: "ok",
    details: { missing_found: missing.length, total_gmail: gmailIds.size, total_db: dbIds.size },
  });

  return { missing: missing.length, total_gmail: gmailIds.size, total_db: dbIds.size };
}

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");

    if (authHeader !== cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { data: users } = await supabase
      .from("user_settings")
      .select("user_id")
      .eq("gmail_connected", true);

    const results = [];
    for (const user of users || []) {
      try {
        const result = await reconcileUser(user.user_id);
        results.push({ user_id: user.user_id, ...result });
      } catch (e) {
        results.push({ user_id: user.user_id, error: (e as Error).message });
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
