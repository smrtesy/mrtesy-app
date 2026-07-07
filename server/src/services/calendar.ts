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
  updatedMin?: string,
) {
  const cal = await getCalendarClient(userId);
  const res = await cal.events.list({
    calendarId,
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
    ...(updatedMin ? { updatedMin } : {}),
  });
  return res.data.items ?? [];
}

export interface CreateEventOptions {
  timeZone?: string;
  location?: string;
  /** Google extended properties. smrtesy tags the events it creates with
   *  smrtesy_task_id / smrtesy_origin as a durable provenance marker. (The
   *  active re-ingest dedup keys off tasks.calendar_event_id in ai-process;
   *  this tag is a redundant, self-describing backup that survives a lost
   *  calendar_event_id.) */
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

export async function createCalendarEvent(
  userId: string,
  summary: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
  opts?: CreateEventOptions,
) {
  const cal = await getCalendarClient(userId);
  const tz = opts?.timeZone ?? "Asia/Jerusalem";
  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      ...(opts?.location ? { location: opts.location } : {}),
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      ...(opts?.extendedProperties ? { extendedProperties: opts.extendedProperties } : {}),
    },
  });
  return res.data;
}
