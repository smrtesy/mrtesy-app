import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";

export async function getCalendarClient(userId: string) {
  const auth = await getOAuthClient(userId, "gmail_calendar");
  return google.calendar({ version: "v3", auth });
}

export async function listEvents(
  userId: string,
  timeMin: string,
  timeMax: string,
  maxResults = 100,
) {
  const cal = await getCalendarClient(userId);
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });
  return res.data.items ?? [];
}

export async function createCalendarEvent(
  userId: string,
  summary: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
) {
  const cal = await getCalendarClient(userId);
  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      start: { dateTime: startDateTime, timeZone: "Asia/Jerusalem" },
      end: { dateTime: endDateTime, timeZone: "Asia/Jerusalem" },
    },
  });
  return res.data;
}
