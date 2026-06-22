import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";

/**
 * Google Sheets client for the user. Reuses the gmail_calendar OAuth token,
 * which already carries the `spreadsheets.readonly` scope (see
 * src/app/api/auth/google/route.ts). Users who connected Google before that
 * scope was added will get a 403 from the API and must reconnect.
 */
export async function getSheetsClient(userId: string) {
  const auth = await getOAuthClient(userId, "gmail_calendar");
  return google.sheets({ version: "v4", auth });
}

/**
 * Accepts a full Google Sheets URL or a bare spreadsheet ID and returns the
 * ID. Returns null when the input doesn't look like either.
 */
export function parseSpreadsheetId(input: string): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // A bare ID — Google IDs are long base64url-ish strings.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

/**
 * Reads a grid of values from a spreadsheet. When no range is given, reads the
 * first sheet in full. Returns rows as string[][] (Google omits trailing empty
 * cells, so rows can be ragged — callers read by mapped index, which is fine).
 */
export async function fetchSheetGrid(
  userId: string,
  spreadsheetId: string,
  range?: string | null,
): Promise<string[][]> {
  const sheets = await getSheetsClient(userId);

  let readRange = (range ?? "").trim();
  if (!readRange) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });
    const firstTitle = meta.data.sheets?.[0]?.properties?.title;
    // Quote the sheet title so names with spaces resolve as A1 notation.
    readRange = firstTitle ? `'${firstTitle.replace(/'/g, "''")}'` : "A:Z";
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: readRange,
    // FORMATTED_VALUE returns the displayed text — preserves leading zeros on
    // phone numbers and matches what a CSV export of the same sheet contains.
    valueRenderOption: "FORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  return values.map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
}
