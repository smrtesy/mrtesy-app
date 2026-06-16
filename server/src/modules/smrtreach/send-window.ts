/**
 * smrtReach — send-window, frequency, STO and country helpers.
 *
 * Ported from the legacy botsite blast (src/email/emailQueue.js,
 * src/modules/campaignBroadcast.js) so the new pipeline honors the same
 * controls: an Israel-time send-hours window, Shabbat exclusion, per-contact
 * send-time-optimization, frequency/cooldown gating, and country filtering.
 *
 * All time math is in Asia/Jerusalem and DST-aware via Intl.DateTimeFormat
 * (never a hardcoded UTC+2/+3 offset).
 */

import { db } from "../../db";

const TZ = "Asia/Jerusalem";

export interface SendHours {
  start?: number; // 0-23, inclusive
  end?: number; // 0-23, exclusive
}

/** Friday from this Israel hour onward is treated as Shabbat (erev shabbat). */
const SHABBAT_FRIDAY_START_HOUR = 15;
/** Saturday up to this Israel hour is still Shabbat (motzaei shabbat after). */
const SHABBAT_SATURDAY_END_HOUR = 20;

/** Current hour (0-23) and weekday (0=Sun … 6=Sat) in Israel time. */
export function israelNow(now: Date = new Date()): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const wdStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = parseInt(hourStr === "24" ? "0" : hourStr, 10);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, weekday: map[wdStr] ?? 0 };
}

/** True when `now` falls inside Shabbat (Fri afternoon → Sat night), Israel time. */
export function isShabbat(now: Date = new Date()): boolean {
  const { hour, weekday } = israelNow(now);
  if (weekday === 6 && hour < SHABBAT_SATURDAY_END_HOUR) return true; // Saturday daytime/evening
  if (weekday === 5 && hour >= SHABBAT_FRIDAY_START_HOUR) return true; // Friday from mid-afternoon
  return false;
}

/**
 * Whether a campaign may send right now given its window + Shabbat rule.
 * An empty `sendHours` ({}) means "any hour". Returns a reason when blocked so
 * callers can log why a batch was deferred.
 */
export function withinSendWindow(
  sendHours: SendHours | null | undefined,
  excludeShabbat: boolean,
  now: Date = new Date(),
): { ok: boolean; reason?: "shabbat" | "outside_hours" } {
  if (excludeShabbat && isShabbat(now)) return { ok: false, reason: "shabbat" };

  const start = sendHours?.start;
  const end = sendHours?.end;
  if (typeof start === "number" && typeof end === "number" && end > start) {
    const { hour } = israelNow(now);
    if (hour < start || hour >= end) return { ok: false, reason: "outside_hours" };
  }
  return { ok: true };
}

/**
 * Soonest top-of-hour at/after `from` whose Israel-local hour equals `hour`
 * (DST-safe — checks each hour rather than assuming a fixed offset). Used by
 * send-time-optimization to schedule each contact at their best hour.
 */
export function nextOccurrenceOfHour(hour: number, from: Date = new Date()): Date {
  const base = new Date(from);
  base.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    const test = new Date(base.getTime() + i * 3_600_000);
    if (test.getTime() >= from.getTime() && israelNow(test).hour === hour) return test;
  }
  return from;
}

// ─── Frequency / cooldown (botsite emailQueue.js parity) ──────
// Legacy tiers were all/weekly/important; the CRM column is all/weekly/monthly.
// `important` maps to `monthly` (the longest-cooldown tier).
const COOLDOWN_DAYS: Record<string, number> = { all: 2, weekly: 7, monthly: 21 };

/** Which contact email_frequency tiers a campaign of this priority may reach. */
export function acceptedFrequencies(priority: string | null | undefined): Set<string> {
  switch (priority) {
    case "high":
      return new Set(["all", "weekly", "monthly"]);
    case "normal":
      return new Set(["all", "weekly"]);
    case "low":
    default:
      return new Set(["all"]);
  }
}

/** Minimum days between sends for a contact at this frequency tier. */
export function cooldownDaysFor(freq: string | null | undefined): number {
  return COOLDOWN_DAYS[freq ?? "all"] ?? 2;
}

/**
 * Per-contact optimal send hour (0-23, Israel time) from historical opens —
 * send-time-optimization. Returns a Map keyed by contact_id; contacts with no
 * open history are absent (caller falls back to the campaign window).
 */
export async function optimalSendHours(
  orgId: string,
  contactIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (contactIds.length === 0) return out;

  // Pull this campaign-audience's open events; bucket by Israel hour in code
  // (Supabase REST can't EXTRACT, so we convert each timestamp).
  const { data, error } = await db
    .from("smrtreach_tracking")
    .select("contact_id, created_at")
    .eq("org_id", orgId)
    .eq("event", "open")
    .in("contact_id", contactIds)
    .limit(20000);
  if (error || !data) return out;

  // contact_id → (hour → count)
  const counts = new Map<string, Map<number, number>>();
  for (const row of data) {
    const cid = row.contact_id as string | null;
    if (!cid) continue;
    const { hour } = israelNow(new Date(row.created_at as string));
    const byHour = counts.get(cid) ?? new Map<number, number>();
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    counts.set(cid, byHour);
  }
  for (const [cid, byHour] of counts) {
    let bestHour = -1;
    let bestCount = -1;
    for (const [hour, count] of byHour) {
      if (count > bestCount) {
        bestCount = count;
        bestHour = hour;
      }
    }
    if (bestHour >= 0) out.set(cid, bestHour);
  }
  return out;
}

/**
 * Drop contacts a campaign of this priority must not email yet: frequency-tier
 * mismatch (e.g. a 'low' campaign to a 'weekly'-only contact) or still inside
 * the per-tier cooldown since their last email. `email_frequency = 'none'` is
 * always dropped. `skipCooldown` bypasses both checks (botsite skip_cooldown).
 *
 * @returns the subset of contactIds that may be emailed, plus drop counts.
 */
export async function filterEmailByFrequency(
  orgId: string,
  contactIds: string[],
  priority: string | null | undefined,
  skipCooldown: boolean,
  now: Date = new Date(),
): Promise<{ keep: Set<string>; droppedFrequency: number; droppedCooldown: number }> {
  const keep = new Set<string>(contactIds);
  let droppedFrequency = 0;
  let droppedCooldown = 0;
  if (contactIds.length === 0) return { keep, droppedFrequency, droppedCooldown };

  // Contact frequency tiers (null tier ⇒ treated as 'all').
  const { data: contacts, error: cErr } = await db
    .from("smrtcrm_contacts")
    .select("id, email_frequency")
    .eq("org_id", orgId)
    .in("id", contactIds);
  if (cErr || !contacts) return { keep, droppedFrequency, droppedCooldown };

  const freqById = new Map<string, string>();
  for (const c of contacts) freqById.set(c.id as string, (c.email_frequency as string | null) ?? "all");

  const accepted = acceptedFrequencies(priority);

  // Last successful email per contact (for cooldown). Bounded fetch, reduced in code.
  const lastSentById = new Map<string, number>();
  if (!skipCooldown) {
    const { data: logs } = await db
      .from("smrtreach_logs")
      .select("contact_id, sent_at")
      .eq("org_id", orgId)
      .eq("channel", "email")
      .eq("status", "sent")
      .in("contact_id", contactIds)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(20000);
    for (const row of logs ?? []) {
      const cid = row.contact_id as string | null;
      if (!cid || lastSentById.has(cid)) continue; // first (newest) wins
      lastSentById.set(cid, new Date(row.sent_at as string).getTime());
    }
  }

  for (const cid of contactIds) {
    const freq = freqById.get(cid) ?? "all";
    if (freq === "none" || !accepted.has(freq)) {
      keep.delete(cid);
      droppedFrequency++;
      continue;
    }
    if (!skipCooldown) {
      const last = lastSentById.get(cid);
      if (last !== undefined) {
        const daysSince = (now.getTime() - last) / 86_400_000;
        if (daysSince < cooldownDaysFor(freq)) {
          keep.delete(cid);
          droppedCooldown++;
        }
      }
    }
  }
  return { keep, droppedFrequency, droppedCooldown };
}

// ─── Per-recipient timezone (campaignBroadcast.js parity) ─────
// Representative IANA timezone by phone dialing prefix, so a campaign can send
// at a target LOCAL hour for each recipient (e.g. 10:00 their time).
const TZ_BY_PREFIX: { prefix: string; tz: string }[] = [
  { prefix: "972", tz: "Asia/Jerusalem" },
  { prefix: "44", tz: "Europe/London" },
  { prefix: "33", tz: "Europe/Paris" },
  { prefix: "49", tz: "Europe/Berlin" },
  { prefix: "31", tz: "Europe/Amsterdam" },
  { prefix: "32", tz: "Europe/Brussels" },
  { prefix: "34", tz: "Europe/Madrid" },
  { prefix: "39", tz: "Europe/Rome" },
  { prefix: "1", tz: "America/New_York" }, // US/Canada — representative (Eastern)
];

/** Representative IANA timezone for a phone, or UTC if unknown. */
export function tzForPhone(phone: string | null | undefined): string {
  if (!phone) return "UTC";
  const digits = phone.replace(/[^0-9]/g, "");
  // Longest prefix wins (972 before 9, 1 last).
  const match = [...TZ_BY_PREFIX].sort((a, b) => b.prefix.length - a.prefix.length).find((p) => digits.startsWith(p.prefix));
  return match?.tz ?? "UTC";
}

/** Current hour (0-23) in an arbitrary IANA timezone. */
function hourInTz(tz: string, at: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(at);
  const n = parseInt(h === "24" ? "0" : h, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Soonest top-of-hour at/after `from` whose local hour in `tz` equals `hour`. */
export function nextOccurrenceOfHourInTz(hour: number, tz: string, from: Date = new Date()): Date {
  const base = new Date(from);
  base.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    const test = new Date(base.getTime() + i * 3_600_000);
    if (test.getTime() >= from.getTime() && hourInTz(tz, test) === hour) return test;
  }
  return from;
}

// ─── Country filter (campaignBroadcast.js parity) ─────────────
// Matches a normalized phone (E.164 digits, no '+') by dialing prefix.
const COUNTRY_PREFIXES: Record<string, string[]> = {
  israel: ["972"],
  us: ["1"],
  canada: ["1"],
  europe: ["44", "33", "49", "31", "32", "34", "39"],
};

/** True when the phone matches the campaign's country filter ('all'/empty = always). */
export function matchesCountry(phone: string | null | undefined, filter: string | null | undefined): boolean {
  if (!filter || filter === "all") return true;
  if (!phone) return false;
  const digits = phone.replace(/[^0-9]/g, "");
  const prefixes = COUNTRY_PREFIXES[filter];
  if (!prefixes) return true; // unknown filter → don't exclude
  return prefixes.some((p) => digits.startsWith(p));
}
