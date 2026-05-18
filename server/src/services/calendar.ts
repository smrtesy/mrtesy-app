import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

export async function getCalendarClient(userId: string) {
  const auth = await getOAuthClient(userId, "gmail_calendar");
  return google.calendar({ version: "v3", auth });
}

export async function listCalendars(userId: string): Promise<CalendarInfo[]> {
  const cal = await getCalendarClient(userId);
  const res = await cal.calendarList.list({ minAccessRole: "reader" });
  return (res.data.items ?? [])
    .filter((item) => item.id && item.summary)
    .map((item) => ({
      id: item.id!,
      summary: item.summary!,
      primary: item.primary ?? false,
      accessRole: item.accessRole ?? "reader",
    }));
}

export async function listEvents(
  userId: string,
  timeMin: string,
  timeMax: string,
  maxResults = 100,
  calendarId = "primary",
) {
  const cal = await getCalendarClient(userId);
  const res = await cal.events.list({
    calendarId,
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
