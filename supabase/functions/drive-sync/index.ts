import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { extractText, getDocumentProxy } from "npm:unpdf@1.6.2";

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
  }).then(() => {}, () => {});

  if (membership?.org_id) {
    await supabase.from("notifications").insert({
      user_id: userId,
      org_id: membership.org_id,
      app_slug: "smrttask",
      // Must be one of the notifications_type_check values
      // (info|warning|success|action_required) — anything else is silently
      // rejected by the CHECK constraint and the user never sees it.
      type: "action_required",
      title: "Google Drive disconnected",
      body: `Drive connection was lost (${reason}). Please reconnect in Settings → Connections.`,
      link: "/settings",
    }).then(({ error }) => { if (error) console.error("notifications insert failed:", error); }, () => {});
  }
}

// Mark Drive as disconnected after an unrecoverable auth failure (missing
// credentials or a dead refresh token). Sets drive_connected=false so the
// account drops out of the cron loop until the user re-OAuths, records the
// failure, and notifies the user — but ONLY on the true→false transition, so a
// dead connection never pages the user every cron tick.
async function markDriveDisconnected(userId: string, reason: string) {
  const { data: prev } = await supabase
    .from("user_settings")
    .select("drive_connected")
    .eq("user_id", userId)
    .maybeSingle();

  const { error: disconnectUpdateError } = await supabase.from("user_settings").update({ drive_connected: false }).eq("user_id", userId);
  if (disconnectUpdateError) console.error("user_settings disconnect update failed:", disconnectUpdateError);

  const { error: disconnectStateUpsertError } = await supabase.from("sync_state").upsert({
    user_id: userId,
    source: "google_drive",
    last_error: reason,
    // Reset the streak on disconnect: the counter has done its job. Leaving
    // it >=3 meant one fresh auth blip after the user re-OAuthed immediately
    // re-disconnected them (prevFailures + 1 >= 3 on the very first strike).
    consecutive_failures: 0,
  }, { onConflict: "user_id,source" });
  if (disconnectStateUpsertError) console.error("sync_state upsert failed:", disconnectStateUpsertError);

  if (prev?.drive_connected) await notifyDisconnect(userId, reason);
}

async function refreshGoogleToken(userId: string, service: string): Promise<string> {
  const { data: cred } = await supabase
    .from("user_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("service", service)
    .single();

  // "AUTH:" prefix marks an auth failure that the caller turns into a
  // disconnect (drive_connected=false + one notification) once it repeats
  // 3 ticks in a row. Transient errors throw without the prefix and are
  // retried on the next cron run.
  if (!cred) throw new Error("AUTH: no google_drive credentials found");

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
    // 401/400 from the token endpoint means the refresh token is dead — the
    // user must re-OAuth. Other statuses (429/5xx) are transient: throw plainly
    // so the run fails this tick but retries next time without disconnecting.
    if (resp.status === 401 || resp.status === 400) {
      throw new Error(`AUTH: token refresh failed (${resp.status})`);
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  const { error: credUpdateError } = await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", service);
  if (credUpdateError) console.error("user_credentials update failed:", credUpdateError);

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

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const OCR_MODEL = "claude-haiku-4-5-20251001";
const OCR_MAX_BYTES = 10 * 1024 * 1024; // 10MB raw (~13MB base64) — under the API request cap
const OCR_MAX_OUTPUT_TOKENS = 4096;
// OCR (download + base64 + a vision call per file) is heavy: a vision call on a
// multi-page scan can take ~minute, and the edge runtime caps a request at
// ~150s wall-clock (HTTP 546). Cap OCR per run AND time-box each call so one
// slow/hung file can't consume the whole budget; the rest drain on later runs.
const OCR_MAX_PER_RUN = 2;
const OCR_DOWNLOAD_TIMEOUT_MS = 25_000;
const OCR_API_TIMEOUT_MS = 50_000;
// Worst case per run ≈ OCR_MAX_PER_RUN × (download + api) ≈ 2 × 75s = 150s, but
// downloads are near-instant in practice, so realistic worst is ≈ 2 × 50s, well
// under the runtime's ~150s wall-clock ceiling.
// Longest an OCR call can occupy (both legs time-boxed). syncUserDrive refuses to
// START an OCR that couldn't finish before the invocation deadline, so no single
// op can push the request past the edge kill.
const OCR_WORST_MS = OCR_DOWNLOAD_TIMEOUT_MS + OCR_API_TIMEOUT_MS; // 75s
// Invocation-wide wall-clock ceiling, shared across all users in one request and
// across self-kick chaining (each invocation gets its own). Set below the ~150s
// edge kill with headroom so a bounded op started just under it still finishes.
const SYNC_DEADLINE_MS = 130_000;

// fetch() with a hard timeout — aborts (and the await rejects, caught by the
// caller) instead of hanging until the platform kills the whole invocation.
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Haiku $/MTok — matches the haiku branch of ai-process estimateCost so the
// drive_ocr rows in ai_usage cost the same as everything else in the ledger.
function estimateHaikuCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 0.80 + outputTokens * 4) / 1_000_000;
}

// Scanned PDFs (ScanSnap and similar) and photos are image-only: they have no
// text layer, so fetchFileContent returns "" and the document reaches
// ai-process with an empty body and never becomes a task. Hand the raw bytes
// to a vision-capable model and return the transcription, which gets stored as
// body_text — the contract ai-process consumes.
//
// Return contract distinguishes two kinds of "no text":
//   • ""   → definitively no text (model said NO_TEXT, unsupported type, missing
//            key, oversized). The file IS done — the caller writes a row so it's
//            never re-processed.
//   • null → TRANSIENT failure (download/API error or timeout). The file is NOT
//            done — the caller must skip the upsert and retry it on a later pass,
//            so a one-off blip can't silently drop a scanned document.
async function ocrBinaryFile(
  token: string,
  fileId: string,
  mimeType: string,
  fileName: string,
  userId: string,
  sizeBytes?: number,
): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return ""; // OCR unconfigured — ingest with empty body rather than retry forever
  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType.startsWith("image/");
  if (!isPdf && !isImage) return "";
  if (sizeBytes && sizeBytes > OCR_MAX_BYTES) return "";

  let base64: string;
  try {
    const resp = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
      OCR_DOWNLOAD_TIMEOUT_MS,
    );
    // 5xx/429 are transient (retry); 4xx (403/404/etc) is permanent — the file
    // won't become fetchable, so mark it done ("") rather than retry forever.
    if (!resp.ok) return (resp.status >= 500 || resp.status === 429) ? null : "";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > OCR_MAX_BYTES) return "";
    base64 = encodeBase64(bytes);
  } catch {
    return null; // transient network error — retry next pass
  }

  const mediaBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };

  try {
    const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        max_tokens: OCR_MAX_OUTPUT_TOKENS,
        messages: [{
          role: "user",
          content: [
            mediaBlock,
            {
              type: "text",
              text:
                `Transcribe ALL text in this document ("${fileName}") as plain text. ` +
                `Preserve names, dates, monetary amounts, reference / case / invoice numbers, ` +
                `addresses and any URLs exactly as written — do not summarize or paraphrase. ` +
                `For forms, keep each field label next to its value. ` +
                `Output only the transcribed text. If there is no readable text, output exactly NO_TEXT.`,
            },
          ],
        }],
      }),
    }, OCR_API_TIMEOUT_MS);
    // 5xx/429 are transient (retry); 4xx (e.g. 400 on a malformed PDF) is
    // permanent — mark done ("") so a poison file can't loop the drain forever.
    if (!resp.ok) return (resp.status >= 500 || resp.status === 429) ? null : "";
    const data = await resp.json();
    const text: string = (data.content?.[0]?.text || "").trim();

    // Best-effort cost ledger row (mirrors ai-process). Never blocks the sync.
    try {
      const { error: ocrUsageInsertError } = await supabase.from("ai_usage").insert({
        user_id: userId,
        provider: "anthropic",
        component: "drive_ocr",
        model: OCR_MODEL,
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
        cache_read_tokens: data.usage?.cache_read_input_tokens || 0,
        cache_write_tokens: data.usage?.cache_creation_input_tokens || 0,
        cost_usd: estimateHaikuCost(data.usage?.input_tokens || 0, data.usage?.output_tokens || 0),
        ref_id: fileId,
      });
      if (ocrUsageInsertError) console.error("ai_usage insert failed:", ocrUsageInsertError);
    } catch { /* ledger must not break the pipeline */ }

    if (!text || text === "NO_TEXT") return ""; // genuinely no readable text — done
    return text.substring(0, 10000);
  } catch {
    return null; // transient error (network/parse) — retry next pass
  }
}

// ScanSnap and virtually every "scan to searchable PDF" tool embed an OCR text
// layer (invisible text drawn over the page image). When that layer exists the
// text is already there for free: extracting it is a cheap local parse — no
// vision model, no per-run OCR cap, no ~150s edge timeout risk. Try this first
// and only fall back to vision OCR for image-only PDFs that carry no text.
// Best-effort: any failure (download error, encrypted/corrupt PDF, no text)
// returns "" so the caller degrades to the existing OCR path exactly as before.
const PDF_TEXT_LAYER_MIN_CHARS = 20;
// Cap the pdf.js parse itself: the download is already time-boxed, but a large
// or malformed PDF can make pdf.js spin. A caught exception returns "" (fine),
// but a slow parse isn't interruptible on its own — race it against a timer so
// it can't eat into the run's wall-clock budget.
const PDF_PARSE_TIMEOUT_MS = 15_000;
// Longest a text-layer probe can occupy: the download (time-boxed) plus the
// raced parse. Same purpose as OCR_WORST_MS — used to refuse to start a probe
// that couldn't finish before the invocation deadline.
const TEXTLAYER_WORST_MS = OCR_DOWNLOAD_TIMEOUT_MS + PDF_PARSE_TIMEOUT_MS; // 40s

async function extractPdfTextLayer(
  token: string,
  fileId: string,
  sizeBytes?: number,
): Promise<string> {
  if (sizeBytes && sizeBytes > OCR_MAX_BYTES) return "";

  let bytes: Uint8Array;
  try {
    const resp = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
      OCR_DOWNLOAD_TIMEOUT_MS,
    );
    if (!resp.ok) return "";
    bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > OCR_MAX_BYTES) return "";
  } catch {
    return "";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const parse = (async () => {
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join(" ") : (text || "");
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PDF_PARSE_TIMEOUT_MS);
    });
    const raw = await Promise.race([parse, timeout]);
    if (raw === null) return ""; // parse timed out → fall back to vision OCR
    const clean = raw.replace(/\s+/g, " ").trim();
    // Too little text ⇒ treat as an image-only scan and let vision OCR handle it.
    if (clean.length < PDF_TEXT_LAYER_MIN_CHARS) return "";
    return clean.substring(0, 10000); // same 10KB cap as fetchFileContent / OCR
  } catch {
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

async function syncUserDrive(userId: string, deadline: number) {
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

  // No permanent circuit-breaker here: a brief failure streak (e.g. a
  // transient missing-credentials window) must never brick Drive sync forever.
  // Repeated auth failures flip drive_connected=false (so the account leaves
  // the loop until the user re-OAuths) and transient failures simply retry
  // next tick — either way a reconnected user recovers automatically.
  let token: string;
  try {
    token = await refreshGoogleToken(userId, "google_drive");
  } catch (e) {
    const errMsg = (e as Error).message;
    if (errMsg.startsWith("AUTH:")) {
      // Auth failure — but do NOT disconnect on the first one. Google returns
      // transient 400/401s from the token endpoint, and a single blip used to
      // flip drive_connected=false and silently kill Drive sync. Same 3-strike
      // policy as gmail-sync: count consecutive failures in sync_state and
      // only disconnect + notify after DISCONNECT_AFTER_FAILURES in a row;
      // any successful run resets the counter (below and at the end of sync).
      const DISCONNECT_AFTER_FAILURES = 3;
      // consecutive_failures is shared with the transient paths (network /
      // 5xx also increment it), so treat the stored count as AUTH strikes
      // only when the previous failure was itself an auth failure — i.e. the
      // stored last_error carries the "AUTH:" prefix. Otherwise 2 network
      // blips + 1 auth blip would disconnect instantly.
      const prevFailures =
        typeof syncState?.last_error === "string" && syncState.last_error.startsWith("AUTH:")
          ? (syncState?.consecutive_failures ?? 0)
          : 0;
      if (prevFailures + 1 >= DISCONNECT_AFTER_FAILURES) {
        // Unrecoverable auth failure → disconnect + notify once, then drop out.
        await markDriveDisconnected(userId, errMsg.slice(5).trim());
      } else {
        const { error: authFailUpsertError } = await supabase.from("sync_state").upsert(
          {
            user_id: userId,
            source: "google_drive",
            last_error: `${errMsg} — attempt ${prevFailures + 1}/${DISCONNECT_AFTER_FAILURES} before disconnect`,
            consecutive_failures: prevFailures + 1,
          },
          { onConflict: "user_id,source" }
        );
        if (authFailUpsertError) console.error("sync_state upsert failed:", authFailUpsertError);
      }
    } else {
      // Transient (network / 5xx / rate limit) → record and retry next run.
      const { error: tokenFailUpsertError } = await supabase.from("sync_state").upsert(
        {
          user_id: userId,
          source: "google_drive",
          last_error: errMsg,
          consecutive_failures: (syncState?.consecutive_failures ?? 0) + 1,
        },
        { onConflict: "user_id,source" }
      );
      if (tokenFailUpsertError) console.error("sync_state upsert failed:", tokenFailUpsertError);
    }
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
    const { error: noFoldersUpsertError } = await supabase.from("sync_state").upsert({
      user_id: userId,
      source: "google_drive",
      last_synced_at: new Date().toISOString(),
      last_error: null,
      consecutive_failures: 0,
    }, { onConflict: "user_id,source" });
    if (noFoldersUpsertError) console.error("sync_state upsert failed:", noFoldersUpsertError);
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
  // The Drive checkpoint to persist after this run. Always moves forward so we
  // never re-stall on an old token.
  let nextCheckpoint: string | undefined;

  if (pageToken) {
    // Incremental — walk the /changes feed from our saved checkpoint.
    // /changes is paginated: only the FINAL page carries newStartPageToken,
    // while intermediate pages carry nextPageToken. The previous version
    // fetched a single page and only advanced the checkpoint when
    // newStartPageToken was present — so an account with a backlog of changes
    // got stuck replaying page 1 forever and never ingested newer files.
    // Follow nextPageToken (capped per run) and ALWAYS persist a forward
    // checkpoint: newStartPageToken when we reach the end, otherwise the next
    // page token so the following cron run resumes where we left off.
    const MAX_PAGES = 10;
    let cursor: string | undefined = pageToken;
    let pages = 0;
    while (cursor && pages < MAX_PAGES) {
      const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${cursor}` +
        `&fields=changes(file(id,name,mimeType,modifiedTime,webViewLink,parents,size)),newStartPageToken,nextPageToken` +
        `&pageSize=100`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        const errText = await resp.text();
        if (resp.status === 400) {
          // Stale checkpoint after re-auth. Self-heal: clear it so the next
          // run does a fresh initial scan instead of looping on 400 forever.
          const { error: checkpointResetError } = await supabase.from("sync_state").upsert({
            user_id: userId, source: "google_drive",
            checkpoint: null, last_error: null, consecutive_failures: 0,
          }, { onConflict: "user_id,source" });
          if (checkpointResetError) console.error("sync_state checkpoint reset failed:", checkpointResetError);
          return { error: "pageToken invalid — checkpoint reset for fresh fetch" };
        }
        const { error: changesFailUpsertError } = await supabase.from("sync_state").upsert({
          user_id: userId, source: "google_drive",
          last_error: `Drive API: ${resp.status} ${errText}`,
          consecutive_failures: (syncState?.consecutive_failures || 0) + 1,
        }, { onConflict: "user_id,source" });
        if (changesFailUpsertError) console.error("sync_state upsert failed:", changesFailUpsertError);
        throw new Error(`Drive API: ${resp.status}`);
      }
      const data = await resp.json();
      files.push(...((data.changes || []).map((c: any) => c.file).filter(Boolean)));
      pages++;
      if (data.newStartPageToken) { nextCheckpoint = data.newStartPageToken; break; }
      cursor = data.nextPageToken;
    }
    // Capped before reaching the end → resume from the page we stopped at.
    // If a malformed page returns neither token, fall back to the incoming
    // checkpoint so we re-write (never silently skip persistence) and retry
    // the same token next tick rather than re-stalling on it.
    if (!nextCheckpoint) nextCheckpoint = cursor ?? pageToken;
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
          `&fields=files(id,name,mimeType,modifiedTime,webViewLink,parents,size),nextPageToken` +
          `&orderBy=modifiedTime+desc&pageSize=100` +
          (batchPage ? `&pageToken=${batchPage}` : "");
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) {
          const { error: scanFailUpsertError } = await supabase.from("sync_state").upsert({
            user_id: userId, source: "google_drive",
            last_error: `Drive API: ${resp.status} ${await resp.text()}`,
            consecutive_failures: (syncState?.consecutive_failures || 0) + 1,
          }, { onConflict: "user_id,source" });
          if (scanFailUpsertError) console.error("sync_state upsert failed:", scanFailUpsertError);
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

  // Source ids we've already handled in a previous run. A drive row only gets
  // written once a file has been fully processed (text-layer extracted or vision
  // OCR attempted) — deferred files are `continue`d before the upsert and have no
  // row yet — so "a row exists" means "done, skip it." This lets a backlog drain
  // across runs without re-downloading finished files, and (unlike the old
  // body_text-not-null check) also skips scans whose OCR legitimately yielded no
  // text, so a blank/low-text page can't be re-transcribed forever and wedge the
  // self-draining loop below.
  const ocrFileIds = files
    .filter((f) => f.id && (f.mimeType === "application/pdf" || (f.mimeType || "").startsWith("image/")))
    .map((f) => f.id);
  const alreadyOcred = new Set<string>();
  if (ocrFileIds.length > 0) {
    const { data: doneRows } = await supabase
      .from("source_messages")
      .select("source_id")
      .eq("user_id", userId)
      .eq("source_type", "google_drive")
      .in("source_id", ocrFileIds);
    for (const r of doneRows || []) alreadyOcred.add(r.source_id);
  }

  let synced = 0;
  let ocrCount = 0;
  // True if we left files unprocessed this run (OCR cap or wall-clock deadline) —
  // tells the checkpoint logic to hold position AND the handler to self-kick so
  // the rest drains immediately instead of waiting for the next scheduled tick.
  let deferred = false;
  // `deadline` is INVOCATION-level (passed in), shared across every user in this
  // request — the edge runtime's ~150s hard kill (HTTP 546) is per-invocation,
  // not per-user, so a per-user budget would give a false guarantee when many
  // users are processed in one loop. Once the shared deadline passes, each
  // remaining user's loop breaks on its first iteration with `deferred=true` and
  // the self-kick picks them up. Cheap text-layer files fly through; the deadline
  // mainly guards against a large OCR/parse backlog overrunning the ceiling.
  for (const file of files) {
    if (!file.name) continue;
    if (Date.now() >= deadline) { deferred = true; break; }

    // Text-based files (Docs/Sheets/plain text) export directly. Binary files
    // with no text layer (scanned PDFs, images) come back empty here, so fall
    // back to vision OCR — otherwise scanned documents never produce a task.
    let bodyText = await fetchFileContent(token, file.id, file.mimeType || "");
    // PDFs come back empty from fetchFileContent (binary → skipped). Before
    // paying for vision OCR, try the embedded OCR text layer that ScanSnap and
    // similar scanners already produce. This path is cheap (local parse, no model
    // call) and is bounded only by the wall-clock budget above, so a batch of
    // searchable PDFs ingests without touching the OCR cap — only genuinely
    // image-only PDFs fall through to the capped vision OCR below.
    if (!bodyText && file.mimeType === "application/pdf") {
      // Already handled on a prior run — don't fetch it again.
      if (alreadyOcred.has(file.id)) continue;
      // Don't START a probe that couldn't finish before the deadline.
      if (Date.now() + TEXTLAYER_WORST_MS > deadline) { deferred = true; break; }
      bodyText = await extractPdfTextLayer(
        token, file.id,
        file.size != null ? Number(file.size) : undefined,
      );
    }
    if (!bodyText) {
      const isBinary = file.mimeType === "application/pdf" || (file.mimeType || "").startsWith("image/");
      if (isBinary) {
        // Already handled on a prior run — don't pay for it again.
        if (alreadyOcred.has(file.id)) continue;
        // Per-run OCR budget spent — defer this file to the next (self-kicked) run.
        if (ocrCount >= OCR_MAX_PER_RUN) { deferred = true; continue; }
        // Don't START a vision-OCR call that couldn't finish before the deadline
        // (its worst case is ~75s) — this is what bounds the single-iteration tail
        // and keeps the whole invocation under the ~150s edge kill.
        if (Date.now() + OCR_WORST_MS > deadline) { deferred = true; break; }
        // Count the attempt (the expensive part), not just success, so the
        // per-run compute budget holds even when a file yields no text.
        ocrCount++;
        const ocrResult = await ocrBinaryFile(
          token, file.id, file.mimeType || "", file.name, userId,
          file.size != null ? Number(file.size) : undefined,
        );
        // null = transient failure (download/API) → leave the file unprocessed
        // (no row) and defer, so it retries next pass instead of being silently
        // marked done with no text. "" (no text) falls through to the upsert.
        if (ocrResult === null) { deferred = true; continue; }
        bodyText = ocrResult;
      }
    }

    const { error: fileUpsertError } = await supabase.from("source_messages").upsert({
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
    if (fileUpsertError) console.error(`drive-sync file upsert failed (${file.id}):`, fileUpsertError);
    synced++;
  }

  // Advance the checkpoint only once the backlog is drained. While work is
  // deferred we leave the position untouched (omit `checkpoint` from the upsert
  // so it keeps its current value) — the remaining files then reappear on the
  // next run and get processed. Initial scan → startPageToken (go
  // incremental); incremental → the next /changes token.
  let checkpointToWrite: string | null | undefined; // undefined = leave unchanged
  if (!deferred) {
    if (!pageToken) {
      const tokenResp = await fetch(
        "https://www.googleapis.com/drive/v3/changes/startPageToken",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (tokenResp.ok) checkpointToWrite = (await tokenResp.json()).startPageToken;
    } else if (nextCheckpoint) {
      checkpointToWrite = nextCheckpoint;
    }
  }

  const stateUpdate: Record<string, unknown> = {
    user_id: userId,
    source: "google_drive",
    last_synced_at: new Date().toISOString(),
    messages_synced_total: (pageToken ? (syncState?.messages_synced_total || 0) : 0) + synced,
    last_error: null,
    consecutive_failures: 0,
  };
  if (checkpointToWrite !== undefined) stateUpdate.checkpoint = checkpointToWrite;
  const { error: stateUpsertError } = await supabase.from("sync_state").upsert(stateUpdate, { onConflict: "user_id,source" });
  if (stateUpsertError) console.error("sync_state upsert failed:", stateUpsertError);

  return { synced, deferred };
}

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const cronSecret = Deno.env.get("CRON_SECRET");

    if (authHeader === cronSecret || req.headers.get("x-cron-secret") === cronSecret) {
      // A self-kick (below) carries how many times we've already chained (so a
      // runaway can't loop forever) and which users still had a backlog (so we
      // re-sync only those, not every connected account). The scheduled cron
      // sends no body → iteration 0, no filter → all users.
      let drainIteration = 0;
      let onlyUserIds: string[] | null = null;
      try {
        const body = await req.json();
        if (body && typeof body.drainIteration === "number") drainIteration = body.drainIteration;
        if (body && Array.isArray(body.onlyUserIds) && body.onlyUserIds.length > 0) {
          onlyUserIds = body.onlyUserIds.filter((v: unknown) => typeof v === "string");
        }
      } catch { /* no/invalid body — treat as a fresh scheduled run */ }

      let usersQuery = supabase
        .from("user_settings")
        .select("user_id")
        .eq("drive_connected", true);
      if (onlyUserIds) usersQuery = usersQuery.in("user_id", onlyUserIds);
      const { data: users } = await usersQuery;

      // Invocation-wide deadline shared by every user processed in THIS request.
      const deadline = Date.now() + SYNC_DEADLINE_MS;

      const results = [];
      for (const user of users || []) {
        // The invocation deadline is shared. Once it passes, don't even START the
        // next user's pre-loop Drive fetching (token refresh, folder tree, up to
        // 10 /changes pages — all untimed) — that stacked work is what could push
        // the request past the ~150s edge kill. Mark them deferred so the
        // self-kick drains them on the next invocation with a fresh deadline.
        if (Date.now() >= deadline) { results.push({ user_id: user.user_id, deferred: true }); continue; }
        // Isolate per-user: a throw from one account (e.g. a Drive API error)
        // must not abort the sync for everyone after it in the loop.
        try {
          const result = await syncUserDrive(user.user_id, deadline);
          results.push({ user_id: user.user_id, ...result });
        } catch (e) {
          results.push({ user_id: user.user_id, error: (e as Error).message });
        }
      }

      // Immediate self-drain: re-invoke ourselves right away for the users that
      // still have a backlog (OCR cap or the wall-clock deadline stopped this
      // pass), instead of waiting ~6h for the next scheduled tick — so a batch of
      // scans finishes in minutes. MAX_DRAIN_ITERATIONS is a hard stop against a
      // runaway loop; the scheduled cron is always the backstop underneath.
      const MAX_DRAIN_ITERATIONS = 30;
      const deferredUserIds = results
        .filter((r) => (r as { deferred?: boolean }).deferred === true)
        .map((r) => r.user_id);
      if (deferredUserIds.length > 0 && drainIteration < MAX_DRAIN_ITERATIONS) {
        const selfUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/drive-sync`;
        const kick = fetch(selfUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cronSecret}` },
          body: JSON.stringify({ drainIteration: drainIteration + 1, onlyUserIds: deferredUserIds }),
        }).then(() => {}, () => {});
        // Keep the request alive past the Response so the kick is actually sent
        // (a bare fire-and-forget fetch can be cancelled when the handler returns).
        try { (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(kick); } catch { /* waitUntil unavailable — fetch was still initiated */ }
      }

      return new Response(JSON.stringify({ results, drainIteration }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const result = await syncUserDrive(user.id, Date.now() + SYNC_DEADLINE_MS);
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
