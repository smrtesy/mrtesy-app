import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";
import { db } from "../db";
import { callGemini } from "../gemini";

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
      const dlRes = await drive.files.get(
        { fileId, alt: "media" } as Parameters<typeof drive.files.get>[0],
        { responseType: "arraybuffer" },
      );
      const buf = Buffer.from(dlRes.data as ArrayBuffer);
      if (buf.length > 15 * 1024 * 1024) return "";
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
