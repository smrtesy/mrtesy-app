import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";
import { db } from "../db";
import { callGemini } from "../gemini";

export async function getDriveClient(userId: string) {
  const auth = await getOAuthClient(userId, "google_drive");
  return google.drive({ version: "v3", auth });
}

async function resolveFolderIds(
  userId: string,
  explicit?: string | null,
): Promise<string[]> {
  if (explicit) return [explicit];
  const { data } = await db
    .from("user_settings")
    .select("drive_folder_id, drive_folder_ids")
    .eq("user_id", userId)
    .maybeSingle();
  // Prefer the new array; fall back to the legacy singular column so
  // unmigrated users still work until they pick folders via the new UI.
  const arr = (data?.drive_folder_ids as string[] | null | undefined) ?? [];
  if (arr.length > 0) return arr;
  const single = (data?.drive_folder_id as string | null | undefined) ?? null;
  return single ? [single] : [];
}

/**
 * Lists files modified since `since` inside any of the user's configured
 * Drive folders. Returns an empty array if the user has no folder
 * configured — Drive scanning is opt-in (the picker is intentionally
 * optional). There is no global default folder.
 *
 * Currently scans direct children of the selected folders. Recursive
 * descent into sub-folders is handled by the drive-sync edge function;
 * this server-side path is only used for ad-hoc manual sync triggers.
 */
export async function listNewFiles(
  userId: string,
  since: string,
  folderId?: string | null,
  pageSize = 50,
) {
  const folders = await resolveFolderIds(userId, folderId);
  if (folders.length === 0) return [];

  const drive = await getDriveClient(userId);
  // Drive's `q` supports `or` between `<id>' in parents` clauses up to
  // a couple of dozen IDs before the URL gets unwieldy. We expect <25
  // selected folders in practice; if more, the first batch will cover
  // the majority and the edge function picks up the rest.
  const orClause = folders.slice(0, 25).map((id) => `'${id}' in parents`).join(" or ");
  const res = await drive.files.list({
    q: `(${orClause}) and modifiedTime >= '${since}' and trashed = false`,
    pageSize,
    fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)",
    orderBy: "modifiedTime desc",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files ?? [];
}

const PDF_EXTRACT_PROMPT =
  "מסמך זה הועלה ל-Google Drive. חלץ את תוכנו:\n" +
  "1. זהה את סוג המסמך (חשבונית, חוזה, מכתב, טופס, דו\"ח וכו').\n" +
  "2. חלץ את כל הטקסט הרלוונטי — תאריכים, סכומים, שמות, כתובות, מספרי הפניה.\n" +
  "3. אם המסמך בעברית — פלט בעברית. אם באנגלית — פלט באנגלית.\n" +
  "פלט: טקסט גולמי בלבד, ללא כותרות, ללא הקדמות.";

export async function getFileContent(userId: string, fileId: string): Promise<string> {
  const drive = await getDriveClient(userId);
  try {
    // Google Workspace files (Docs/Sheets/Slides) — export as plain text.
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    const text = (res.data as string) ?? "";
    return text.slice(0, 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Export only supports|fileNotExportable/i.test(msg)) throw err;
    // Non-Workspace file (PDF, scanned doc, image) — download binary and
    // send to Gemini for text extraction / OCR. Cap at 15 MB to stay
    // within Gemini's inline_data limit.
    try {
      const streamRes = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" },
      );
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of streamRes.data) {
        const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += c.length;
        // 15 MB binary ≈ 20 MB base64 — Gemini's inline_data hard cap.
        if (total > 15 * 1024 * 1024) return "";
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      const base64Data = buf.toString("base64");
      const text = await callGemini({
        prompt: PDF_EXTRACT_PROMPT,
        base64Data,
        mimeType: "application/pdf",
        maxOutputTokens: 2048,
      });
      return text.slice(0, 3000);
    } catch {
      return "";
    }
  }
}
