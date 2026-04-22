import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  if (!cred) throw new Error(`No ${service} credentials found`);

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
      await supabase.from("user_settings").update({ drive_connected: false }).eq("user_id", userId);
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", service);

  return tokens.access_token;
}

// Export Google Docs/Sheets/Slides as plain text
const EXPORTABLE_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function fetchFileContent(token: string, fileId: string, mimeType: string): Promise<string> {
  const exportMime = EXPORTABLE_TYPES[mimeType];
  let url: string;
  if (exportMime) {
    // Google Workspace files: export as text
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
  } else if (mimeType === "text/plain" || mimeType === "text/csv" || mimeType === "text/html") {
    // Plain text files: download directly
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  } else {
    // Binary files (PDF, images, etc): skip content fetch
    return "";
  }

  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return "";
    const text = await resp.text();
    return text.substring(0, 10000); // Limit to 10KB
  } catch {
    return "";
  }
}

async function syncUserDrive(userId: string) {
  const { data: settings } = await supabase
    .from("user_settings")
    .select("drive_folder_id")
    .eq("user_id", userId)
    .single();

  const { data: syncState } = await supabase
    .from("sync_state")
    .select("*")
    .eq("user_id", userId)
    .eq("source", "google_drive")
    .single();

  if (syncState && syncState.consecutive_failures >= 5) {
    return { skipped: true, reason: "Too many failures" };
  }

  let token: string;
  try {
    token = await refreshGoogleToken(userId, "google_drive");
  } catch (e) {
    return { error: (e as Error).message };
  }

  const folderId = settings?.drive_folder_id;
  const pageToken = syncState?.checkpoint;

  // List changes or files in folder
  let url: string;
  if (pageToken) {
    url = `https://www.googleapis.com/drive/v3/changes?pageToken=${pageToken}&fields=changes(file(id,name,mimeType,modifiedTime,webViewLink)),newStartPageToken,nextPageToken`;
  } else if (folderId) {
    url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&fields=files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken&orderBy=modifiedTime+desc&pageSize=100`;
  } else {
    // Default: recent files modified in the last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    url = `https://www.googleapis.com/drive/v3/files?q=trashed=false+and+modifiedTime>'${threeMonthsAgo.toISOString()}'&fields=files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken&orderBy=modifiedTime+desc&pageSize=50`;
  }

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const errText = await resp.text();
    await supabase.from("sync_state").upsert({
      user_id: userId,
      source: "google_drive",
      last_error: `Drive API: ${resp.status} ${errText}`,
      consecutive_failures: (syncState?.consecutive_failures || 0) + 1,
    }, { onConflict: "user_id,source" });
    throw new Error(`Drive API: ${resp.status}`);
  }

  const data = await resp.json();
  const files = pageToken
    ? (data.changes || []).map((c: any) => c.file).filter(Boolean)
    : data.files || [];

  let synced = 0;
  for (const file of files) {
    if (!file.name) continue;

    // Fetch content for text-based files
    const bodyText = await fetchFileContent(token, file.id, file.mimeType || "");

    await supabase.from("source_messages").upsert({
      user_id: userId,
      source_type: "google_drive",
      source_id: file.id,
      subject: file.name,
      source_url: file.webViewLink,
      body_text: bodyText || null,
      received_at: file.modifiedTime || new Date().toISOString(),
      processing_status: "pending",
      ai_classification: "pending",
    }, { onConflict: "user_id,source_type,source_id", ignoreDuplicates: false });
    synced++;
  }

  // Save new page token
  const newToken = pageToken ? data.newStartPageToken : null;
  if (!pageToken) {
    const tokenResp = await fetch(
      "https://www.googleapis.com/drive/v3/changes/startPageToken",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (tokenResp.ok) {
      const tokenData = await tokenResp.json();
      await supabase.from("sync_state").upsert({
        user_id: userId,
        source: "google_drive",
        checkpoint: tokenData.startPageToken,
        last_synced_at: new Date().toISOString(),
        messages_synced_total: synced,
        last_error: null,
        consecutive_failures: 0,
      }, { onConflict: "user_id,source" });
    }
  } else if (newToken) {
    await supabase.from("sync_state").upsert({
      user_id: userId,
      source: "google_drive",
      checkpoint: newToken,
      last_synced_at: new Date().toISOString(),
      messages_synced_total: (syncState?.messages_synced_total || 0) + synced,
      last_error: null,
      consecutive_failures: 0,
    }, { onConflict: "user_id,source" });
  }

  return { synced };
}

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");

    if (authHeader === cronSecret || req.headers.get("x-cron-secret") === cronSecret) {
      const { data: users } = await supabase
        .from("user_settings")
        .select("user_id")
        .eq("drive_connected", true);

      const results = [];
      for (const user of users || []) {
        const result = await syncUserDrive(user.user_id);
        results.push({ user_id: user.user_id, ...result });
      }
      return new Response(JSON.stringify({ results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const result = await syncUserDrive(user.id);
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
