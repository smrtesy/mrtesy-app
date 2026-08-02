/**
 * Google Drive catalog scanner — machine endpoint (x-cron-secret gated).
 *
 * Builds a full, resumable inventory of a Drive subtree into `drive_catalog`,
 * running entirely server-side on the user's stored google_drive OAuth grant
 * (via getOAuthClient/getDriveClient) — ZERO agent tokens, and independent of
 * any interactive claude.ai connector.
 *
 * Resumability is DB-backed, not in-memory: each folder row carries
 * `folder_expanded`. One "scan" call pulls a batch of not-yet-expanded folders,
 * lists each folder's direct children via the Drive API, upserts a row per
 * child (folders start unexpanded → they get picked up on a later pass), and
 * flips the parent's `folder_expanded=true`. A pass is time-boxed; if work
 * remains it self-kicks (fire-and-forget re-POST) so the whole subtree drains
 * on the server without waiting for the caller — mirroring the drive-sync
 * self-drain. A MAX_ITERATIONS guard is the runaway backstop.
 *
 * POST /drive-catalog/scan   { user_id, root_folder_id, max_seconds?, iteration? }
 * GET  /drive-catalog/status ?root_folder_id=...
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { drive_v3 } from "googleapis";
import { db } from "../../../db";
import { getDriveClient } from "../../../services/drive";

const router = Router();

// Per-pass wall-clock budget. Kept well under typical proxy/request timeouts;
// the self-kick continues the walk in a fresh request when this is hit.
const DEFAULT_MAX_SECONDS = 45;
// Runaway backstop for the self-kick chain (a huge tree is thousands of
// folders; 5000 passes at one folder-batch each is far more than any real
// Drive needs, while still finite).
const MAX_ITERATIONS = 5000;
// How many folders to expand per DB round before re-checking the clock.
const FOLDERS_PER_BATCH = 5;
// A folder whose listing keeps failing is retried at most this many times
// across the whole scan, then given up (folder_expanded=true + expand_error) so
// it leaves the frontier and the self-kicking chain can terminate instead of
// busy-looping the Drive API forever.
const MAX_FOLDER_ATTEMPTS = 10;
// Small relief after a failed listing so a rate-limit (429) storm isn't fed by
// a tight retry loop.
const FAIL_BACKOFF_MS = 400;

const FOLDER_MIME = "application/vnd.google-apps.folder";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function requireSecret(req: Request, res: Response): boolean {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

/** Bucket a Drive mimeType into a coarse, searchable `kind`. */
function kindOf(mimeType: string | null | undefined): string {
  const m = mimeType ?? "";
  if (m === FOLDER_MIME) return "folder";
  if (m === "application/vnd.google-apps.document") return "document";
  if (m === "application/vnd.google-apps.spreadsheet") return "spreadsheet";
  if (m === "application/vnd.google-apps.presentation") return "presentation";
  if (m === "application/vnd.google-apps.form") return "form";
  if (m === "application/vnd.google-apps.shortcut" || m === "application/x-ms-shortcut") return "shortcut";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image"; // includes image/x-photoshop (psd)
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    m === "application/msword"
  )
    return "document";
  if (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "text/csv"
  )
    return "spreadsheet";
  if (
    m === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  )
    return "presentation";
  if (m === "application/zip" || m === "application/x-rar-compressed" || m === "application/x-7z-compressed")
    return "archive";
  return "other";
}

interface ParentRow {
  file_id: string;
  path: string | null;
  depth: number | null;
  expand_attempts: number | null;
}

/** Row shape written to drive_catalog for one Drive child node. */
function toRow(
  userId: string,
  rootId: string,
  parent: ParentRow,
  f: {
    id?: string | null;
    name?: string | null;
    mimeType?: string | null;
    size?: string | null;
    createdTime?: string | null;
    modifiedTime?: string | null;
    fileExtension?: string | null;
    webViewLink?: string | null;
    owners?: Array<{ emailAddress?: string | null }> | null;
  },
) {
  const isFolder = f.mimeType === FOLDER_MIME;
  const parentPath = parent.path ? `${parent.path}/` : "";
  return {
    user_id: userId,
    root_folder_id: rootId,
    file_id: f.id ?? "",
    parent_id: parent.file_id,
    title: f.name ?? null,
    mime_type: f.mimeType ?? null,
    is_folder: isFolder,
    kind: kindOf(f.mimeType),
    path: `${parentPath}${f.name ?? ""}`,
    depth: (parent.depth ?? 0) + 1,
    owner: f.owners?.[0]?.emailAddress ?? null,
    file_size: f.size != null ? Number(f.size) : null,
    file_extension: f.fileExtension ?? null,
    created_time: f.createdTime ?? null,
    modified_time: f.modifiedTime ?? null,
    view_url: f.webViewLink ?? null,
    folder_expanded: false,
  };
}

const CHILD_FIELDS =
  "nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, fileExtension, webViewLink, owners(emailAddress))";

/** Fire-and-forget re-POST to continue the walk in a fresh request. */
function selfKick(baseUrl: string, secret: string, body: Record<string, unknown>): void {
  if (typeof fetch !== "function") return;
  fetch(`${baseUrl}/api/drive-catalog/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": secret },
    body: JSON.stringify(body),
  }).then(
    () => {},
    () => {},
  );
}

router.post("/drive-catalog/scan", async (req: Request, res: Response) => {
  if (!requireSecret(req, res)) return;

  const body = req.body ?? {};
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const rootId = typeof body.root_folder_id === "string" ? body.root_folder_id.trim() : "";
  if (!userId || !rootId) {
    return res.status(400).json({ error: "user_id and root_folder_id are required" });
  }
  const iteration = typeof body.iteration === "number" ? body.iteration : 0;
  const maxSeconds =
    typeof body.max_seconds === "number" && body.max_seconds > 0 && body.max_seconds <= 120
      ? body.max_seconds
      : DEFAULT_MAX_SECONDS;

  let drive: drive_v3.Drive;
  try {
    drive = await getDriveClient(userId);
  } catch (e) {
    return res.status(400).json({ error: `drive auth failed: ${(e as Error).message}` });
  }

  // Seed the root node + scan-state row on the first pass (idempotent).
  const { data: scanRow, error: scanReadErr } = await db
    .from("drive_catalog_scans")
    .select("root_folder_id, status")
    .eq("root_folder_id", rootId)
    .maybeSingle();
  // Fail closed on a transient read error rather than treating it as "unseeded"
  // and re-upserting the scan row back to status='inventory' (which would flip a
  // finished scan's reported status).
  if (scanReadErr) return res.status(500).json({ error: `scan read failed: ${scanReadErr.message}` });

  if (!scanRow) {
    let rootTitle = rootId;
    try {
      const meta = await drive.files.get({
        fileId: rootId,
        fields: "id, name, mimeType",
        supportsAllDrives: true,
      });
      rootTitle = meta.data.name ?? rootId;
    } catch (e) {
      return res.status(400).json({ error: `cannot access root folder: ${(e as Error).message}` });
    }
    const { error: rootErr } = await db.from("drive_catalog").upsert(
      {
        user_id: userId,
        root_folder_id: rootId,
        file_id: rootId,
        parent_id: null,
        title: rootTitle,
        mime_type: FOLDER_MIME,
        is_folder: true,
        kind: "folder",
        path: rootTitle,
        depth: 0,
        folder_expanded: false,
      },
      { onConflict: "root_folder_id,file_id", ignoreDuplicates: true },
    );
    if (rootErr) return res.status(500).json({ error: `root insert failed: ${rootErr.message}` });
    const { error: scanErr } = await db
      .from("drive_catalog_scans")
      .upsert(
        { root_folder_id: rootId, user_id: userId, root_title: rootTitle, status: "inventory" },
        { onConflict: "root_folder_id" },
      );
    if (scanErr) return res.status(500).json({ error: `scan seed failed: ${scanErr.message}` });
  } else if (scanRow.status === "inventory_done" || scanRow.status === "done") {
    return res.json({ ok: true, done: true, status: scanRow.status, note: "already complete" });
  }

  const deadline = Date.now() + maxSeconds * 1000;
  let foldersExpanded = 0;
  let childrenSeen = 0;
  let done = false;

  while (Date.now() < deadline) {
    // Pull a small batch of shallowest not-yet-expanded folders.
    const { data: folders, error: qErr } = await db
      .from("drive_catalog")
      .select("file_id, path, depth, expand_attempts")
      .eq("root_folder_id", rootId)
      .eq("is_folder", true)
      .eq("folder_expanded", false)
      .order("depth", { ascending: true })
      .limit(FOLDERS_PER_BATCH);
    if (qErr) return res.status(500).json({ error: `queue query failed: ${qErr.message}` });
    if (!folders || folders.length === 0) {
      done = true;
      break;
    }

    // A "departure" is a folder leaving the frontier this batch — expanded OR
    // given up after too many failures. If a whole batch produces zero
    // departures (every folder transient-failed without reaching the cap), stop
    // this pass instead of re-selecting the same batch in a tight loop; the
    // self-kick retries in a fresh request, giving inter-pass spacing.
    let departuresThisBatch = 0;

    for (const folder of folders as ParentRow[]) {
      if (Date.now() >= deadline) break;

      // List all direct children of this folder (paginated).
      const children: drive_v3.Schema$File[] = [];
      let pageToken: string | undefined = undefined;
      let listFailed = false;
      try {
        do {
          const resp = (await drive.files.list({
            q: `'${folder.file_id}' in parents and trashed = false`,
            fields: CHILD_FIELDS,
            pageSize: 1000,
            pageToken,
            orderBy: "folder,name",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          })) as { data: drive_v3.Schema$FileList };
          for (const f of resp.data.files ?? []) children.push(f);
          pageToken = resp.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (e) {
        listFailed = true;
        const msg = (e as Error).message;
        console.error(`[drive-catalog] list failed for ${folder.file_id}:`, msg);
        // Count the attempt. Below the cap → leave unexpanded for a later retry.
        // At the cap → give up: mark expanded with an error so it leaves the
        // frontier and the scan can terminate (re-scannable later by clearing
        // folder_expanded on rows with expand_error).
        const attempts = (folder.expand_attempts ?? 0) + 1;
        const gaveUp = attempts >= MAX_FOLDER_ATTEMPTS;
        await db
          .from("drive_catalog")
          .update({
            expand_attempts: attempts,
            expand_error: msg.slice(0, 500),
            ...(gaveUp ? { folder_expanded: true } : {}),
          })
          .eq("root_folder_id", rootId)
          .eq("file_id", folder.file_id);
        if (gaveUp) departuresThisBatch++;
        await sleep(FAIL_BACKOFF_MS); // relieve the API before the next call
      }
      if (listFailed) continue;

      if (children.length > 0) {
        const rows = children.map((f) => toRow(userId, rootId, folder, f));
        const { error: upErr } = await db
          .from("drive_catalog")
          .upsert(rows, { onConflict: "root_folder_id,file_id", ignoreDuplicates: true });
        if (upErr) {
          console.error(`[drive-catalog] upsert failed under ${folder.file_id}:`, upErr.message);
          continue; // don't mark expanded if we failed to persist children
        }
        childrenSeen += children.length;
      }

      const { error: markErr } = await db
        .from("drive_catalog")
        .update({ folder_expanded: true })
        .eq("root_folder_id", rootId)
        .eq("file_id", folder.file_id);
      if (markErr) {
        console.error(`[drive-catalog] mark-expanded failed for ${folder.file_id}:`, markErr.message);
        continue;
      }
      foldersExpanded++;
      departuresThisBatch++;
    }

    // Whole batch stuck (all transient failures, none reached the cap) — end the
    // pass so the self-kick retries with a round-trip of spacing instead of
    // hammering the same folders for the rest of the time budget.
    if (departuresThisBatch === 0) break;
  }

  // Bump the scan's heartbeat; flip to inventory_done when the frontier is empty.
  await db
    .from("drive_catalog_scans")
    .update({ status: done ? "inventory_done" : "inventory", updated_at: new Date().toISOString() })
    .eq("root_folder_id", rootId);

  // Drain the rest on the server without the caller: re-kick while work remains.
  // Strip any trailing slash so `${base}/api/...` never becomes `//api/...`
  // (some proxies 404 that, silently killing the self-drain).
  const base = (process.env.SMRTESY_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!done && base && secret && iteration + 1 < MAX_ITERATIONS) {
    selfKick(base, secret, {
      user_id: userId,
      root_folder_id: rootId,
      max_seconds: maxSeconds,
      iteration: iteration + 1,
    });
  }

  return res.json({
    ok: true,
    done,
    iteration,
    folders_expanded_this_pass: foldersExpanded,
    children_seen_this_pass: childrenSeen,
    self_kicked: !done && Boolean(base && secret && iteration + 1 < MAX_ITERATIONS),
  });
});

router.get("/drive-catalog/status", async (req: Request, res: Response) => {
  if (!requireSecret(req, res)) return;
  const rootId = typeof req.query.root_folder_id === "string" ? req.query.root_folder_id.trim() : "";
  if (!rootId) return res.status(400).json({ error: "root_folder_id is required" });

  const { data: scan } = await db
    .from("drive_catalog_scans")
    .select("*")
    .eq("root_folder_id", rootId)
    .maybeSingle();

  const { count: total } = await db
    .from("drive_catalog")
    .select("*", { count: "exact", head: true })
    .eq("root_folder_id", rootId);
  const { count: folders } = await db
    .from("drive_catalog")
    .select("*", { count: "exact", head: true })
    .eq("root_folder_id", rootId)
    .eq("is_folder", true);
  const { count: pending } = await db
    .from("drive_catalog")
    .select("*", { count: "exact", head: true })
    .eq("root_folder_id", rootId)
    .eq("is_folder", true)
    .eq("folder_expanded", false);

  res.json({
    ok: true,
    scan: scan ?? null,
    totals: {
      nodes: total ?? 0,
      folders: folders ?? 0,
      files: (total ?? 0) - (folders ?? 0),
      folders_pending_expansion: pending ?? 0,
    },
  });
});

export default router;
