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

  // Get last 7 days of Gmail message IDs
  const after = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${after}&maxResults=500`,
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

  // Update historyId
  const profileResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (profileResp.ok) {
    const profile = await profileResp.json();
    await supabase.from("sync_state").upsert({
      user_id: userId,
      source: "gmail",
      checkpoint: profile.historyId,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: "user_id,source" });
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
