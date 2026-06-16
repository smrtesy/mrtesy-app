/**
 * smrtBot — AI project manager (Phase 2, part 2).
 *
 * Ports the core of the legacy Apps-Script "Chanoch" bot: a routed number sends
 * free text (or a transcribed voice note that arrives as text), an LLM classifies
 * it into one of the contact's projects (or proposes a new one), and the user
 * confirms / re-files / discards before it is saved as an entry.
 *
 * Enabled per number via a phone-route with response_mode = 'ai_pm'. Uses the
 * platform's central model client (anthropic.ts / gemini.ts), never a per-bot
 * key. Classification is best-effort: if the model is unavailable the entry is
 * still saved as "uncertain" so nothing is lost.
 *
 * Scope of this slice: text classification, the confirm flow, projects + entries
 * and their listings. Voice transcription, tasks, sub-projects and natural-
 * language management commands are a later step.
 */
import { db } from "../../db";
import { simpleCall, type ModelKey } from "../../anthropic";
import { generateText } from "../../gemini";
import { getBotSetting } from "./ai-answer";
import { type BotEnv, type ReplyButton } from "./wa";
import { type BotChannel } from "./channel";

export interface PmBot {
  id: string;
  org_id: string;
  slug: string;
}

const CLAUDE_MODELS: Record<string, ModelKey> = {
  "claude-haiku": "haiku",
  "claude-sonnet": "sonnet",
  "claude-opus": "opus",
};

interface Project {
  id: string;
  name: string;
  description: string | null;
  entry_count: number;
}

interface Classification {
  project_action: "add_to_existing" | "create_new" | "uncertain";
  project_id: string;
  project_name: string;
  project_description: string;
  summary: string;
  type: string;
  urgency: string;
}

// ── data helpers ─────────────────────────────────────────────
async function loadProjects(bot: PmBot, phone: string): Promise<Project[]> {
  const { data } = await db
    .from("smrtbot_pm_projects")
    .select("id, name, description, entry_count")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("status", "active")
    .order("entry_count", { ascending: false });
  return (data as Project[]) ?? [];
}

async function findProjectByName(bot: PmBot, phone: string, name: string): Promise<Project | null> {
  const norm = name.trim().toLowerCase();
  const { data } = await db
    .from("smrtbot_pm_projects")
    .select("id, name, description, entry_count")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("status", "active");
  return ((data as Project[]) ?? []).find((p) => p.name.trim().toLowerCase() === norm) ?? null;
}

async function createProject(bot: PmBot, phone: string, name: string, description: string): Promise<Project | null> {
  const { data, error } = await db
    .from("smrtbot_pm_projects")
    .insert({ org_id: bot.org_id, bot_id: bot.id, phone, name: name.trim(), description: description || null })
    .select("id, name, description, entry_count")
    .single();
  if (error) {
    console.error("[smrtbot/pm] createProject", error.message);
    return null;
  }
  return data as Project;
}

async function getOrCreateProject(bot: PmBot, phone: string, name: string, description: string): Promise<Project | null> {
  return (await findProjectByName(bot, phone, name)) ?? (await createProject(bot, phone, name, description));
}

async function incEntryCount(bot: PmBot, projectId: string): Promise<void> {
  const { data } = await db
    .from("smrtbot_pm_projects")
    .select("entry_count")
    .eq("bot_id", bot.id)
    .eq("id", projectId)
    .maybeSingle();
  const next = Number(data?.entry_count ?? 0) + 1;
  const { error } = await db
    .from("smrtbot_pm_projects")
    .update({ entry_count: next })
    .eq("bot_id", bot.id)
    .eq("id", projectId);
  if (error) console.error("[smrtbot/pm] incEntryCount", error.message);
}

// ── classification (LLM, best-effort) ────────────────────────
function parseJson(raw: string): Record<string, unknown> | null {
  let s = (raw || "").trim();
  if (s.includes("```")) s = s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0].replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function buildPrompt(projects: Project[]): string {
  const list = JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name, description: p.description ?? "" })));
  return (
    "אתה עוזר לניהול מידע אישי. המשתמש שולח מידע (טקסט/תמלול) ואתה מסווג אותו לפרויקט.\n" +
    "פרויקט = תחום פעילות רחב שמכיל פריטים רבים (עסק, תחום חיים, יוזמה) — לא פריט/משימה בודדת.\n\n" +
    "פרויקטים קיימים של המשתמש:\n" +
    list +
    "\n\nכללי החלטה:\n" +
    "1. שייך לפרויקט קיים → add_to_existing (החזר את ה-project_id המדויק).\n" +
    "2. מגדיר תחום רחב חדש → create_new (project_name קצר 1-3 מילים + project_description).\n" +
    "3. פריט/משימה בודדים בלי פרויקט מתאים → uncertain.\n\n" +
    "שמר כל קישור (URL) בדיוק כפי שנשלח, כולל פרמטרים ומזהים — בלי לקצר.\n" +
    "החזר JSON בלבד, ללא טקסט נוסף, במבנה:\n" +
    '{"project_action":"add_to_existing|create_new|uncertain","project_id":"","project_name":"","project_description":"","summary":"סיכום קצר ששומר זיהויים ספציפיים","type":"task|info|payment|meeting|idea|link|other","urgency":"low|medium|high"}'
  );
}

async function classify(bot: PmBot, text: string, projects: Project[]): Promise<Classification> {
  const fallback: Classification = {
    project_action: "uncertain",
    project_id: "",
    project_name: "",
    project_description: "",
    summary: text.slice(0, 280),
    type: "info",
    urgency: "medium",
  };
  try {
    const system = buildPrompt(projects);
    const modelSetting = (await getBotSetting(bot.id, "ai_model")) || "claude-sonnet";
    let rawText: string;
    if (modelSetting === "gemini") {
      rawText = await generateText(`${system}\n\n=== תוכן לסיווג ===\n${text}\n\nJSON:`, { maxOutputTokens: 700 });
    } else {
      const mk = CLAUDE_MODELS[modelSetting] ?? "sonnet";
      const { content } = await simpleCall(mk, system, `תוכן לסיווג:\n${text}`, 700, {
        component: "smrtbot.pm_classify",
        refId: bot.id,
      });
      rawText = content;
    }
    const parsed = parseJson(rawText);
    if (!parsed) return fallback;
    const action = String(parsed.project_action || "uncertain");
    return {
      project_action: action === "add_to_existing" || action === "create_new" ? action : "uncertain",
      project_id: String(parsed.project_id || ""),
      project_name: String(parsed.project_name || ""),
      project_description: String(parsed.project_description || ""),
      summary: String(parsed.summary || text.slice(0, 280)),
      type: String(parsed.type || "info"),
      urgency: String(parsed.urgency || "medium"),
    };
  } catch (e) {
    console.error("[smrtbot/pm] classify", e instanceof Error ? e.message : String(e));
    return fallback;
  }
}

// ── confirm flow ─────────────────────────────────────────────
/** Free text from a PM-mode number: classify, stage a pending entry, confirm. */
export async function handlePmText(bot: PmBot, env: BotEnv, phone: string, text: string, channel: BotChannel): Promise<void> {
  await channel.text("🧠 מנתח… ⏳");
  const projects = await loadProjects(bot, phone);
  const c = await classify(bot, text, projects);

  // Resolve the proposed target for the preview + later confirm.
  let targetLabel: string;
  const proposed: Record<string, unknown> = { action: c.project_action };
  if (c.project_action === "add_to_existing") {
    const proj = projects.find((p) => p.id === c.project_id) ?? (c.project_name ? await findProjectByName(bot, phone, c.project_name) : null);
    if (proj) {
      proposed.project_id = proj.id;
      targetLabel = `📂 ${proj.name}`;
    } else {
      proposed.action = "uncertain";
      targetLabel = "❓ לבחירה";
    }
  } else if (c.project_action === "create_new" && c.project_name) {
    proposed.project_name = c.project_name;
    proposed.project_description = c.project_description;
    targetLabel = `🆕 פרויקט חדש: ${c.project_name}`;
  } else {
    targetLabel = "❓ לבחירה";
  }

  const { data: entry, error } = await db
    .from("smrtbot_pm_entries")
    .insert({
      org_id: bot.org_id,
      bot_id: bot.id,
      phone,
      type: c.type,
      summary: c.summary,
      transcript: text,
      source: "text",
      status: "pending",
      proposed,
    })
    .select("id")
    .single();
  if (error || !entry) {
    await channel.text("⚠️ לא הצלחתי לשמור, נסה שוב.");
    return;
  }

  const id = entry.id as string;
  const buttons: ReplyButton[] = [
    { id: `pm_confirm:${id}`, title: "✅ שמור" },
    { id: `pm_choose:${id}`, title: "📂 בחר פרויקט" },
    { id: `pm_discard:${id}`, title: "🗑️ בטל" },
  ];
  await channel.buttons(`🧠 *הבנתי:*\n${c.summary}\n\n${targetLabel}`, buttons);
}

async function confirmEntry(bot: PmBot, phone: string, entryId: string, channel: BotChannel, explicitProjectId?: string): Promise<void> {
  const { data: entry } = await db
    .from("smrtbot_pm_entries")
    .select("id, status, proposed")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) {
    await channel.text("ℹ️ הפריט כבר לא זמין.");
    return;
  }
  const proposed = (entry.proposed as Record<string, unknown>) ?? {};

  let project: Project | null = null;
  if (explicitProjectId) {
    const { data } = await db
      .from("smrtbot_pm_projects")
      .select("id, name, description, entry_count")
      .eq("bot_id", bot.id)
      .eq("phone", phone)
      .eq("id", explicitProjectId)
      .maybeSingle();
    project = (data as Project) ?? null;
  } else if (proposed.action === "add_to_existing" && proposed.project_id) {
    // Scope by bot+phone: project_id originates from the LLM, and the engine
    // uses the service-role client (RLS bypassed), so never trust it unscoped.
    const { data } = await db
      .from("smrtbot_pm_projects")
      .select("id, name, description, entry_count")
      .eq("bot_id", bot.id)
      .eq("phone", phone)
      .eq("id", String(proposed.project_id))
      .maybeSingle();
    project = (data as Project) ?? null;
    if (!project) project = await getOrCreateProject(bot, phone, "כללי", "פריטים שטרם סווגו");
  } else if (proposed.action === "create_new" && proposed.project_name) {
    project = await getOrCreateProject(bot, phone, String(proposed.project_name), String(proposed.project_description ?? ""));
  } else {
    project = await getOrCreateProject(bot, phone, "כללי", "פריטים שטרם סווגו");
  }

  if (!project) {
    await channel.text("⚠️ לא הצלחתי לשייך לפרויקט, נסה שוב.");
    return;
  }
  const { error } = await db
    .from("smrtbot_pm_entries")
    .update({ project_id: project.id, status: "confirmed" })
    .eq("id", entryId);
  if (error) {
    await channel.text("⚠️ לא הצלחתי לשמור, נסה שוב.");
    return;
  }
  await incEntryCount(bot, project.id);
  await channel.text(`✅ נשמר בפרויקט *${project.name}*.`);
}

/** PM action buttons (ids prefixed pm_). Returns true if handled. */
export async function handlePmAction(bot: PmBot, env: BotEnv, phone: string, action: string, channel: BotChannel): Promise<boolean> {
  if (!action.startsWith("pm_")) return false;
  const [cmd, arg, arg2] = action.split(":");

  if (cmd === "pm_confirm" && arg) {
    await confirmEntry(bot, phone, arg, channel);
    return true;
  }
  if (cmd === "pm_setproj" && arg && arg2) {
    await confirmEntry(bot, phone, arg, channel, arg2);
    return true;
  }
  if (cmd === "pm_discard" && arg) {
    const { error } = await db
      .from("smrtbot_pm_entries")
      .update({ status: "discarded" })
      .eq("bot_id", bot.id)
      .eq("phone", phone)
      .eq("id", arg);
    if (error) console.error("[smrtbot/pm] pm_discard", error.message);
    await channel.text("🗑️ בוטל.");
    return true;
  }
  if (cmd === "pm_choose" && arg) {
    const projects = await loadProjects(bot, phone);
    if (projects.length === 0) {
      await channel.text("אין עדיין פרויקטים — אישור ייצור פרויקט *כללי*.");
      return true;
    }
    const rows = projects.slice(0, 10).map((p) => ({ id: `pm_setproj:${arg}:${p.id}`, title: p.name.slice(0, 24) }));
    if (rows.length <= 3) await channel.buttons("לאיזה פרויקט לשייך?", rows);
    else await channel.list("לאיזה פרויקט לשייך?", "בחירה", rows);
    return true;
  }
  if (cmd === "pm_projects") {
    const projects = await loadProjects(bot, phone);
    if (projects.length === 0) {
      await channel.text("📂 אין עדיין פרויקטים. שלח לי מידע ואתחיל לסווג.");
      return true;
    }
    const lines = projects.map((p) => `• *${p.name}* (${p.entry_count})`).join("\n");
    await channel.text(`📂 *הפרויקטים שלך:*\n${lines}`);
    return true;
  }
  if (cmd === "pm_recent") {
    const { data } = await db
      .from("smrtbot_pm_entries")
      .select("summary, status, created_at")
      .eq("bot_id", bot.id)
      .eq("phone", phone)
      .eq("status", "confirmed")
      .order("created_at", { ascending: false })
      .limit(10);
    const rows = (data as { summary: string }[]) ?? [];
    if (rows.length === 0) {
      await channel.text("🕒 אין עדיין פריטים שמורים.");
      return true;
    }
    await channel.text(`🕒 *פריטים אחרונים:*\n${rows.map((r) => `• ${r.summary}`).join("\n")}`);
    return true;
  }
  return false;
}
