/**
 * smrtBot — game engine (ported from botsite/src/modules/game.js).
 *
 * Faithful TS port against smrtbot_* + wa.ts. Covers: child registration +
 * onboarding state machine, daily missions, multi-level trivia (daily limit),
 * diamonds rewards, leaderboard, share/referral, settings + reminders, and the
 * raffle engine. Wired into the engine via handleGameAction / handleGameText
 * and into cron via sendScheduledReminders / executeRaffle.
 *
 * Behavioural verification pending (needs a test bot). Compiles clean and
 * mirrors the botsite flows 1:1.
 */
import { db } from "../../db";
import {
  resolveCreds,
  sendText,
  sendButtons,
  sendList,
  type BotEnv,
  type ResolvedCreds,
  type ReplyButton,
  type ListRow,
} from "./wa";

const GAME_CONFIG = {
  TRIVIA_DAILY_LIMIT: 9,
  TRIVIA_REWARD_EASY: 5,
  TRIVIA_REWARD_MEDIUM: 10,
  TRIVIA_REWARD_HARD: 20,
  CHILD_NAME_MAX_LEN: 40,
};

// Default copy — overridable per-bot via smrtbot_messages (DB is source of truth).
const GAME_MESSAGES: Record<string, string> = {
  GAME_MORE_OPTIONS: "עוד אפשרויות:",
  GAME_WHAT_NEXT: "מה תרצו לעשות?",
  GAME_EDIT_PROFILE_MENU: "✏️ *עריכת פרופיל של {name}*\n\nמה תרצו לשנות?",
  GAME_MISSIONS_HEADER: "🎯 המשימות שמחכות לכם היום:",
  GAME_MISSION_ALREADY_DONE: "כבר קיבלת יהלומים על המשימה הזו היום! נסה משימה אחרת 😉💎",
  GAME_MISSION_NOT_FOUND: "שגיאה - נסו שוב.",
  GAME_MISSION_DETAIL: "{content}\n\nאם תשלימו את המשימה תקבלו *{reward} יהלומים* 💎",
  GAME_MISSION_COMPLETE: "🌟 {success}\nהוספתי *{reward} יהלומים* לארנק שלך, יש לך *{total} יהלומים*! 💎",
  TRIVIA_NOT_FOUND: "שגיאה - לא מצאתי את השאלה. נסו שוב.",
  GAME_SHARE_MENU: "🎁 *הגרלת השיתופים הגדולה!*\n\nיש לחשבון שלכם כרגע: *{tickets} כרטיסים* 🎟️\n\nכל משתתף חדש שיצטרף דרככם = כרטיס נוסף!\n\nב-2 קליקים פשוטים 👇 משתפים ומפיצים טוב!",
  GAME_REFERRAL_NOTIFY: "איזה יופי! 🎉 חבר חדש הצטרף דרכך!\nקיבלתם כרטיס אחד ל*הגרלת השיתופים*! 🎟️\nשתפו עוד כדי להגדיל סיכויים! 📲",
  GAME_SETTINGS_HEADER: "⚙️ *הגדרות המשחק:*",
  RAFFLE_WINNER_REFERRALS: "🎉🎉🎉 מזל טוב!\nזכית ב*הגרלת השיתופים*!\n🎁 הפרס: *{desc}*\n🔑 הקוד שלך: *{code}*",
  RAFFLE_WINNER_DIAMONDS: "🎉🎉🎉 מזל טוב {name}!\nזכית ב*הגרלת היהלומים*!\n🎁 הפרס: *{desc}*\n🔑 הקוד שלך: *{code}*\n\nתראו לאמא ואבא! 😊",
  GAME_FOMO_REMINDER: "⏰ *תזכורת* — ההגרלה היום בשעה 18:00!\nשחקו עוד היום כדי לצבור יותר כרטיסים! 🎲",
  GAME_SELECT_CHILD: "במי נבחר היום? 🎲",
  GAME_ADD_CHILD_PROMPT: "➕ *מה השם של הילד או הילדה?*\n(כתבו שם פרטי ושם משפחה)",
  GAME_ASK_NAME_INVALID: "אנא כתבו שם פרטי ושם משפחה (לפחות שתי מילים), למשל: *משה לוי*",
  GAME_ASK_BIRTHDAY: "שלום, *{name}*! 👋\n\nמתי יום ההולדת שלך? 🥳\n(כתבו יום וחודש עברי, למשל: *יא ניסן*)",
  GAME_ASK_BIRTHDAY_INVALID: "לא הצלחתי לזהות את התאריך 😅\nאנא כתבו יום וחודש עברי, למשל: *יא ניסן* או *כ תשרי*",
  GAME_ASK_REMINDER_TIME_INVALID: "אנא כתבו שעה בין 8 ל-21, למשל: *17*",
  GAME_EDIT_NAME_INVALID: "אנא כתבו שם פרטי ושם משפחה (לפחות שתי מילים)",
  GAME_EDIT_NAME_DONE: "✅ השם עודכן ל-*{name}* בהצלחה!",
  GAME_EDIT_BIRTHDAY_INVALID: "לא הצלחתי לזהות את התאריך 😅\nכתבו יום וחודש עברי, למשל: *יא ניסן*",
  GAME_EDIT_BIRTHDAY_DONE: "✅ תאריך הלידה עודכן ל-*{date}* בהצלחה!",
  GAME_ASK_NEW_NAME: "✏️ *מה השם החדש?*\n(שם פרטי ושם משפחה)",
  GAME_ASK_NEW_BIRTHDAY: "🎂 *מה תאריך הלידה העברי הנכון?*\n(למשל: *יא ניסן* או *כ תשרי*)",
  GAME_ALL_MISSIONS_DONE: "🌟 כל הכבוד! סיימת את כל המשימות להיום!\nחזרו מחר למשימות חדשות.",
  GAME_ALL_TRIVIA_DONE: "🌟 כל הכבוד! ענית על כל שאלות הטריוויה!\nחזרו מחר לתוכנית חדשה.",
  GAME_ASK_REMINDER_TIME: "⏰ באיזו שעה תרצו לקבל תזכורת יומית?\n\nכתבו שעה בין 8 ל-21, למשל: *17*",
  GAME_WELCOME_REGISTER: "ברוכים הבאים למשחק היומי של *רבי לילדים*! 🎉💎\nבוא נתחיל לאסוף יהלומים ולזכות בפרסים.\n\n*מה השם של הילד או הילדה?*\n(כתבו שם פרטי ושם משפחה)",
  GAME_CHILD_MENU: "היי *{name}*! 👋\nיש לך בארנק *{diamonds} יהלומים* 💎\n\nמה תרצו לעשות עכשיו?",
  TRIVIA_DAILY_LIMIT_REACHED: "🌟 *כל הכבוד!* ענית על כל {limit} שאלות הטריוויה להיום! 🎉\n\nחזרו מחר לתוכנית חדשה ועוד שאלות מרתקות מ*רבי לילדים*! 🎬",
  TRIVIA_CHOOSE_LEVEL: "🧠 *הטריוויה היומית!*\n\n🎬 מתוך תוכנית: *{programTitle}*\nנשארו לך עוד *{remaining}* שאלות להיום.\n\nבאיזו דרגת קושי תרצו לשחק?",
  TRIVIA_LEVEL_DONE: "כבר ענית על השאלות ברמה הזו! נסו דרגת קושי אחרת 😉",
  TRIVIA_QUESTION_DISPLAY: "שאלת טריוויה:\n\n👈 *{content}*\n\nא. {option1}\nב. {option2}{option3}{source}\n\n👈 בחרו את התשובה הנכונה",
  TRIVIA_ALREADY_ANSWERED: "כבר ענית על השאלה הזו! 😉",
  TRIVIA_DAILY_DONE_SUFFIX: "\n\n🌟 *כל הכבוד!* ענית על כל {limit} השאלות להיום!\nחזרו מחר לתוכנית חדשה ועוד שאלות מ*רבי לילדים*! 🎬",
  TRIVIA_CORRECT_ANSWER: "🎉 תשובה נכונה!\nהוספתי *{reward} יהלומים* לארנק שלך, יש לך *{total} יהלומים*! 💎{source}{nextRaffle}{dailyDone}",
  TRIVIA_WRONG_ANSWER: "😅 לא נורא... התשובה הנכונה היא: *{correctText}*.{source}\n\nאתם מוזמנים לצפות שוב בתוכנית! 📺{dailyDone}",
  GAME_REMINDERS_ON: "🔔 תזכורות הופעלו! נזכיר לכם כל יום.",
  GAME_REMINDERS_OFF: "🔕 תזכורות כובו. תמיד אפשר להפעיל מחדש.",
  GAME_DAILY_REMINDER: "🔔 *תזכורת יומית!*\nהגיע הזמן לשחק במשחק היומי של *רבי לילדים*! 🎮\nצברו יהלומים 💎 וזכו בפרסים! 🎁",
  GAME_EXPLANATION: "🎮 *איך עובד המשחק של רבי לילדים?*\n\nאוספים יהלומים וזוכים בפרסים! 💎\n\n🎯 השלמת משימה — יהלומים!\n🧠 תשובה נכונה בטריוויה — יהלומים!\n🎟️ כל 500 יהלומים = כרטיס להגרלה\n📲 כל מי שמצטרף דרכך = כרטיס נוסף!",
  GAME_PROFILE_CREATED: "מעולה! הפרופיל של *{name}* מוכן! 🎉\n\nמה תרצו לעשות עכשיו?",
  GAME_REMINDER_SET: "מצוין! נזכיר לכם כל יום ב-*{time}* 🔔\n\n{nextRaffle}⚠️ שימו לב: כדי שהבוט ימשיך לשלוח תזכורות, לחצו על הכפתור בהודעה שתקבלו.",
  GAME_REMINDER_EXISTS: "התזכורת עבור המשפחה שלכם כבר נקבעה לשעה *{time}* 🔔\n\nתרצו לשנות את השעה?",
};

export interface GameBot {
  id: string;
  org_id: string;
  slug: string;
  public_phone_number?: string | null;
  live_phone_display?: string | null;
  wa_phone_number_id?: string | null;
  test_wa_phone_number_id?: string | null;
  test_wa_access_token?: string | null;
  live_wa_phone_number_id?: string | null;
  live_wa_access_token?: string | null;
  wa_access_token?: string | null;
}

interface Ctx {
  bot: GameBot;
  env: BotEnv;
  creds: ResolvedCreds;
  phone: string;
}

type State = Record<string, unknown>;

// ── message lookup + var substitution ───────────────────────
async function getMsg(bot: GameBot, env: BotEnv, key: string, vars: Record<string, unknown> = {}): Promise<string> {
  const { data } = await db
    .from("smrtbot_messages")
    .select("text")
    .eq("org_id", bot.org_id)
    .eq("bot_id", bot.id)
    .eq("env", env)
    .eq("msg_key", key.toLowerCase())
    .maybeSingle();
  let text = (data?.text as string) || GAME_MESSAGES[key] || "";
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v ?? ""));
  }
  return text;
}

// ── state ───────────────────────────────────────────────────
async function getUserState(bot: GameBot, phone: string): Promise<State> {
  const { data } = await db
    .from("smrtbot_wa_users")
    .select("state_json")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .maybeSingle();
  return (data?.state_json as State) ?? {};
}

async function setUserState(bot: GameBot, phone: string, patch: State): Promise<void> {
  const current = await getUserState(bot, phone);
  const merged = { ...current, ...patch };
  const { error } = await db
    .from("smrtbot_wa_users")
    .upsert(
      { org_id: bot.org_id, bot_id: bot.id, phone, state_json: merged, last_interaction_at: new Date().toISOString() },
      { onConflict: "bot_id,phone" },
    );
  if (error) console.error("[smrtbot/game] setUserState", error.message);
}

// ── children ────────────────────────────────────────────────
interface Child {
  childId: string;
  name: string;
  diamonds: number;
  phone?: string;
  birthday?: string;
  completed?: string;
  reminderTime?: string | null;
  activeReminders?: boolean;
}

async function getChildrenForUser(bot: GameBot, phone: string): Promise<Child[]> {
  const { data } = await db
    .from("smrtbot_children")
    .select("child_id, child_name, diamonds, reminder_time, active_reminders")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .order("created_at", { ascending: true });
  return (data ?? []).map((c) => ({
    childId: c.child_id as string,
    name: c.child_name as string,
    diamonds: (c.diamonds as number) ?? 0,
    reminderTime: c.reminder_time as string | null,
    activeReminders: c.active_reminders as boolean,
  }));
}

async function getChildById(bot: GameBot, childId: string): Promise<Child | null> {
  const { data: c } = await db
    .from("smrtbot_children")
    .select("child_id, phone, child_name, hebrew_birthday, diamonds, completed_items, reminder_time, active_reminders")
    .eq("bot_id", bot.id)
    .eq("child_id", childId)
    .maybeSingle();
  if (!c) return null;
  return {
    childId: c.child_id as string,
    phone: c.phone as string,
    name: c.child_name as string,
    birthday: c.hebrew_birthday as string,
    diamonds: (c.diamonds as number) ?? 0,
    completed: (c.completed_items as string) ?? "",
    reminderTime: c.reminder_time as string | null,
    activeReminders: c.active_reminders as boolean,
  };
}

async function addChild(bot: GameBot, phone: string, childId: string, name: string, birthday: string): Promise<void> {
  const { error } = await db
    .from("smrtbot_children")
    .upsert(
      { org_id: bot.org_id, bot_id: bot.id, phone, child_id: childId, child_name: name, hebrew_birthday: birthday },
      { onConflict: "bot_id,child_id", ignoreDuplicates: true },
    );
  if (error) console.error("[smrtbot/game] addChild", error.message);
}

async function isCompleted(bot: GameBot, childId: string, itemId: string): Promise<boolean> {
  const c = await getChildById(bot, childId);
  return String(c?.completed ?? "").split(",").includes(String(itemId));
}

async function markCompleted(bot: GameBot, childId: string, itemId: string): Promise<void> {
  const c = await getChildById(bot, childId);
  const cur = String(c?.completed ?? "");
  const next = cur === "" ? String(itemId) : `${cur},${itemId}`;
  await db.from("smrtbot_children").update({ completed_items: next }).eq("bot_id", bot.id).eq("child_id", childId);
}

async function rewardDiamonds(bot: GameBot, childId: string, amount: number, actionType: string, itemId: string, phone: string): Promise<void> {
  const c = await getChildById(bot, childId);
  const newTotal = ((c?.diamonds as number) ?? 0) + amount;
  await db.from("smrtbot_children").update({ diamonds: newTotal }).eq("bot_id", bot.id).eq("child_id", childId);
  await db.from("smrtbot_diamonds_log").insert({
    org_id: bot.org_id, bot_id: bot.id, phone: phone || "", child_id: childId, action_type: actionType, item_id: itemId || "", diamonds_change: amount,
  });
}

async function getAllChildrenSorted(bot: GameBot): Promise<Child[]> {
  const { data } = await db
    .from("smrtbot_children")
    .select("child_id, phone, child_name, diamonds")
    .eq("bot_id", bot.id)
    .order("diamonds", { ascending: false });
  return (data ?? []).map((c) => ({
    childId: c.child_id as string, phone: c.phone as string, name: c.child_name as string, diamonds: (c.diamonds as number) ?? 0,
  }));
}

// ── missions / trivia from DB ───────────────────────────────
interface Mission { missionId: string; title: string; content: string; reward: number; successMessage: string; }
async function getMissions(bot: GameBot, env: BotEnv): Promise<Mission[]> {
  const { data } = await db
    .from("smrtbot_missions")
    .select("mission_id, title, content, reward_diamonds, success_message")
    .eq("bot_id", bot.id).eq("active", true).eq("env", env).order("sort_order");
  return (data ?? []).map((m) => ({
    missionId: m.mission_id as string, title: m.title as string, content: (m.content as string) ?? "",
    reward: (m.reward_diamonds as number) ?? 10, successMessage: (m.success_message as string) ?? "כל הכבוד!",
  }));
}
async function getMissionById(bot: GameBot, missionId: string, env: BotEnv): Promise<Mission | null> {
  const { data: m } = await db
    .from("smrtbot_missions")
    .select("mission_id, title, content, reward_diamonds, success_message")
    .eq("bot_id", bot.id).eq("mission_id", missionId).eq("env", env).maybeSingle();
  if (!m) return null;
  return { missionId, title: (m.title as string) ?? "", content: (m.content as string) ?? "", reward: (m.reward_diamonds as number) ?? 10, successMessage: (m.success_message as string) ?? "כל הכבוד!" };
}

interface Trivia {
  missionId: string; idNum: string; programNum: string; programTitle: string; level: string;
  content: string; option1: string; option2: string; option3: string; correctOption: string; source: string; reward: number;
}
function normalizeLevel(lvl: string): string {
  const l = String(lvl || "").trim().toLowerCase();
  if (l === "easy" || l === "קל") return "easy";
  if (l === "medium" || l === "בינוני") return "medium";
  if (l === "hard" || l === "קשה") return "hard";
  return l;
}
function triviaReward(level: string): number {
  const l = normalizeLevel(level);
  return l === "hard" ? GAME_CONFIG.TRIVIA_REWARD_HARD : l === "medium" ? GAME_CONFIG.TRIVIA_REWARD_MEDIUM : GAME_CONFIG.TRIVIA_REWARD_EASY;
}
async function getTrivia(bot: GameBot, env: BotEnv): Promise<Trivia[]> {
  const { data } = await db
    .from("smrtbot_trivia")
    .select("id, video_id, level, question, option_1, option_2, option_3, correct_option, source")
    .eq("bot_id", bot.id).eq("active", true).eq("env", env);
  return (data ?? []).map((t) => ({
    missionId: `TRIVIA_${t.id}`, idNum: String(t.id), programNum: t.video_id as string, programTitle: t.video_id as string,
    level: t.level as string, content: t.question as string, option1: t.option_1 as string, option2: t.option_2 as string,
    option3: (t.option_3 as string) ?? "", correctOption: String(t.correct_option), source: (t.source as string) ?? "", reward: triviaReward(t.level as string),
  }));
}

// ── raffle helpers ──────────────────────────────────────────
async function getNextRaffleDateText(bot: GameBot, raffleType = "Diamonds"): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db
    .from("smrtbot_raffles")
    .select("raffle_date, hebrew_date")
    .eq("bot_id", bot.id).eq("status", "Pending").eq("raffle_type", raffleType)
    .gte("raffle_date", today).order("raffle_date", { ascending: true }).limit(1).maybeSingle();
  if (!data) return "";
  if (data.hebrew_date) return String(data.hebrew_date);
  const d = new Date(data.raffle_date as string);
  const names = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  return `יום ${names[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getShareLink(bot: GameBot, phone: string): string {
  const publicNum = bot.public_phone_number || bot.live_phone_display || bot.live_wa_phone_number_id || bot.wa_phone_number_id || "";
  return `https://wa.me/${publicNum.replace(/[^\d]/g, "")}?text=שלום+הגעתי+דרך+${phone}`;
}

function getTodayDateStr(): string {
  const now = new Date();
  const il = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  il.setHours(il.getHours() - 5);
  return il.toISOString().slice(0, 10);
}

interface TriviaDaily { date: string; count: number; programNum: string | null; }
async function getChildTriviaToday(bot: GameBot, phone: string, childId: string): Promise<TriviaDaily> {
  const state = await getUserState(bot, phone);
  const today = getTodayDateStr();
  const saved = (state[`triviaDaily_${childId}`] as TriviaDaily) || {};
  if (saved.date !== today) return { date: today, count: 0, programNum: null };
  return { date: today, count: Number(saved.count || 0), programNum: saved.programNum || null };
}
async function setChildTriviaToday(bot: GameBot, phone: string, childId: string, data: TriviaDaily): Promise<void> {
  await setUserState(bot, phone, { [`triviaDaily_${childId}`]: data });
}
async function needsChildSelection(bot: GameBot, phone: string): Promise<boolean> {
  const children = await getChildrenForUser(bot, phone);
  if (children.length <= 1) return false;
  const state = await getUserState(bot, phone);
  if (!state.activeChildId) return true;
  return state.childSelectedDate !== getTodayDateStr();
}

export function parseHebrewBirthday(input: string): string | null {
  if (!input) return null;
  const MONTHS: Record<string, string[]> = {
    "ניסן": ["ניסן", "נסן"], "אייר": ["אייר"], "סיון": ["סיון", "סיוון"], "תמוז": ["תמוז"],
    "אב": ["אב"], "אלול": ["אלול"], "תשרי": ["תשרי"], "חשוון": ["חשוון", "חשון", "מרחשוון"],
    "כסלו": ["כסלו", "כסלוו"], "טבת": ["טבת"], "שבט": ["שבט"], "אדר": ["אדר"], "אדר א": ["אדר א"], "אדר ב": ["אדר ב"],
  };
  const DAYS = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ", "כא", "כב", "כג", "כד", "כה", "כו", "כז", "כח", "כט", "ל"];
  const text = String(input || "").trim();
  for (const [monthName, variants] of Object.entries(MONTHS)) {
    for (const variant of variants) {
      const m = text.match(new RegExp(`(${DAYS.join("|")})\\s+${variant}`, "i"));
      if (m) return `${m[1]} ${monthName}`;
    }
  }
  return null;
}

// ── send helpers bound to ctx ───────────────────────────────
const txt = async (c: Ctx, t: string): Promise<void> => { await sendText(c.creds, c.phone, t); };
const btns = async (c: Ctx, body: string, b: ReplyButton[]): Promise<void> => { await sendButtons(c.creds, c.phone, body, b); };
const list = async (c: Ctx, body: string, label: string, section: string, rows: ListRow[]): Promise<void> => {
  await sendList(c.creds, c.phone, body, label, rows, section);
};

// ── flows ───────────────────────────────────────────────────
async function startDailyGameFlow(c: Ctx): Promise<void> {
  const children = await getChildrenForUser(c.bot, c.phone);
  if (!children.length) {
    await txt(c, await getMsg(c.bot, c.env, "GAME_WELCOME_REGISTER"));
    await setUserState(c.bot, c.phone, { expectedInput: "REGISTER_CHILD_NAME" });
    return;
  }
  if (children.length === 1) return showChildGameMenu(c, children[0].childId);
  const rows: ListRow[] = children.map((ch) => ({ id: `select_child:${ch.childId}`, title: `${ch.name} 💎${ch.diamonds}` }));
  rows.push({ id: "game_add_child", title: "הוספת ילד נוסף ➕" });
  rows.push({ id: "game_settings", title: "הגדרות ⚙️" });
  await list(c, await getMsg(c.bot, c.env, "GAME_SELECT_CHILD"), "בחר משתמש", "פרופילים", rows);
}

async function showChildGameMenu(c: Ctx, childId: string): Promise<void> {
  const child = await getChildById(c.bot, childId);
  if (!child) return startDailyGameFlow(c);
  await setUserState(c.bot, c.phone, { activeChildId: childId, childSelectedDate: getTodayDateStr() });
  await btns(c, await getMsg(c.bot, c.env, "GAME_CHILD_MENU", { name: child.name, diamonds: child.diamonds }), [
    { id: "game_missions", title: "המשימות היומיות 🎯" },
    { id: "game_trivia", title: "משחק טריוויה 🧠" },
    { id: "game_referral", title: "שתף וזכה 📲" },
  ]);
  await btns(c, await getMsg(c.bot, c.env, "GAME_MORE_OPTIONS"), [
    { id: "game_leaderboard", title: "הדירוג שלי 🏆" },
    { id: "game_settings", title: "הגדרות ⚙️" },
    { id: "game_explain", title: "איך המשחק עובד? ℹ️" },
  ]);
}

async function runOnboarding(c: Ctx, input: string, state: State): Promise<void> {
  const exp = state.expectedInput as string;
  if (exp === "REGISTER_CHILD_NAME") {
    const name = input.trim();
    if (name.split(/\s+/).filter(Boolean).length < 2 || name.length > GAME_CONFIG.CHILD_NAME_MAX_LEN) {
      return txt(c, await getMsg(c.bot, c.env, "GAME_ASK_NAME_INVALID"));
    }
    await setUserState(c.bot, c.phone, { expectedInput: "REGISTER_CHILD_BIRTHDAY", tempChildName: name });
    return txt(c, await getMsg(c.bot, c.env, "GAME_ASK_BIRTHDAY", { name }));
  }
  if (exp === "REGISTER_CHILD_BIRTHDAY") {
    const name = (state.tempChildName as string) || "ילד";
    const bday = parseHebrewBirthday(input);
    if (!bday) return txt(c, await getMsg(c.bot, c.env, "GAME_ASK_BIRTHDAY_INVALID"));
    const childId = `${c.phone}_${Date.now()}`;
    await addChild(c.bot, c.phone, childId, name, bday);
    await setUserState(c.bot, c.phone, { expectedInput: "", activeChildId: childId, tempChildName: "", childSelectedDate: getTodayDateStr() });
    const siblings = await getChildrenForUser(c.bot, c.phone);
    const hasReminder = siblings.some((s) => s.childId !== childId && s.reminderTime && s.activeReminders);
    const buttons: ReplyButton[] = hasReminder
      ? [{ id: `select_child:${childId}`, title: "התחל לשחק 🎲" }, { id: "game_add_child", title: "הוסף ילד נוסף ➕" }]
      : [{ id: "game_set_reminders", title: "הגדרת תזכורות ⏰" }, { id: `select_child:${childId}`, title: "התחל לשחק 🎲" }, { id: "game_add_child", title: "הוסף ילד נוסף ➕" }];
    return btns(c, await getMsg(c.bot, c.env, "GAME_PROFILE_CREATED", { name }), buttons);
  }
  if (exp === "SET_REMINDER_TIME") {
    const hour = parseInt(input, 10);
    if (isNaN(hour) || hour < 8 || hour > 21) return txt(c, await getMsg(c.bot, c.env, "GAME_ASK_REMINDER_TIME_INVALID"));
    const time = `${hour}:00`;
    for (const ch of await getChildrenForUser(c.bot, c.phone)) {
      await db.from("smrtbot_children").update({ reminder_time: time }).eq("bot_id", c.bot.id).eq("child_id", ch.childId);
    }
    await setUserState(c.bot, c.phone, { expectedInput: "" });
    const nextRaffle = await getNextRaffleDateText(c.bot);
    return btns(c, await getMsg(c.bot, c.env, "GAME_REMINDER_SET", { time, nextRaffle: nextRaffle ? `🎟️ *הגרלת היהלומים* הבאה: *${nextRaffle}*\n\n` : "" }), [
      { id: (state.activeChildId as string) ? `select_child:${state.activeChildId}` : "main_general", title: "בואו נשחק! 🎲" },
      { id: "nav_home", title: "תפריט ראשי 🏠" },
    ]);
  }
  if (exp === "EDIT_CHILD_NAME") {
    const name = input.trim();
    if (name.split(/\s+/).filter(Boolean).length < 2 || name.length > GAME_CONFIG.CHILD_NAME_MAX_LEN) return txt(c, await getMsg(c.bot, c.env, "GAME_EDIT_NAME_INVALID"));
    const childId = state.activeChildId as string;
    if (!childId) { await setUserState(c.bot, c.phone, { expectedInput: "" }); return startDailyGameFlow(c); }
    await db.from("smrtbot_children").update({ child_name: name }).eq("bot_id", c.bot.id).eq("child_id", childId);
    await setUserState(c.bot, c.phone, { expectedInput: "" });
    return btns(c, await getMsg(c.bot, c.env, "GAME_EDIT_NAME_DONE", { name }), [
      { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "game_settings", title: "הגדרות ⚙️" },
    ]);
  }
  if (exp === "EDIT_CHILD_BIRTHDAY") {
    const bday = parseHebrewBirthday(input);
    if (!bday) return txt(c, await getMsg(c.bot, c.env, "GAME_EDIT_BIRTHDAY_INVALID"));
    const childId = state.activeChildId as string;
    if (!childId) { await setUserState(c.bot, c.phone, { expectedInput: "" }); return startDailyGameFlow(c); }
    await db.from("smrtbot_children").update({ hebrew_birthday: bday }).eq("bot_id", c.bot.id).eq("child_id", childId);
    await setUserState(c.bot, c.phone, { expectedInput: "" });
    return btns(c, await getMsg(c.bot, c.env, "GAME_EDIT_BIRTHDAY_DONE", { date: bday }), [
      { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "game_settings", title: "הגדרות ⚙️" },
    ]);
  }
  await setUserState(c.bot, c.phone, { expectedInput: "" });
  return startDailyGameFlow(c);
}

async function showDailyMissions(c: Ctx): Promise<void> {
  if (await needsChildSelection(c.bot, c.phone)) return startDailyGameFlow(c);
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  const all = await getMissions(c.bot, c.env);
  const child = await getChildById(c.bot, childId);
  const completed = String(child?.completed ?? "").split(",");
  const available = all.filter((m) => !completed.includes(m.missionId));
  if (!available.length) {
    return btns(c, await getMsg(c.bot, c.env, "GAME_ALL_MISSIONS_DONE"), [
      { id: "game_leaderboard", title: "הדירוג שלי 🏆" }, { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "nav_home", title: "תפריט ראשי 🏠" },
    ]);
  }
  const rows: ListRow[] = available.slice(0, 10).map((m) => ({ id: `do_mission:${m.missionId}`, title: String(m.title || m.content).slice(0, 24), description: String(m.content).slice(0, 72) }));
  await list(c, await getMsg(c.bot, c.env, "GAME_MISSIONS_HEADER"), "בחר משימה", "משימות", rows);
}

async function showActionMission(c: Ctx, missionId: string): Promise<void> {
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  if (await isCompleted(c.bot, childId, missionId)) {
    return btns(c, await getMsg(c.bot, c.env, "GAME_MISSION_ALREADY_DONE"), [
      { id: "game_missions", title: "משימה נוספת 🎯" }, { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" },
    ]);
  }
  const mission = await getMissionById(c.bot, missionId, c.env);
  if (!mission) return txt(c, await getMsg(c.bot, c.env, "GAME_MISSION_NOT_FOUND"));
  await btns(c, await getMsg(c.bot, c.env, "GAME_MISSION_DETAIL", { content: mission.content, reward: mission.reward }), [
    { id: `confirm_mission:${missionId}`, title: "השלמתי המשימה ✅" }, { id: "game_missions", title: "משימה אחרת 🎯" },
  ]);
}

async function executeActionMission(c: Ctx, missionId: string): Promise<void> {
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  if (await isCompleted(c.bot, childId, missionId)) return;
  const mission = await getMissionById(c.bot, missionId, c.env);
  const reward = mission ? mission.reward : 10;
  await rewardDiamonds(c.bot, childId, reward, "Action_Mission", missionId, c.phone);
  await markCompleted(c.bot, childId, missionId);
  const updated = await getChildById(c.bot, childId);
  const nextRaffle = await getNextRaffleDateText(c.bot);
  const text = await getMsg(c.bot, c.env, "GAME_MISSION_COMPLETE", { success: mission?.successMessage ?? "כל הכבוד!", reward, total: updated?.diamonds ?? "?" });
  await btns(c, text + (nextRaffle ? `\n\n🎟️ *הגרלת היהלומים* הבאה: *${nextRaffle}*` : ""), [
    { id: "game_missions", title: "משימה נוספת 🎯" }, { id: "game_leaderboard", title: "הדירוג שלי 🏆" }, { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" },
  ]);
}

async function showDailyTriviaProgram(c: Ctx): Promise<void> {
  if (await needsChildSelection(c.bot, c.phone)) return startDailyGameFlow(c);
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  const daily = await getChildTriviaToday(c.bot, c.phone, childId);
  if (daily.count >= GAME_CONFIG.TRIVIA_DAILY_LIMIT) {
    return btns(c, await getMsg(c.bot, c.env, "TRIVIA_DAILY_LIMIT_REACHED", { limit: GAME_CONFIG.TRIVIA_DAILY_LIMIT }), [
      { id: "game_leaderboard", title: "הדירוג שלי 🏆" }, { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "nav_home", title: "תפריט ראשי 🏠" },
    ]);
  }
  const child = await getChildById(c.bot, childId);
  const completed = String(child?.completed ?? "").split(",");
  const triviaList = (await getTrivia(c.bot, c.env)).filter((t) => !completed.includes(t.missionId));
  if (!triviaList.length) {
    return btns(c, await getMsg(c.bot, c.env, "GAME_ALL_TRIVIA_DONE"), [
      { id: "game_leaderboard", title: "הדירוג שלי 🏆" }, { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" },
    ]);
  }
  const hasSaved = daily.programNum && triviaList.some((t) => t.programNum === daily.programNum);
  const progNum = hasSaved ? (daily.programNum as string) : triviaList[0].programNum;
  const resolved = triviaList.find((t) => t.programNum === progNum);
  const progQs = triviaList.filter((q) => q.programNum === progNum);
  if (!hasSaved) await setChildTriviaToday(c.bot, c.phone, childId, { ...daily, programNum: progNum });
  const remaining = Math.min(progQs.length, GAME_CONFIG.TRIVIA_DAILY_LIMIT - daily.count);
  const levels = new Set(progQs.map((q) => normalizeLevel(q.level)));
  const b: ReplyButton[] = [];
  if (levels.has("easy")) b.push({ id: `triv_lvl:${progNum}:easy`, title: "קל 🟢" });
  if (levels.has("medium")) b.push({ id: `triv_lvl:${progNum}:medium`, title: "בינוני 🟡" });
  if (levels.has("hard")) b.push({ id: `triv_lvl:${progNum}:hard`, title: "קשה 🔴" });
  if (!b.length) b.push({ id: `triv_lvl:${progNum}:${progQs[0].level}`, title: "התחל טריוויה 🧠" });
  await btns(c, await getMsg(c.bot, c.env, "TRIVIA_CHOOSE_LEVEL", { programTitle: resolved?.programTitle || progNum, remaining }), b.slice(0, 3));
}

async function startVideoTrivia(c: Ctx, progNum: string, level: string): Promise<void> {
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  const daily = await getChildTriviaToday(c.bot, c.phone, childId);
  if (daily.count >= GAME_CONFIG.TRIVIA_DAILY_LIMIT) {
    return btns(c, await getMsg(c.bot, c.env, "TRIVIA_DAILY_LIMIT_REACHED", { limit: GAME_CONFIG.TRIVIA_DAILY_LIMIT }), [
      { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "nav_home", title: "תפריט ראשי 🏠" },
    ]);
  }
  const child = await getChildById(c.bot, childId);
  const completed = String(child?.completed ?? "").split(",");
  const triviaList = (await getTrivia(c.bot, c.env)).filter((t) => !completed.includes(t.missionId));
  const q = triviaList.find((t) => t.programNum === progNum && normalizeLevel(t.level) === normalizeLevel(level));
  if (!q) return btns(c, await getMsg(c.bot, c.env, "TRIVIA_LEVEL_DONE"), [{ id: "game_trivia", title: "חזרה לרמות 🧠" }]);
  if (!daily.programNum) await setChildTriviaToday(c.bot, c.phone, childId, { ...daily, programNum: progNum });
  await setUserState(c.bot, c.phone, { activeMissionId: q.missionId });
  const src = q.source ? `\n\n💡 *מקור:* ${q.source}` : "";
  await btns(c, await getMsg(c.bot, c.env, "TRIVIA_QUESTION_DISPLAY", {
    content: q.content, option1: q.option1, option2: q.option2, option3: q.option3 ? `\nג. ${q.option3}` : "", source: src,
  }), [
    { id: `ans_trivia:${q.missionId}:1`, title: "תשובה א'" },
    { id: `ans_trivia:${q.missionId}:2`, title: "תשובה ב'" },
    { id: `ans_trivia:${q.missionId}:3`, title: "תשובה ג'" },
  ]);
}

async function evaluateTriviaAnswer(c: Ctx, missionId: string, answerNum: string): Promise<void> {
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  if (await isCompleted(c.bot, childId, missionId)) {
    return btns(c, await getMsg(c.bot, c.env, "TRIVIA_ALREADY_ANSWERED"), [{ id: "game_trivia", title: "שאלה נוספת 🧠" }]);
  }
  const triviaId = missionId.replace("TRIVIA_", "");
  const { data: q } = await db.from("smrtbot_trivia").select("*").eq("bot_id", c.bot.id).eq("id", triviaId).maybeSingle();
  if (!q) return txt(c, await getMsg(c.bot, c.env, "TRIVIA_NOT_FOUND"));
  const reward = triviaReward(q.level as string);
  const isCorrect = String(answerNum) === String(q.correct_option);
  const sourceText = q.source ? `\n💡 *מקור:* ${q.source}` : "";
  await markCompleted(c.bot, childId, missionId);
  await setUserState(c.bot, c.phone, { activeMissionId: "" });
  const daily = await getChildTriviaToday(c.bot, c.phone, childId);
  const newCount = daily.count + 1;
  await setChildTriviaToday(c.bot, c.phone, childId, { date: getTodayDateStr(), count: newCount, programNum: daily.programNum || "" });
  const isDailyDone = newCount >= GAME_CONFIG.TRIVIA_DAILY_LIMIT;
  const dailyDoneMsg = isDailyDone ? await getMsg(c.bot, c.env, "TRIVIA_DAILY_DONE_SUFFIX", { limit: GAME_CONFIG.TRIVIA_DAILY_LIMIT }) : "";
  const tailButtons: ReplyButton[] = isDailyDone
    ? [{ id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "game_leaderboard", title: "הדירוג שלי 🏆" }, { id: "nav_home", title: "תפריט ראשי 🏠" }]
    : [{ id: "game_trivia", title: "שאלה נוספת 🔄" }, { id: "game_leaderboard", title: "הדירוג שלי 🏆" }, { id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }];
  if (isCorrect) {
    await rewardDiamonds(c.bot, childId, reward, "Trivia", missionId, c.phone);
    const updated = await getChildById(c.bot, childId);
    const nextRaffle = await getNextRaffleDateText(c.bot);
    await btns(c, await getMsg(c.bot, c.env, "TRIVIA_CORRECT_ANSWER", {
      reward, total: updated?.diamonds ?? "?", source: sourceText, nextRaffle: nextRaffle ? `\n🎟️ *הגרלת היהלומים* הבאה: *${nextRaffle}*` : "", dailyDone: dailyDoneMsg,
    }), tailButtons);
  } else {
    const opts = [q.option_1, q.option_2, q.option_3];
    const idx = (q.correct_option as number) - 1;
    const correctText = `${["א", "ב", "ג"][idx]}. ${opts[idx] ?? ""}`;
    await btns(c, await getMsg(c.bot, c.env, "TRIVIA_WRONG_ANSWER", { correctText, source: sourceText, dailyDone: dailyDoneMsg }), tailButtons);
  }
}

async function showLeaderboard(c: Ctx): Promise<void> {
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  const child = await getChildById(c.bot, childId);
  const all = await getAllChildrenSorted(c.bot);
  const rank = all.findIndex((x) => x.childId === childId) + 1;
  const title = await getMsg(c.bot, c.env, "leaderboard_header") || "🏆 *טבלת הדירוג*";
  const footer = await getMsg(c.bot, c.env, "leaderboard_footer") || "💡 כל 500 יהלומים = כרטיס ל*הגרלת היהלומים* הקרובה!";
  const lines = [`${title}\n`];
  all.slice(0, 10).forEach((x, j) => {
    const medal = j === 0 ? "🥇" : j === 1 ? "🥈" : j === 2 ? "🥉" : `${j + 1}.`;
    lines.push(`${medal} ${x.name} - ${x.diamonds} 💎${x.childId === childId ? " ⬅️" : ""}`);
  });
  if (rank > 10 && child) lines.push(`\n...\n${rank}. ${child.name} - ${child.diamonds} 💎 ⬅️`);
  lines.push(`\n${footer}`);
  await btns(c, lines.join("\n"), [{ id: `select_child:${childId}`, title: "חזרה למשחק 🎲" }, { id: "nav_home", title: "תפריט ראשי 🏠" }]);
}

async function showShareMenu(c: Ctx): Promise<void> {
  const { data } = await db.from("smrtbot_wa_users").select("share_tickets").eq("bot_id", c.bot.id).eq("phone", c.phone).maybeSingle();
  const tickets = Number(data?.share_tickets ?? 0);
  await btns(c, await getMsg(c.bot, c.env, "GAME_SHARE_MENU", { tickets }), [
    { id: "share_groups", title: "שיתוף לחברים 👥" }, { id: "share_status", title: "לשיתוף בסטטוס 👏" },
  ]);
}

async function sendShare(c: Ctx, msgKey: string): Promise<void> {
  const link = getShareLink(c.bot, c.phone);
  const { data } = await db.from("smrtbot_messages").select("text").eq("org_id", c.bot.org_id).eq("bot_id", c.bot.id).eq("env", c.env).eq("msg_key", msgKey).maybeSingle();
  const body = String((data?.text as string) ?? "").replace(/\{link\}/g, link);
  if (body) await txt(c, body);
}

async function sendGameSettings(c: Ctx): Promise<void> {
  await list(c, await getMsg(c.bot, c.env, "GAME_SETTINGS_HEADER"), "בחר", "הגדרות", [
    { id: "game_turn_off_reminders", title: "כבה תזכורות 🔕" },
    { id: "game_turn_on_reminders", title: "הפעל תזכורות 🔔" },
    { id: "game_change_reminder", title: "שנה שעת תזכורת ⏰" },
    { id: "game_edit_child", title: "ערוך פרופיל ילד ✏️", description: "שנה שם או תאריך לידה" },
    { id: "game_add_child", title: "הוסף ילד נוסף ➕" },
    { id: "game_switch_child", title: "החלף משחק לילד אחר 🔄" },
    { id: "nav_home", title: "תפריט ראשי 🏠" },
  ]);
}

async function startReminderTimeSetup(c: Ctx): Promise<void> {
  const children = await getChildrenForUser(c.bot, c.phone);
  const existing = children.find((ch) => ch.reminderTime && ch.activeReminders);
  if (existing) {
    await setUserState(c.bot, c.phone, { expectedInput: "CONFIRM_CHANGE_REMINDER" });
    return btns(c, await getMsg(c.bot, c.env, "GAME_REMINDER_EXISTS", { time: existing.reminderTime }), [
      { id: "game_confirm_change_reminder", title: "כן, לשנות ⏰" }, { id: "nav_home", title: "לא, תודה 🏠" },
    ]);
  }
  await setUserState(c.bot, c.phone, { expectedInput: "SET_REMINDER_TIME" });
  await txt(c, await getMsg(c.bot, c.env, "GAME_ASK_REMINDER_TIME"));
}

async function toggleReminders(c: Ctx, active: boolean): Promise<void> {
  for (const ch of await getChildrenForUser(c.bot, c.phone)) {
    await db.from("smrtbot_children").update({ active_reminders: active }).eq("bot_id", c.bot.id).eq("child_id", ch.childId);
  }
  await btns(c, await getMsg(c.bot, c.env, active ? "GAME_REMINDERS_ON" : "GAME_REMINDERS_OFF"), [
    { id: "game_settings", title: "הגדרות ⚙️" }, { id: "nav_home", title: "תפריט ראשי 🏠" },
  ]);
}

async function showEditChildMenu(c: Ctx): Promise<void> {
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  if (!childId) return startDailyGameFlow(c);
  const child = await getChildById(c.bot, childId);
  if (!child) return startDailyGameFlow(c);
  await btns(c, await getMsg(c.bot, c.env, "GAME_EDIT_PROFILE_MENU", { name: child.name }), [
    { id: "game_edit_name", title: "שינוי שם ✏️" }, { id: "game_edit_birthday", title: "שינוי תאריך לידה 🎂" }, { id: "game_settings", title: "חזרה להגדרות ⚙️" },
  ]);
}

async function sendGameExplanation(c: Ctx): Promise<void> {
  await txt(c, await getMsg(c.bot, c.env, "GAME_EXPLANATION"));
  const state = await getUserState(c.bot, c.phone);
  const childId = state.activeChildId as string;
  await btns(c, await getMsg(c.bot, c.env, "GAME_WHAT_NEXT"), [
    { id: childId ? `select_child:${childId}` : "main_general", title: "🎲 בואו נשחק!" },
    { id: "game_referral", title: "📲 אני רוצה לשתף!" },
    { id: "game_settings", title: "⚙️ הגדרות" },
  ]);
}

/**
 * Dispatch a button/list id (or menu node action) to a game handler.
 * Returns true if the action was a game action and was handled.
 */
export async function handleGameAction(bot: GameBot, env: BotEnv, phone: string, action: string): Promise<boolean> {
  const creds = resolveCreds(bot, env);
  if (!creds) return false;
  const c: Ctx = { bot, env, creds, phone };

  if (action === "main_general" || action === "game_daily" || action === "game_switch_child") { await startDailyGameFlow(c); return true; }
  if (action.startsWith("select_child:")) { await showChildGameMenu(c, action.slice("select_child:".length)); return true; }
  if (action === "game_add_child") { await setUserState(bot, phone, { expectedInput: "REGISTER_CHILD_NAME" }); await txt(c, await getMsg(bot, env, "GAME_ADD_CHILD_PROMPT")); return true; }
  if (action === "game_missions") { await showDailyMissions(c); return true; }
  if (action.startsWith("do_mission:")) { await showActionMission(c, action.slice("do_mission:".length)); return true; }
  if (action.startsWith("confirm_mission:")) { await executeActionMission(c, action.slice("confirm_mission:".length)); return true; }
  if (action === "game_trivia") { await showDailyTriviaProgram(c); return true; }
  if (action.startsWith("triv_lvl:")) { const [, prog, lvl] = action.split(":"); await startVideoTrivia(c, prog, lvl); return true; }
  if (action.startsWith("ans_trivia:")) { const parts = action.split(":"); await evaluateTriviaAnswer(c, parts[1], parts[2]); return true; }
  if (action === "game_leaderboard") { await showLeaderboard(c); return true; }
  if (action === "game_referral") { await showShareMenu(c); return true; }
  if (action === "share_groups") { await sendShare(c, "share_groups_message"); await sendShare(c, "share_groups_instructions"); return true; }
  if (action === "share_status") { await sendShare(c, "share_status_message"); await sendShare(c, "share_status_instructions"); return true; }
  if (action === "game_settings") { await sendGameSettings(c); return true; }
  if (action === "game_explain") { await sendGameExplanation(c); return true; }
  if (action === "game_edit_child") { await showEditChildMenu(c); return true; }
  if (action === "game_edit_name") { await setUserState(bot, phone, { expectedInput: "EDIT_CHILD_NAME" }); await txt(c, await getMsg(bot, env, "GAME_ASK_NEW_NAME")); return true; }
  if (action === "game_edit_birthday") { await setUserState(bot, phone, { expectedInput: "EDIT_CHILD_BIRTHDAY" }); await txt(c, await getMsg(bot, env, "GAME_ASK_NEW_BIRTHDAY")); return true; }
  if (action === "game_set_reminders" || action === "game_change_reminder") { await startReminderTimeSetup(c); return true; }
  if (action === "game_confirm_change_reminder") { await setUserState(bot, phone, { expectedInput: "SET_REMINDER_TIME" }); await txt(c, await getMsg(bot, env, "GAME_ASK_REMINDER_TIME")); return true; }
  if (action === "game_turn_off_reminders") { await toggleReminders(c, false); return true; }
  if (action === "game_turn_on_reminders") { await toggleReminders(c, true); return true; }
  return false;
}

/** Onboarding / edit text input. Call when state.expectedInput is set. */
export async function handleGameText(bot: GameBot, env: BotEnv, phone: string, text: string, state: State): Promise<void> {
  const creds = resolveCreds(bot, env);
  if (!creds) return;
  return runOnboarding({ bot, env, creds, phone }, text, state);
}

// ── referral (called from engine on first interaction with ?ref=) ───────────
export async function processReferral(bot: GameBot, env: BotEnv, newPhone: string, referrerPhone: string): Promise<void> {
  if (!referrerPhone || newPhone === referrerPhone) return;
  const { data } = await db.from("smrtbot_wa_users").select("share_tickets").eq("bot_id", bot.id).eq("phone", referrerPhone).maybeSingle();
  const next = Number(data?.share_tickets ?? 0) + 1;
  await db.from("smrtbot_wa_users").upsert({ org_id: bot.org_id, bot_id: bot.id, phone: referrerPhone, share_tickets: next }, { onConflict: "bot_id,phone" });
  await db.from("smrtbot_referral_log").insert({ org_id: bot.org_id, bot_id: bot.id, referrer_phone: referrerPhone, new_phone: newPhone });
  const creds = resolveCreds(bot, env);
  if (creds) { try { await sendText(creds, referrerPhone, await getMsg(bot, env, "GAME_REFERRAL_NOTIFY")); } catch { /* ignore */ } }
}

// ── cron entry points (called per-bot from jobs.ts) ─────────
export async function sendScheduledReminders(bot: GameBot, env: BotEnv, hourLabel: string): Promise<number> {
  const creds = resolveCreds(bot, env);
  if (!creds) return 0;
  const { data } = await db.from("smrtbot_children").select("phone").eq("bot_id", bot.id).eq("reminder_time", hourLabel).eq("active_reminders", true);
  const seen = new Set<string>();
  let sent = 0;
  const msg = await getMsg(bot, env, "GAME_DAILY_REMINDER");
  for (const row of (data ?? []) as { phone: string }[]) {
    if (!row.phone || seen.has(row.phone)) continue;
    seen.add(row.phone);
    try {
      await sendButtons(creds, row.phone, msg, [{ id: "main_general", title: "בואו נשחק! 🎲" }, { id: "nav_home", title: "תפריט ראשי 🏠" }]);
      sent++;
    } catch { /* logged by caller */ }
  }
  return sent;
}

export async function executeRaffle(bot: GameBot, env: BotEnv, raffleType: string): Promise<string | null> {
  const creds = resolveCreds(bot, env);
  const { data: coupon } = await db.from("smrtbot_coupons").select("coupon_code, description").eq("bot_id", bot.id).eq("status", "available").eq("raffle_type", raffleType).limit(1).maybeSingle();
  if (!coupon) return null;
  const code = coupon.coupon_code as string;
  const desc = (coupon.description as string) || "פרס מיוחד";
  let winnerPhone = "", winnerId = "", winnerMsg = "";

  if (raffleType === "Referrals") {
    const { data: users } = await db.from("smrtbot_wa_users").select("phone, share_tickets").eq("bot_id", bot.id).gt("share_tickets", 0);
    const pool: string[] = [];
    for (const u of (users ?? []) as { phone: string; share_tickets: number }[]) for (let i = 0; i < Number(u.share_tickets); i++) pool.push(u.phone);
    if (!pool.length) return null;
    winnerPhone = pool[Math.floor(Math.random() * pool.length)];
    winnerId = winnerPhone;
    winnerMsg = await getMsg(bot, env, "RAFFLE_WINNER_REFERRALS", { desc, code });
    await db.from("smrtbot_wa_users").update({ share_tickets: 0 }).eq("bot_id", bot.id);
  } else {
    const all = await getAllChildrenSorted(bot);
    const pool: Child[] = [];
    for (const ch of all) { const t = Math.floor(ch.diamonds / 500); for (let i = 0; i < t; i++) pool.push(ch); }
    if (!pool.length) return null;
    const w = pool[Math.floor(Math.random() * pool.length)];
    winnerPhone = w.phone ?? "";
    winnerId = w.childId;
    winnerMsg = await getMsg(bot, env, "RAFFLE_WINNER_DIAMONDS", { name: w.name, desc, code });
    await db.from("smrtbot_children").update({ diamonds: 0 }).eq("bot_id", bot.id);
  }

  const today = new Date().toISOString().slice(0, 10);
  await db.from("smrtbot_raffles").update({ status: "Completed", winner_child_id: winnerId, coupon_code: code }).eq("bot_id", bot.id).eq("raffle_date", today).eq("raffle_type", raffleType);
  await db.from("smrtbot_coupons").update({ status: "used", winner_child_id: winnerId, won_at: new Date().toISOString() }).eq("bot_id", bot.id).eq("coupon_code", code);
  if (winnerPhone && creds) { try { await sendText(creds, winnerPhone, winnerMsg); } catch { /* ignore */ } }
  return winnerId;
}
