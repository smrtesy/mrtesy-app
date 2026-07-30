/**
 * Attachments — the files a chat turn carries.
 *
 * The engine runs as a process on our host, not as an API call with an images
 * array, so "attaching a file" concretely means: put the bytes somewhere the
 * process can open, and tell it the path. That is what this module does.
 *
 *   upload   → bytes go to the private `claude-attachments` bucket (durable, so
 *              a thread reopened next week still lists what was sent).
 *   send     → the runner calls materializeAttachments(), which downloads them
 *              into the run's working directory and returns the local paths for
 *              the prompt to reference.
 *
 * WHY A SUBDIRECTORY (`.claude-attachments/`): when the run also has a cloned
 * repo, dropping files into its root would show up as untracked changes and could
 * end up committed. A dot-directory keeps them out of the way and out of a diff.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../../db";

export const BUCKET = "claude-attachments";
/**
 * The REAL ceiling, and it is not the bucket's 25 MB.
 *
 * Uploads arrive as base64 in a JSON body, and express.json is capped at 10mb
 * globally (server/src/index.ts). base64 inflates by 4/3, so ~7 MB of file is the
 * largest that can reach this code — anything bigger is rejected by the body parser
 * as an opaque 500 before any check here runs. Raising the global limit for every
 * route to serve one screen is the wrong trade, so the limit is stated truthfully
 * here and in the UI instead.
 */
export const MAX_BYTES = 7 * 1024 * 1024;
/** base64 inflates by 4/3; this bounds the request body before decoding. */
export const MAX_BASE64_CHARS = Math.ceil((MAX_BYTES * 4) / 3) + 1024;

const ATTACH_DIR = ".claude-attachments";

/**
 * Strip a filename down to something safe to join onto a directory.
 *
 * Path separators and traversal are removed rather than escaped, because the
 * result is written to disk on our host: a name like `../../etc/x` must not be
 * able to leave the attachment directory. Hebrew and other non-Latin names are
 * preserved — this is a path-safety pass, not an ASCII filter.
 */
export function safeFilename(raw: string): string {
  const base = (raw || "file").split(/[\\/]/).pop() ?? "file";
  // Escaped, not literal: written as raw bytes this line made the whole source
  // file read as binary to grep and diff tools.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(0, 120);
}

export interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
}

/**
 * Store one uploaded file and record it against a thread.
 *
 * The storage path is namespaced by org and thread so a listing can never mix
 * tenants, and suffixed with the row id so two files with the same name in one
 * thread don't overwrite each other (`upsert: false` would fail the second one).
 */
export async function saveAttachment(params: {
  orgId: string;
  threadId: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  base64: string;
  /** Set for files the RUN produced (browser screenshots): linked to the turn
   *  immediately, instead of waiting for a send to claim them. */
  runId?: string;
  /** 'user' (default) = sent by the user with a message; 'run' = produced by the
   *  run itself. The UI renders them differently (chips vs inline images). */
  source?: "user" | "run";
}): Promise<AttachmentRow> {
  const cleaned = params.base64.replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.length === 0) throw new Error("attachment is empty");
  if (buffer.length > MAX_BYTES) throw new Error("attachment is too large");

  const filename = safeFilename(params.filename);
  const id = crypto.randomUUID();
  const storagePath = `${params.orgId}/${params.threadId}/${id}-${filename}`;

  const { error: upErr } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: params.mimeType || "application/octet-stream",
    upsert: false,
  });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);

  const { data, error } = await db
    .from("claude_attachments")
    .insert({
      id,
      org_id: params.orgId,
      thread_id: params.threadId,
      created_by: params.userId,
      filename,
      mime_type: params.mimeType,
      size_bytes: buffer.length,
      storage_path: storagePath,
      ...(params.runId ? { run_id: params.runId } : {}),
      ...(params.source ? { source: params.source } : {}),
    })
    .select("id, filename, mime_type, size_bytes, storage_path")
    .single();

  if (error) {
    // Roll the object back: a stored file with no row is invisible to the app and
    // would sit in the bucket forever.
    await db.storage.from(BUCKET).remove([storagePath]);
    throw new Error(`could not record attachment: ${error.message}`);
  }
  return data;
}

/**
 * Download this run's attachments into `dir` and return their local paths.
 *
 * A file that fails to download is skipped rather than failing the turn: losing
 * one attachment is recoverable (the user can say "look at the other one"),
 * killing the whole conversation turn is not. The caller reports what it got, so
 * a missing path is visible rather than silently assumed present.
 */
export async function materializeAttachments(
  runId: string,
  dir: string,
): Promise<{ paths: string[]; failures: string[] }> {
  const { data: rows, error } = await db
    .from("claude_attachments")
    .select("filename, storage_path")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[claude/attachments] list failed:", error.message);
    return { paths: [], failures: ["could not list attachments"] };
  }
  if (!rows || rows.length === 0) return { paths: [], failures: [] };

  const target = path.join(dir, ATTACH_DIR);
  await mkdir(target, { recursive: true });

  const paths: string[] = [];
  const failures: string[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(row.storage_path);
      if (dlErr || !blob) throw new Error(dlErr?.message || "download returned nothing");
      // Index-prefixed: two files named screenshot.png in one turn would otherwise
      // overwrite each other and the prompt would list the same path twice.
      const full = path.join(target, `${i + 1}-${safeFilename(row.filename)}`);
      await writeFile(full, Buffer.from(await blob.arrayBuffer()));
      paths.push(full);
    } catch (e) {
      failures.push(`${row.filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { paths, failures };
}

/**
 * Delete every stored object for a thread.
 *
 * Rows cascade with the thread, bytes do not — without this the bucket would keep
 * the files of every deleted conversation forever, while the UI said "deleted".
 * Also clears uploads that were staged and never sent (run_id still null).
 */
export async function removeThreadAttachments(threadId: string): Promise<void> {
  const { data: rows, error } = await db
    .from("claude_attachments")
    .select("storage_path")
    .eq("thread_id", threadId);
  if (error) {
    console.error("[claude/attachments] list for delete failed:", error.message);
    return;
  }
  const paths = (rows ?? []).map((r) => r.storage_path).filter(Boolean);
  if (paths.length === 0) return;
  const { error: rmErr } = await db.storage.from(BUCKET).remove(paths);
  if (rmErr) console.error("[claude/attachments] object removal failed:", rmErr.message);
}
