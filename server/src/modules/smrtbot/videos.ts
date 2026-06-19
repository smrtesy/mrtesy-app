/**
 * smrtBot — video lists, free-text video search, holidays, and nav actions.
 * Ported from botsite webhook.js (sendVideoList/sendVideoPage/handleAction +
 * holidays) and sheets.js (filterByListKey/searchVideos), reading the migrated
 * smrtbot_videos / smrtbot_holidays tables instead of the Google Sheet.
 *
 * Transport-agnostic: every reply goes through the BotChannel the engine hands
 * in, so the same flows run on WhatsApp and on the web widget.
 */
import { db } from "../../db";
import { type BotEnv, type ReplyButton } from "./wa";
import { type BotChannel } from "./channel";
import type { BotRow } from "./engine";

type State = Record<string, unknown>;

interface Ctx { bot: BotRow; env: BotEnv; channel: BotChannel; phone: string }

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
  vd_id: string | null; video_name: string | null; video_link: string | null; full_url: string | null;
  display_link: string | null; main_category: string | null; sub_category: string | null;
  rebbe: string | null; holidays: string | null; icon: string | null; search_text: string | null;
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
    .select("vd_id, video_name, video_link, full_url, display_link, main_category, sub_category, rebbe, holidays, icon, search_text")
    .eq("org_id", bot.org_id).eq("active", true);
  if (error) console.error("[smrtbot/videos] allVideos", error.message);
  return (data as VideoRow[]) ?? [];
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
  await c.channel.buttons(await msg(c.bot, c.env, "nav_buttons_header", "ועוד אפשרויות:"), btns.slice(0, 3));
}

async function sendVideoPage(c: Ctx, listKey: string, listTitle: string, offset: number, items?: VideoRow[]): Promise<void> {
  const vids = items ?? (await filterVideos(c.bot, listKey));
  if (!vids.length) {
    await c.channel.text(await msg(c.bot, c.env, "no_results", "😔 לא נמצאו וידאוים."));
    await navButtons(c, false);
    return;
  }
  const pageSize = vids.length <= 12 ? 12 : 10;
  const safeOffset = Math.max(0, offset);
  const page = vids.slice(safeOffset, safeOffset + pageSize);
  const countText = (await msg(c.bot, c.env, "video_list_count", 'סה"כ {count} וידאוים')).replace("{count}", String(vids.length));
  const lines = [`*${listTitle}*`, countText, ""];
  for (const item of page) {
    lines.push(`${item.icon || "🎬"} *${item.video_name ?? ""}*`);
    const raw = String(item.display_link || item.video_link || item.full_url || "").trim();
    const link = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("http")) || raw;
    if (link) lines.push(link);
    lines.push("");
  }
  const pag = (await msg(c.bot, c.env, "video_list_pagination", "מציג {from}–{to} מתוך {total}"))
    .replace("{from}", String(safeOffset + 1)).replace("{to}", String(safeOffset + page.length)).replace("{total}", String(vids.length));
  lines.push(pag);
  await c.channel.text(lines.join("\n"));
  await setState(c.bot, c.phone, { currentListKey: listKey, currentListTitle: listTitle, currentOffset: safeOffset });
  await navButtons(c, safeOffset + pageSize < vids.length);
}

/** Render a video_list-type menu node. */
export async function sendVideoList(c: Ctx, node: { node_key: string; label: string }): Promise<void> {
  const items = await filterVideos(c.bot, node.node_key);
  await sendVideoPage(c, node.node_key, node.label, 0, items);
}

interface HolidayRow {
  holiday_name: string; hebrew_date: string | null; display_emoji: string | null;
  start_date: string | null; end_date: string | null;
}

/**
 * Holidays as an INTERACTIVE selection (not a text dump):
 *   - upcoming → up to 3 reply buttons (WhatsApp's button limit)
 *   - all      → a list message (WhatsApp caps interactive lists at 10 rows)
 * Each entry's id is `holiday:<name>`, so tapping it drills into that holiday's
 * videos (handled in handleVideoAction). Ordered upcoming-first by start_date.
 */
async function sendHolidays(c: Ctx, upcomingOnly: boolean): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db.from("smrtbot_holidays")
    .select("holiday_name, hebrew_date, display_emoji, start_date, end_date")
    .eq("org_id", c.bot.org_id).eq("bot_id", c.bot.id).eq("env", c.env).eq("active", true);
  if (error) console.error("[smrtbot/videos] sendHolidays", error.message);
  let rows = (data as HolidayRow[]) ?? [];

  // Sort upcoming-first: holidays not yet ended (by nearest start) come before
  // the rest. A "YYYY-MM-DD" prefix keeps the comparison a plain string sort.
  const ended = (h: HolidayRow) => (h.end_date ?? h.start_date ?? "") < today;
  const sortKey = (h: HolidayRow) => (ended(h) ? "1" : "0") + (h.start_date ?? "9999-12-31");
  rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // De-dupe by name (defensive against duplicate rows across envs/imports).
  const seen = new Set<string>();
  rows = rows.filter((h) => {
    const n = (h.holiday_name ?? "").trim();
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  if (upcomingOnly) rows = rows.filter((h) => !ended(h));

  if (!rows.length) {
    await c.channel.text(await msg(c.bot, c.env, "no_holidays", "אין חגים להצגה כרגע."));
    await navButtons(c, false);
    return;
  }

  const label = (h: HolidayRow) => `${h.display_emoji || "📅"} ${h.holiday_name}`;
  if (upcomingOnly) {
    const top = rows.slice(0, 3); // WhatsApp: max 3 reply buttons
    const header = await msg(c.bot, c.env, "holidays_upcoming_title", "🗓️ החגים הקרובים — בחרו חג:");
    await c.channel.buttons(header, top.map((h) => ({ id: `holiday:${h.holiday_name}`, title: label(h) })));
  } else {
    const top = rows.slice(0, 10); // WhatsApp: max 10 list rows — show the nearest
    const header = `${await msg(c.bot, c.env, "holidays_all_title", "🗓️ כל החגים — בחרו חג:")} (${rows.length})`;
    await c.channel.list(
      header,
      await msg(c.bot, c.env, "holidays_list_button", "בחר חג"),
      top.map((h) => ({ id: `holiday:${h.holiday_name}`, title: label(h) })),
      await msg(c.bot, c.env, "holidays_section_title", "חגים"),
    );
  }
}

async function runSearch(c: Ctx, query: string): Promise<void> {
  const videos = await allVideos(c.bot);
  const tokens = normalizeHe(query).split(" ").filter((t) => t.length > 1);
  if (!tokens.length) {
    await c.channel.text(await msg(c.bot, c.env, "no_results", "😔 לא נמצאו תוצאות."));
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
    await c.channel.text(await msg(c.bot, c.env, "search_no_results", "😔 לא מצאתי וידאוים מתאימים. נסו מילים אחרות."));
    await navButtons(c, false);
    return;
  }
  const lines = [`*🔍 ${await msg(c.bot, c.env, "search_results_title", "תוצאות חיפוש")}*`, ""];
  for (const { v } of scored) {
    lines.push(`${v.icon || "🎬"} *${v.video_name ?? ""}*`);
    const raw = String(v.display_link || v.video_link || v.full_url || "").trim();
    const link = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("http")) || raw;
    if (link) lines.push(link);
    lines.push("");
  }
  await c.channel.text(lines.join("\n"));
  await navButtons(c, false);
}

/** Free-text after the user picked "search" — returns true if consumed. */
export async function handleSearchText(bot: BotRow, env: BotEnv, phone: string, text: string, channel: BotChannel): Promise<void> {
  await setState(bot, phone, { expectedInput: "" });
  await runSearch({ bot, env, channel, phone }, text);
}

/** Handle a video_list / action node. Returns true if handled. */
export async function handleVideoNode(bot: BotRow, env: BotEnv, phone: string,
  node: { node_key: string; label: string; type: string; action: string | null; body_text: string | null }, channel: BotChannel): Promise<boolean> {
  const c: Ctx = { bot, env, channel, phone };
  if (node.type === "video_list") { await sendVideoList(c, node); return true; }
  if (node.type === "action") return handleVideoAction(bot, env, phone, node.action || node.node_key, channel);
  if (node.type === "text") { await channel.text(node.body_text ?? ""); return true; }
  return false;
}

/** Handle nav / holiday / search actions (button ids). Returns true if handled. */
export async function handleVideoAction(bot: BotRow, env: BotEnv, phone: string, action: string, channel: BotChannel): Promise<boolean> {
  const c: Ctx = { bot, env, channel, phone };
  // holiday:<name> — drill into a single holiday's videos (from the selection list)
  if (action.startsWith("holiday:")) {
    const name = action.slice("holiday:".length);
    await sendVideoPage(c, action, `📅 ${name}`, 0);
    return true;
  }
  switch (action) {
    case "nav_more": {
      const s = await getState(bot.id, phone);
      const next = Number(s.currentOffset || 0) + 10;
      await sendVideoPage(c, String(s.currentListKey || ""), String(s.currentListTitle || ""), next);
      return true;
    }
    case "nav_share":
      await channel.text(await msg(bot, env, "share_footer", "📲 שתפו את הבוט: https://wa.me/?text=שלום"));
      return true;
    case "holidays_all": await sendHolidays(c, false); return true;
    case "holidays_upcoming": await sendHolidays(c, true); return true;
    case "main_free_search":
      await setState(bot, phone, { expectedInput: "SEARCH" });
      await channel.text(await msg(bot, env, "search_prompt", "🔍 מה תרצו לחפש? כתבו מילה או נושא."));
      return true;
    default:
      return false;
  }
}
