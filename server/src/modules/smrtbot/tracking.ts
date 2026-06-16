/**
 * smrtBot — study / prayer tracking (Phase 2, part 1).
 *
 * Ports the self-contained behaviours of the legacy Apps-Script "Shulem" bot
 * into the smrtBot engine: open/close a study session and get the elapsed time,
 * report a Shacharit prayer (3-step flow), and a daily status summary. No
 * external API — everything is computed from two new tables.
 *
 * Wired into engine.ts via handleTrackingAction (button ids / text triggers)
 * and handleTrackingText (the PRAYER_* expectedInput steps), mirroring the
 * game.ts integration so the rest of the engine is untouched.
 */
import { db } from "../../db";
import { type BotEnv, type ReplyButton } from "./wa";
import { type BotChannel } from "./channel";

export interface TrackBot {
  id: string;
  org_id: string;
  slug: string;
}

type State = Record<string, unknown>;

// ── state (DB-backed, mirrors game.ts) ───────────────────────
async function getTrackState(bot: TrackBot, phone: string): Promise<State> {
  const { data } = await db
    .from("smrtbot_wa_users")
    .select("state_json")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .maybeSingle();
  return (data?.state_json as State) ?? {};
}

async function setTrackState(bot: TrackBot, phone: string, patch: State): Promise<void> {
  const current = await getTrackState(bot, phone);
  const merged = { ...current, ...patch, lastInteractionMs: Date.now() };
  const { error } = await db
    .from("smrtbot_wa_users")
    .upsert(
      { org_id: bot.org_id, bot_id: bot.id, phone, state_json: merged, last_interaction_at: new Date().toISOString() },
      { onConflict: "bot_id,phone" },
    );
  if (error) console.error("[smrtbot/tracking] setTrackState", error.message);
}

// ── helpers ──────────────────────────────────────────────────
function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDuration(min: number): string {
  if (min < 60) return `${min} דק׳`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ש׳ ${m} דק׳` : `${h} ש׳`;
}

/** Parse "7:15" / "07:15" / "7.15" / "7" into a Date today at that time. */
function parseTime(text: string): Date | null {
  const cleaned = (text || "").replace(/[^\d:.]/g, " ").trim();
  const m = cleaned.match(/^(\d{1,2})(?:[:.](\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function encouragement(min: number): string {
  if (min < 30) return "נרשם! כל דקה חשובה 💪";
  if (min < 60) return `יפה! סשן של ${fmtDuration(min)} נרשם ✅`;
  if (min < 120) return `כל הכבוד! ריכוז של ${fmtDuration(min)} — מרשים 🔥`;
  return `וואו! ${fmtDuration(min)} ברצף — עבודה מצוינת! 🚀`;
}

// ── study sessions ───────────────────────────────────────────
async function startStudy(bot: TrackBot, phone: string, channel: BotChannel): Promise<void> {
  const { data: active } = await db
    .from("smrtbot_study_sessions")
    .select("started_at")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) {
    await channel.text(`⚠️ כבר יש לך סשן פתוח מ-${fmtTime(new Date(active.started_at as string))}. שלח "סיימתי" כדי לסגור אותו.`);
    return;
  }
  const now = new Date();
  const { error } = await db.from("smrtbot_study_sessions").insert({
    org_id: bot.org_id,
    bot_id: bot.id,
    phone,
    started_at: now.toISOString(),
    status: "active",
  });
  if (error) {
    await channel.text("⚠️ לא הצלחתי לפתוח סשן, נסה שוב.");
    return;
  }
  await channel.text(`▶️ התחלנו! סשן נפתח בשעה ${fmtTime(now)}.\nבהצלחה 💪`);
}

async function endStudy(bot: TrackBot, phone: string, channel: BotChannel): Promise<void> {
  const { data: active } = await db
    .from("smrtbot_study_sessions")
    .select("id, started_at")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!active) {
    await channel.text('ℹ️ לא מצאתי סשן פתוח. שלח "התחלתי" כדי לפתוח אחד.');
    return;
  }
  const start = new Date(active.started_at as string);
  const end = new Date();
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const { error } = await db
    .from("smrtbot_study_sessions")
    .update({ ended_at: end.toISOString(), minutes, status: "completed" })
    .eq("id", active.id as string);
  if (error) {
    await channel.text("⚠️ לא הצלחתי לסגור את הסשן, נסה שוב.");
    return;
  }
  const today = await sumStudyMinutes(bot, phone, startOfToday());
  await channel.text(
    `✅ נרשם סשן!\n${fmtTime(start)} — ${fmtTime(end)}\n⏱️ *${fmtDuration(minutes)}*\n\n${encouragement(minutes)}\n📚 היום סה״כ: ${fmtDuration(today)}`,
  );
}

async function sumStudyMinutes(bot: TrackBot, phone: string, since: Date): Promise<number> {
  const { data } = await db
    .from("smrtbot_study_sessions")
    .select("minutes")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("status", "completed")
    .gte("started_at", since.toISOString());
  return ((data as { minutes: number | null }[]) ?? []).reduce((sum, r) => sum + (r.minutes ?? 0), 0);
}

// ── daily status ─────────────────────────────────────────────
async function studyStatus(bot: TrackBot, phone: string, channel: BotChannel): Promise<void> {
  const today = await sumStudyMinutes(bot, phone, startOfToday());
  const weekStart = new Date(startOfToday());
  weekStart.setDate(weekStart.getDate() - 6);
  const week = await sumStudyMinutes(bot, phone, weekStart);

  const todayStr = startOfToday().toISOString().slice(0, 10);
  const { data: prayer } = await db
    .from("smrtbot_prayers")
    .select("in_minyan, minutes, started_at, ended_at")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("prayer_date", todayStr)
    .maybeSingle();

  let msg = `📊 *הסטטוס שלי*\n\n📚 לימוד היום: *${today > 0 ? fmtDuration(today) : "—"}*\n📈 7 ימים אחרונים: ${fmtDuration(week)}\n`;
  if (prayer) {
    const minyanStr = prayer.in_minyan ? "במניין ✅" : "ביחידות";
    msg += `🙏 שחרית: ${minyanStr} (${prayer.minutes} דק׳)`;
  } else {
    msg += "🙏 שחרית: טרם דווחה היום";
  }
  await channel.text(msg);
}

// ── prayer flow (3 steps via expectedInput) ──────────────────
async function savePrayer(bot: TrackBot, phone: string, start: Date, end: Date, inMinyan: boolean, channel: BotChannel): Promise<void> {
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const { error } = await db.from("smrtbot_prayers").upsert(
    {
      org_id: bot.org_id,
      bot_id: bot.id,
      phone,
      prayer_date: startOfToday().toISOString().slice(0, 10),
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      minutes,
      in_minyan: inMinyan,
      kind: "shacharit",
    },
    { onConflict: "bot_id,phone,prayer_date,kind" },
  );
  await setTrackState(bot, phone, { expectedInput: null, prayerStart: null, prayerEnd: null });
  if (error) {
    await channel.text("⚠️ לא הצלחתי לשמור את הדיווח, נסה שוב.");
    return;
  }
  await channel.text(
    `✅ נרשם!\nשחרית ${inMinyan ? "במניין ✅" : "ביחידות"}, ${fmtTime(start)}-${fmtTime(end)} (${minutes} דק׳)\n\nיום טוב! ☀️`,
  );
}

// ── public: action + text entry points ───────────────────────
const START_WORDS = ["התחלתי", "מתחיל", "התחלתי ללמוד", "start"];
const END_WORDS = ["סיימתי", "גמרתי", "סיימתי ללמוד", "end", "stop"];

/** Returns true if the action/text was a tracking command. */
export async function handleTrackingAction(
  bot: TrackBot,
  env: BotEnv,
  phone: string,
  action: string,
  channel: BotChannel,
): Promise<boolean> {
  const a = action.trim().toLowerCase();

  if (action === "study_start" || START_WORDS.includes(a)) {
    await startStudy(bot, phone, channel);
    return true;
  }
  if (action === "study_end" || END_WORDS.includes(a)) {
    await endStudy(bot, phone, channel);
    return true;
  }
  if (action === "study_status") {
    await studyStatus(bot, phone, channel);
    return true;
  }
  if (action === "prayer_report") {
    await setTrackState(bot, phone, { expectedInput: "PRAYER_START", prayerStart: null, prayerEnd: null });
    await channel.text("🙏 *דיווח שחרית*\nבאיזו שעה התחלת? (למשל 7:15)");
    return true;
  }
  if (action === "prayer_minyan_yes" || action === "prayer_minyan_no") {
    const state = await getTrackState(bot, phone);
    const startIso = state.prayerStart as string | undefined;
    const endIso = state.prayerEnd as string | undefined;
    if (!startIso || !endIso) {
      await channel.text('ℹ️ נתחיל מחדש — שלח "דיווח שחרית".');
      await setTrackState(bot, phone, { expectedInput: null, prayerStart: null, prayerEnd: null });
      return true;
    }
    await savePrayer(bot, phone, new Date(startIso), new Date(endIso), action === "prayer_minyan_yes", channel);
    return true;
  }
  return false;
}

/** Handles the PRAYER_* expectedInput steps (free-text time entry). */
export async function handleTrackingText(
  bot: TrackBot,
  env: BotEnv,
  phone: string,
  text: string,
  state: State,
  channel: BotChannel,
): Promise<void> {
  const step = String(state.expectedInput || "");

  if (step === "PRAYER_START") {
    const start = parseTime(text);
    if (!start) {
      await channel.text("⚠️ לא הבנתי את השעה. נסה שוב, למשל: 7:15");
      return;
    }
    await setTrackState(bot, phone, { expectedInput: "PRAYER_END", prayerStart: start.toISOString() });
    await channel.text("ובאיזו שעה סיימת?");
    return;
  }

  if (step === "PRAYER_END") {
    const end = parseTime(text);
    if (!end) {
      await channel.text("⚠️ לא הבנתי. נסה שוב, למשל: 8:00");
      return;
    }
    const start = new Date(String(state.prayerStart));
    if (end <= start) {
      await channel.text("⚠️ שעת הסיום מוקדמת מההתחלה. נסה שוב.");
      return;
    }
    await setTrackState(bot, phone, { expectedInput: "PRAYER_MINYAN", prayerEnd: end.toISOString() });
    const buttons: ReplyButton[] = [
      { id: "prayer_minyan_yes", title: "כן במניין" },
      { id: "prayer_minyan_no", title: "ביחידות" },
    ];
    await channel.buttons("האם התפללת במניין?", buttons);
    return;
  }

  // PRAYER_MINYAN: the answer is expected as a button, but accept text too.
  const yes = /מנין|מניין|כן/.test(text);
  const startIso = state.prayerStart as string | undefined;
  const endIso = state.prayerEnd as string | undefined;
  if (startIso && endIso) {
    await savePrayer(bot, phone, new Date(startIso), new Date(endIso), yes, channel);
  } else {
    await setTrackState(bot, phone, { expectedInput: null });
    await channel.text('ℹ️ נתחיל מחדש — שלח "דיווח שחרית".');
  }
}
