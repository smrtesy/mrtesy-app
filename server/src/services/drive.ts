import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";
import { db } from "../db";

export async function getDriveClient(userId: string) {
  const auth = await getOAuthClient(userId, "google_drive");
  return google.drive({ version: "v3", auth });
}

async function resolveFolderId(
  userId: string,
  explicit?: string | null,
): Promise<string | null> {
  if (explicit) return explicit;
  const { data } = await db
    .from("user_settings")
    .select("drive_folder_id")
    .eq("user_id", userId)
    .maybeSingle();
  const fromSettings = (data?.drive_folder_id as string | null | undefined) ?? null;
  return fromSettings || null;
}

/**
 * Lists files modified since `since` inside the user's configured Drive
 * folder. Returns an empty array if the user has no folder configured —
 * Drive scanning is opt-in (the onboarding picker is intentionally
 * optional). There is no global default folder.
 */
export async function listNewFiles(
  userId: string,
  since: string,
  folderId?: string | null,
  pageSize = 50,
) {
  const folder = await resolveFolderId(userId, folderId);
  if (!folder) return [];

  const drive = await getDriveClient(userId);
  const res = await drive.files.list({
    q: `'${folder}' in parents and modifiedTime >= '${since}' and trashed = false`,
    pageSize,
    fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)",
    orderBy: "modifiedTime desc",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files ?? [];
}

export async function getFileContent(userId: string, fileId: string): Promise<string> {
  const drive = await getDriveClient(userId);
  // `files.export` only works for Google Workspace files (Docs/Sheets/Slides).
  // Non-Workspace files (PDFs, images, scanned docs from ScanSnap, etc.)
  // throw 403 "Export only supports Docs Editors files". For those we just
  // want metadata in source_messages — body extraction can come later
  // (OCR, PDF parsing). Returning "" keeps the upsert path alive.
  try {
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    const text = (res.data as string) ?? "";
    return text.slice(0, 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Export only supports|fileNotExportable/i.test(msg)) {
      return "";
    }
    throw err;
  }
}
