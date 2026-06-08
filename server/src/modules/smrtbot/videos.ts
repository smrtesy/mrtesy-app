/**
 * smrtBot — video lists, free-text video search, holidays, and nav actions.
 * Ported from botsite webhook.js (sendVideoList/sendVideoPage/handleAction +
 * holidays) and sheets.js (filterByListKey/searchVideos), reading the migrated
 * smrtbot_videos / smrtbot_holidays tables instead of the Google Sheet.
 *
 * Behavioural verification pending (needs a test bot). Compiles clean and
 * mirrors the botsite flows.
 */
import { db } from "../../db";
import {
  resolveCreds, sendText, sendButtons, sendList,
  type BotEnv, type ResolvedCreds, type ReplyButton,
} from "./wa";
import { getSubscriberContext, watchLinkFor } from "./identity";
import { getBotConfig } from "./config";
import type { BotRow } from "./engine";

type State = Record<string, unknown>;

interface Ctx { bot: BotRow; env: BotEnv; creds: ResolvedCreds; phone: string }

async function msg(bot: BotRow, env: BotEnv, key: string, fallback: string): Promise<string> {
  const { data } = await db.from("smrtbot_messages").select("text")
    .eq("org_id", bot.org_id).eq("bot_id", bot.id).eq("env", env).eq("msg_key", key).maybeSingle();
  return (data?.text as string) || fallback;
}
async function getState(botId: string, phone: string): Promise<State> {
  const { data } = await db.from("smrtbot_wa_users").select("state_json").eq("bot_id", botId).eq("phone", phone).maybeSingle();
  return (data?.state_json as State) ?? {};
}
async function setState(bot: BotRow, phone: string, patch: State): Promise<void> {
  const current = await getState(bot.id, phone);
  const merged = { ...current, ...patch };
  await db.from("smrtbot_wa_users").upsert(
    { org_id: bot.org_id, bot_id: bot.id, phone, state_json: merged, last_interaction_at: new Date().toISOString() },
    { onConflict: "bot_id,phone" });
}

function normalizeHe(s: string): string {
  return String(s || "").replace(/[֑-ׇ]/g, "").replace(/["'.,!?;:()\-]/g, " ").replace(/\s+/g, " ").trim();
}
const eq = (a: string, b: string) => normalizeHe(a) === normalizeHe(b);

interface VideoRow {
  vd_id: string | null; video_number: string | null; video_name: string | null; video_link: string | null; full_url: string | null;
  display_link: string | null; main_category: string | null; sub_category: string | null;
  rebbe: string | null; holidays: string | null; icon: string | null; search_text: string | null;
  languages: string[] | null;
}

// listKey → { main, subs[] }  (ported from sheets.js filterByListKey switch)
const FILTERS: Record<string, { main: string; subs: string[] }> = {
  story_kedumim: { main: "שעת סיפור", subs: ["ממקורות קדומים"] },
  story_chassidim: { main: "שעת סיפור", subs: ["סיפורי חסידים"] },
  moshiach_bring: { main: "לחיות משיח", subs: ["מביאים את משיח"] },
  moshiach_temple: { main: "לחיות משיח", subs: ["בית המקדש והגאולה"] },
  moshiach_rebbe: { main: "לחיות משיח", subs: ["הרבי כמלך המשיח"] },
  moshiach_geulah_life: { main: "לחיות משיח", subs: ["חיים של גאולה"] },
  niggun_holidays: { main: "זמן ניגונים", subs: ["ניגוני חגים וימי דפגרא"] },
  niggun_moshiach: { main: "זמן ניגונים", subs: ["ניגוני משיח וגאולה"] },
  niggun_simcha: { main: "זמן ניגונים", subs: ["ניגוני שמחה וריקוד"] },
  niggun_dveikus: { main: "זמן ניגונים", subs: ["ניגוני דבקות והתעוררות"] },
  niggun_chabad: { main: "זמן ניגונים", subs: ["ניגוני חב״ד קלאסיים"] },
  topic_tzivos: { main: "נושאים נוספים", subs: ["צבאות השם"] },
  topic_hiskashrus: { main: "נושאים נוספים", subs: ["התקשרות לרבי"] },
  topic_middos: { main: "נושאים נוספים", subs: ["מידות טובות"] },
  topic_pride: { main: "נושאים נוספים", subs: ["גאווה יהודית"] },
  topic_torah: { main: "נושאים נוספים", subs: ["תורה ומצוות", "תורה, תפילה ומצוות"] },
  topic_girls: { main: "נושאים נוספים", subs: ["בנות ישראל"] },
  topic_12psukim: { main: "נושאים נוספים", subs: ["י״ב הפסוקים"] },
  topic_weekly: { main: "נושאים נוספים", subs: ["התוכנית השבועית"] },
  topic_kids_action: { main: "נושאים נוספים", subs: ["ילדים בפעולה"] },
};

async function allVideos(bot: BotRow): Promise<VideoRow[]> {
  const { data, error } = await db.from("smrtbot_videos")
    .select("vd_id, video_number, video_name, video_link, full_url, display_link, main_category, sub_category, rebbe, holidays, icon, search_text, languages")
    .eq("org_id", bot.org_id).eq("active", true);
  if (error) console.error("[smrtbot/videos] allVideos", error.message);
  let vids = (data as VideoRow[]) ?? [];
  // Per-domain availability: a bot with a locale only serves videos tagged for
  // it (or untagged = available everywhere). No locale set → serve all.
  const locale = (await getBotConfig(bot.id, "VIDEO_LOCALE", "VIDEO_LOCALE")) || "";
  if (locale) {
    vids = vids.filter((v) => !v.languages || v.languages.length === 0 || v.languages.includes(locale));
  }
  return vids;
}

async function filterVideos(bot: BotRow, listKey: string): Promise<VideoRow[]> {
  const videos = await allVideos(bot);
  if (listKey.startsWith("holiday:")) {
    const h = listKey.slice("holiday:".length);
    return videos.filter((v) => (v.holidays ?? "").split(/[,;|]/).some((x) => eq(x, h)));
  }
  if (listKey.startsWith("niggun_rebbe:")) {
    const r = listKey.slice("niggun_rebbe:".length);
    return videos.filter((v) => eq(v.main_category ?? "", "זמן ניגונים") && eq(v.sub_category ?? "", "ניגוני רבותינו נשיאינו") && eq(v.rebbe ?? "", r));
  }
  if (listKey.startsWith("rebbe:")) {
    const r = listKey.slice("rebbe:".length);
    return videos.filter((v) => eq(v.main_category ?? "", "שעת סיפור") && eq(v.sub_category ?? "", "רבותינו נשיאינו") && eq(v.rebbe ?? "", r));
  }
  const f = FILTERS[listKey];
  if (!f) return [];
  return videos.filter((v) => eq(v.main_category ?? "", f.main) && f.subs.some((s) => eq(v.sub_category ?? "", s)));
}

async function navButtons(c: Ctx, hasMore: boolean): Promise<void> {
  const btns: ReplyButton[] = [];
  if (hasMore) btns.push({ id: "nav_more", title: "➕ עוד" });
  btns.push({ id: "nav_home", title: "🏠 תפריט ראשי" });
  btns.push({ id: "nav_share", title: "📲 שתף להורים" });
  await sendButtons(c.creds, c.phone, await msg(c.bot, c.env, "nav_buttons_header", "ועוד אפשרויות:"), btns.slice(0, 3));
}

async function sendVideoPage(c: Ctx, listKey: string, listTitle: string, offset: number, items?: VideoRow[]): Promise<void> {
  const vids = items ?? (await filterVideos(c.bot, listKey));
  if (!vids.length) {
    await sendText(c.creds, c.phone, await msg(c.bot, c.env, "no_results", "😔 לא נמצאו וידאוים."));
    await navButtons(c, false);
    return;
  }
  const pageSize = vids.length <= 12 ? 12 : 10;
  const safeOffset = Math.max(0, offset);
  const page = vids.slice(safeOffset, safeOffset + pageSize);
  const countText = (await msg(c.bot, c.env, "video_list_count", 'סה"כ {count} וידאוים')).replace("{count}", String(vids.length));
  const ctx = await getSubscriberContext(c.bot, c.phone);
  const lines = [`*${listTitle}*`, countText, ""];
  for (const item of page) {
    lines.push(`${item.icon || "🎬"} *${item.video_name ?? ""}*`);
    const link = await watchLinkFor(item, ctx);
    if (link) lines.push(link);
    lines.push("");
  }
  const pag = (await msg(c.bot, c.env, "video_list_pagination", "מציג {from}–{to} מתוך {total}"))
    .replace("{from}", String(safeOffset + 1)).replace("{to}", String(safeOffset + page.length)).replace("{total}", String(vids.length));
  lines.push(pag);
  await sendText(c.creds, c.phone, lines.join("\n"));
  await setState(c.bot, c.phone, { currentListKey: listKey, currentListTitle: listTitle, currentOffset: safeOffset });
  await navButtons(c, safeOffset + pageSize < vids.length);
}

/** Render a video_list-type menu node. */
export async function sendVideoList(c: Ctx, node: { node_key: string; label: string }): Promise<void> {
  const items = await filterVideos(c.bot, node.node_key);
  await sendVideoPage(c, node.node_key, node.label, 0, items);
}

async function sendHolidays(c: Ctx, upcomingOnly: boolean): Promise<void> {
  let q = db.from("smrtbot_holidays").select("holiday_name, hebrew_date, display_emoji, start_date")
    .eq("org_id", c.bot.org_id).eq("bot_id", c.bot.id).eq("env", c.env).eq("active", true).order("sort_order");
  if (upcomingOnly) q = q.gte("end_date", new Date().toISOString().slice(0, 10));
  const { data } = await q;
  const rows = (data as { holiday_name: string; hebrew_date: string | null; display_emoji: string | null }[]) ?? [];
  if (!rows.length) {
    await sendText(c.creds, c.phone, await msg(c.bot, c.env, "no_holidays", "אין חגים להצגה כרגע."));
    await navButtons(c, false);
    return;
  }
  const lines = [`*${await msg(c.bot, c.env, upcomingOnly ? "holidays_upcoming_title" : "holidays_all_title", upcomingOnly ? "🗓️ חגים קרובים" : "🗓️ כל החגים")}*`, ""];
  for (const h of rows) lines.push(`${h.display_emoji || "📅"} *${h.holiday_name}*${h.hebrew_date ? ` — ${h.hebrew_date}` : ""}`);
  await sendText(c.creds, c.phone, lines.join("\n"));
  await navButtons(c, false);
}

async function runSearch(c: Ctx, query: string): Promise<void> {
  const videos = await allVideos(c.bot);
  const tokens = normalizeHe(query).split(" ").filter((t) => t.length > 1);
  if (!tokens.length) {
    await sendText(c.creds, c.phone, await msg(c.bot, c.env, "no_results", "😔 לא נמצאו תוצאות."));
    return;
  }
  const scored = videos.map((v) => {
    const title = normalizeHe(v.video_name ?? ""), st = normalizeHe(v.search_text ?? ""), reb = normalizeHe(v.rebbe ?? ""), hol = normalizeHe(v.holidays ?? "");
    let score = 0;
    for (const tok of tokens) { if (title.includes(tok)) score += 3; if (st.includes(tok)) score += 2.2; if (hol.includes(tok)) score += 1.5; if (reb.includes(tok)) score += 1.3; }
    const joined = tokens.join(" ");
    if (joined && title.includes(joined)) score += 3.5;
    return { v, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);

  if (!scored.length) {
    await sendText(c.creds, c.phone, await msg(c.bot, c.env, "search_no_results", "😔 לא מצאתי וידאוים מתאימים. נסו מילים אחרות."));
    await navButtons(c, false);
    return;
  }
  const lines = [`*🔍 ${await msg(c.bot, c.env, "search_results_title", "תוצאות חיפוש")}*`, ""];
  const ctx = await getSubscriberContext(c.bot, c.phone);
  for (const { v } of scored) {
    lines.push(`${v.icon || "🎬"} *${v.video_name ?? ""}*`);
    const link = await watchLinkFor(v, ctx);
    if (link) lines.push(link);
    lines.push("");
  }
  await sendText(c.creds, c.phone, lines.join("\n"));
  await navButtons(c, false);
}

/** Free-text after the user picked "search" — returns true if consumed. */
export async function handleSearchText(bot: BotRow, env: BotEnv, phone: string, text: string): Promise<void> {
  const creds = resolveCreds(bot, env);
  if (!creds) return;
  await setState(bot, phone, { expectedInput: "" });
  await runSearch({ bot, env, creds, phone }, text);
}

/** Handle a video_list / action node. Returns true if handled. */
export async function handleVideoNode(bot: BotRow, env: BotEnv, phone: string,
  node: { node_key: string; label: string; type: string; action: string | null; body_text: string | null }): Promise<boolean> {
  const creds = resolveCreds(bot, env);
  if (!creds) return false;
  const c: Ctx = { bot, env, creds, phone };
  if (node.type === "video_list") { await sendVideoList(c, node); return true; }
  if (node.type === "action") return handleVideoAction(bot, env, phone, node.action || node.node_key);
  if (node.type === "text") { await sendText(creds, phone, node.body_text ?? ""); return true; }
  return false;
}

/** Handle nav / holiday / search actions (button ids). Returns true if handled. */
export async function handleVideoAction(bot: BotRow, env: BotEnv, phone: string, action: string): Promise<boolean> {
  const creds = resolveCreds(bot, env);
  if (!creds) return false;
  const c: Ctx = { bot, env, creds, phone };
  switch (action) {
    case "nav_more": {
      const s = await getState(bot.id, phone);
      const next = Number(s.currentOffset || 0) + 10;
      await sendVideoPage(c, String(s.currentListKey || ""), String(s.currentListTitle || ""), next);
      return true;
    }
    case "nav_share":
      await sendText(creds, phone, await msg(bot, env, "share_footer", "📲 שתפו את הבוט: https://wa.me/?text=שלום"));
      return true;
    case "holidays_all": await sendHolidays(c, false); return true;
    case "holidays_upcoming": await sendHolidays(c, true); return true;
    case "main_free_search":
      await setState(bot, phone, { expectedInput: "SEARCH" });
      await sendText(creds, phone, await msg(bot, env, "search_prompt", "🔍 מה תרצו לחפש? כתבו מילה או נושא."));
      return true;
    default:
      return false;
  }
}
