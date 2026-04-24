import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";

const SCANSNAP_FOLDER = "1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1";

export async function getDriveClient(userId: string) {
  const auth = await getOAuthClient(userId, "google_drive");
  return google.drive({ version: "v3", auth });
}

export async function listNewFiles(userId: string, since: string, pageSize = 10) {
  const drive = await getDriveClient(userId);
  const res = await drive.files.list({
    q: `'${SCANSNAP_FOLDER}' in parents and modifiedTime >= '${since}' and trashed = false`,
    pageSize,
    fields: "files(id, name, mimeType, modifiedTime, size)",
    orderBy: "modifiedTime desc",
  });
  return res.data.files ?? [];
}

export async function getFileContent(userId: string, fileId: string): Promise<string> {
  const drive = await getDriveClient(userId);
  const res = await drive.files.export(
    { fileId, mimeType: "text/plain" },
    { responseType: "text" },
  );
  const text = (res.data as string) ?? "";
  return text.slice(0, 3000);
}
