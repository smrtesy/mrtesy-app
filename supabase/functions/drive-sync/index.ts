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
    category: "drive_sync",
    status: "failed",
    error_message: `Drive disconnected — ${reason}. User must reconnect in Settings.`,
  }).catch(() => {});

  if (membership?.org_id) {
    // type MUST be one of the notifications CHECK values
    // ('info','warning','success','action_required'). "sync_disconnected"
    // violated the constraint and the insert was silently swallowed by the
    // .catch below — so cron-time disconnects never produced a notification.
    await supabase.from("notifications").insert({
      user_id: userId,
      org_id: membership.org_id,
      app_slug: "smrttask",
      type: "action_required",
      title: "Google Drive התנתק",
      body: `החיבור ל-Google Drive פג תוקף (${reason}). לחץ כדי להתחבר מחדש — סנכרון לא ירוץ עד שתעשה את זה.`,
      link: "/account",
    }).catch(() => {});
  }
}

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
    const err = await resp.text();
    // invalid_client = OUR client_id/secret failed to authenticate (wrong /
    // missing / out of sync with the backend + Google Cloud). NOT a user
    // revocation: do NOT flip drive_connected=false and do NOT tell the user to
    // reconnect — a fresh grant dies the same way. Just record it so the next
    // cron run self-heals once the secret is corrected. invalid_grant (and any
    // other 400/401) is a genuine dead grant → disable + notify reconnect.
    const isClientMismatch = /invalid_client/i.test(err);
    if (isClientMismatch) {
      const { data: syncState } = await supabase
        .from("sync_state")
        .select("consecutive_failures")
        .eq("user_id", userId)
        .eq("source", "google_drive")
        .maybeSingle();
      await supabase.from("sync_state").upsert({
        user_id: userId,
        source: "google_drive",
        last_error: `Token refresh failed (invalid_client — check GOOGLE_CLIENT_ID/SECRET): ${err}`.slice(0, 1000),
        consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
      }, { onConflict: "user_id,source" });
      await supabase.from("log_entries").insert({
        user_id: userId,
        level: "error",
        category: "drive_sync",
        status: "failed",
        error_message: `google_drive: invalid_client — OAuth client auth failed; check GOOGLE_CLIENT_ID/SECRET`,
      }).catch(() => {});
    } else if (resp.status === 401 || resp.status === 400) {
      await supabase.from("user_settings").update({ drive_connected: false }).eq("user_id", userId);
      // Record the error in sync_state so it's visible in admin logs
      const { data: syncState } = await supabase
        .from("sync_state")
        .select("consecutive_failures")
        .eq("user_id", userId)
        .eq("source", "google_drive")
        .maybeSingle();
      await supabase.from("sync_state").upsert({
        user_id: userId,
        source: "google_drive",
        last_error: `Token refresh failed: ${err}`,
        consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
      }, { onConflict: "user_id,source" });
      await notifyDisconnect(userId, `token refresh failed (${resp.status})`);
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

// Append authuser=EMAIL to a Google Drive/Docs URL so the browser opens it
// in the correct Google account instead of whichever is currently active.
function withAuthUser(url: string | null | undefined, email: string): string | null {
  if (!url) return null;
  if (!email) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("authuser", email);
    return u.toString();
  } catch {
    return url;
  }
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

/**
 * Expand a list of Drive folder IDs into a Set that includes every
 * descendant folder under them (BFS, paginated, sub-folder only). The
 * resulting set is what we filter file `parents` against on every sync,
 * so a file is ingested iff its direct parent appears in the set —
 * which means a file anywhere in the chosen subtree is included, but
 * nothing outside leaks in.
 *
 * Drive caps recursion depth implicitly through the page-size loop; in
 * practice folder counts are small (tens, not thousands). We re-walk
 * on every sync rather than cache: cheap, always fresh, no schema
 * change needed for the cache.
 */
async function expandFolderTree(token: string, rootIds: string[]): Promise<Set<string>> {
  const all = new Set<string>(rootIds);
  if (rootIds.length === 0) return all;

  const queue = [...rootIds];
  while (queue.length > 0) {
    // Drive's `q` parameter has a length cap (~2KB practical limit) — chunk
    // parent IDs into batches that comfortably fit.
    const batch = queue.splice(0, 25);
    const orClause = batch.map((id) => `'${id}' in parents`).join(" or ");
    const q = encodeURIComponent(
      `(${orClause}) and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );

    let pageToken: string | undefined;
    do {
      const url =
        `https://www.googleapis.com/drive/v3/files?q=${q}` +
        `&fields=files(id,parents),nextPageToken&pageSize=1000` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) break; // best-effort; missing sub-folders just means narrower scope
      const data = await resp.json();
      for (const f of data.files || []) {
        if (!all.has(f.id)) {
          all.add(f.id);
          queue.push(f.id);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return all;
}

async function syncUserDrive(userId: string) {
  const { data: settings } = await supabase
    .from("user_settings")
    .select("drive_folder_id, drive_folder_ids, drive_sync_days")
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
    const errMsg = (e as Error).message;
    await supabase.from("sync_state").upsert(
      {
        user_id: userId,
        source: "google_drive",
        last_error: errMsg,
        consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
      },
      { onConflict: "user_id,source" }
    );
    return { error: errMsg };
  }

  // Fetch the user's Google account email so we can append authuser= to Drive
  // URLs — prevents the browser opening the document in the wrong Google account.
  let googleEmail = "";
  try {
    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    googleEmail = authUser?.user?.email || "";
  } catch { /* best-effort */ }

  // drive_folder_ids (array) is the source of truth. drive_folder_id is a
  // legacy fallback for users who haven't migrated through the new UI.
  // Empty array AND null legacy column → no scanning. This matches the
  // CLAUDE.md "Drive scanning is opt-in" rule — never fall back to the
  // user's entire Drive.
  const rootIds: string[] = (settings?.drive_folder_ids && settings.drive_folder_ids.length > 0)
    ? settings.drive_folder_ids
    : (settings?.drive_folder_id ? [settings.drive_folder_id] : []);

  if (rootIds.length === 0) {
    await supabase.from("sync_state").upsert({
      user_id: userId,
      source: "google_drive",
      last_synced_at: new Date().toISOString(),
      last_error: null,
      consecutive_failures: 0,
    }, { onConflict: "user_id,source" });
    return { synced: 0, skipped: true, reason: "no folders selected" };
  }

  // Recursive descent: a file is in scope if its parent is the chosen
  // folder OR any of its descendants. Computed fresh on every run.
  const folderSet = await expandFolderTree(token, rootIds);

  const pageToken = syncState?.checkpoint;
  const syncDays: number = settings?.drive_sync_days ?? 30;
  const cutoff = new Date(Date.now() - syncDays * 86_400_000).toISOString();

  // Collected file list across all batched queries / change pages.
  let files: any[] = [];
  let newChangesToken: string | undefined;

  if (pageToken) {
    // Incremental — single /changes fetch (paginated by next cron run).
    const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${pageToken}&fields=changes(file(id,name,mimeType,modifiedTime,webViewLink,parents)),newStartPageToken,nextPageToken`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 400) {
        // Stale checkpoint after re-auth. Self-heal: clear it so the next
        // run does a fresh initial scan instead of looping on 400 forever.
        await supabase.from("sync_state").upsert({
          user_id: userId, source: "google_drive",
          checkpoint: null, last_error: null, consecutive_failures: 0,
        }, { onConflict: "user_id,source" });
        return { error: "pageToken invalid — checkpoint reset for fresh fetch" };
      }
      await supabase.from("sync_state").upsert({
        user_id: userId, source: "google_drive",
        last_error: `Drive API: ${resp.status} ${errText}`,
        consecutive_failures: (syncState?.consecutive_failures || 0) + 1,
      }, { onConflict: "user_id,source" });
      throw new Error(`Drive API: ${resp.status}`);
    }
    const data = await resp.json();
    files = (data.changes || []).map((c: any) => c.file).filter(Boolean);
    newChangesToken = data.newStartPageToken;
  } else {
    // Initial scan: batch the folder set into chunks that fit under
    // Drive's `q` length cap (~2KB) and fan out across all of them.
    // Each batch is paginated independently. The client-side filter
    // below still applies, so we always honour the recursive subtree.
    const parents = Array.from(folderSet);
    const BATCH = 25;
    for (let i = 0; i < parents.length; i += BATCH) {
      const orClause = parents.slice(i, i + BATCH).map((id) => `'${id}' in parents`).join(" or ");
      const baseQ = encodeURIComponent(
        `(${orClause}) and modifiedTime>'${cutoff}' and trashed=false`,
      );
      let batchPage: string | undefined;
      do {
        const url =
          `https://www.googleapis.com/drive/v3/files?q=${baseQ}` +
          `&fields=files(id,name,mimeType,modifiedTime,webViewLink,parents),nextPageToken` +
          `&orderBy=modifiedTime+desc&pageSize=100` +
          (batchPage ? `&pageToken=${batchPage}` : "");
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) {
          await supabase.from("sync_state").upsert({
            user_id: userId, source: "google_drive",
            last_error: `Drive API: ${resp.status} ${await resp.text()}`,
            consecutive_failures: (syncState?.consecutive_failures || 0) + 1,
          }, { onConflict: "user_id,source" });
          throw new Error(`Drive API: ${resp.status}`);
        }
        const data = await resp.json();
        files.push(...(data.files || []));
        batchPage = data.nextPageToken;
      } while (batchPage);
    }
  }

  // Drive's /changes API is account-wide and can't be scoped server-side
  // to specific folders. Enforce the user-picked subtrees client-side
  // (recursive): a file is in scope iff at least one of its `parents`
  // appears in the expanded folder set we built above. Initial scans
  // already used the same set in the `q` clause, so applying it here
  // too keeps both code paths honest to the same source of truth.
  files = files.filter(
    (f) => Array.isArray(f.parents) && f.parents.some((p: string) => folderSet.has(p)),
  );

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
      source_url: withAuthUser(file.webViewLink, googleEmail),
      body_text: bodyText || null,
      received_at: file.modifiedTime || new Date().toISOString(),
      processing_status: "pending",
      ai_classification: "pending",
    }, { onConflict: "user_id,source_type,source_id", ignoreDuplicates: false });
    synced++;
  }

  // Persist the next pageToken so subsequent runs use /changes incrementally.
  if (!pageToken) {
    const tokenResp = await fetch(
      "https://www.googleapis.com/drive/v3/changes/startPageToken",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (tokenResp.ok) {
      const tokenData = await tokenResp.json();
      await supabase.from("sync_state").upsert({
        user_id: userId, source: "google_drive",
        checkpoint: tokenData.startPageToken,
        last_synced_at: new Date().toISOString(),
        messages_synced_total: synced,
        last_error: null, consecutive_failures: 0,
      }, { onConflict: "user_id,source" });
    }
  } else if (newChangesToken) {
    await supabase.from("sync_state").upsert({
      user_id: userId, source: "google_drive",
      checkpoint: newChangesToken,
      last_synced_at: new Date().toISOString(),
      messages_synced_total: (syncState?.messages_synced_total || 0) + synced,
      last_error: null, consecutive_failures: 0,
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
