/**
 * smrtBot — conversation engine (backbone).
 *
 * Ported from botsite/src/modules/webhook.js. Handles the core inbound flow:
 * state, system-message lookup, menu-tree navigation (buttons/lists), free-text
 * → FAQ search, logging, and outbound send via the WhatsApp transport (wa.ts).
 *
 * Game / video / special-route handlers (botsite game.js + the special routes in
 * webhook.js) plug in at handleSpecial() — that richer behaviour is layered on
 * top of this backbone and is the next port step. Everything here runs on the
 * Railway server (where wa.ts holds its per-number throttle), invoked by the
 * internal inbound route that the Vercel webhook forwards to.
 *
 * NOTE: behavioural verification pending (needs a test bot + deploy). Compiles
 * clean and mirrors the botsite flow 1:1 at the backbone level.
 */
import { db } from "../../db";
import { emitEvent } from "../../lib/platform";
import { resolveCreds, type BotEnv, type ReplyButton } from "./wa";
import { whatsappChannel, type BotChannel } from "./channel";
import { reportError, errInfo } from "./report-error";
import { handleGameAction, handleGameText, processReferral } from "./game";
import { handleVideoNode, handleVideoAction, handleSearchText } from "./videos";

export interface BotRow {
  id: string;
  org_id: string;
  slug: string;
  public_phone_number?: string | null;
  live_phone_display?: string | null;
  wa_phone_number_id?: string | null;
  wa_access_token?: string | null;
  test_wa_phone_number_id?: string | null;
  test_wa_access_token?: string | null;
  live_wa_phone_number_id?: string | null;
  live_wa_access_token?: string | null;
}

interface MenuNode {
  id: string;
  node_key: string;
  type: string;
  label: string;
  title_he: string | null;
  body_text: string | null;
  buttons: { id?: string; title?: string; label?: string; value?: string }[];
  action: string | null;
  parent_key: string | null;
  image_url: string | null;
}

type State = Record<string, unknown> & { lastInteractionMs?: number };

// ── state (DB-backed; no in-process cache — serverless-safe) ────────────────
async function getState(botId: string, phone: string): Promise<State> {
  const { data } = await db
    .from("smrtbot_wa_users")
    .select("state_json")
    .eq("bot_id", botId)
    .eq("phone", phone)
    .maybeSingle();
  return (data?.state_json as State) ?? {};
}

async function setState(botId: string, phone: string, patch: State): Promise<void> {
  const current = await getState(botId, phone);
  const updated = { ...current, ...patch, lastInteractionMs: Date.now() };
  const { error } = await db
    .from("smrtbot_wa_users")
    .update({ state_json: updated, last_interaction_at: new Date().toISOString() })
    .eq("bot_id", botId)
    .eq("phone", phone);
  if (error) console.error("[smrtbot/engine] setState", error.message);
}

async function touchUser(orgId: string, bot: BotRow, phone: string, name: string | null): Promise<void> {
  const { error } = await db
    .from("smrtbot_wa_users")
    .upsert(
      {
        org_id: orgId,
        bot_id: bot.id,
        phone,
        name: name || null,
        last_interaction_at: new Date().toISOString(),
      },
      { onConflict: "bot_id,phone", ignoreDuplicates: false },
    );
  if (error) console.error("[smrtbot/engine] touchUser", error.message);
  // smrtCRM ingests this (deep integration): a wa_user interacted.
  await emitEvent(orgId, "smrtbot", "contact.observed", "wa_user", phone, {
    bot_id: bot.id,
    phone,
    name: name || null,
  });
}

// ── system message lookup (smrtbot_messages) ────────────────────────────────
async function msg(orgId: string, botId: string, env: BotEnv, key: string, fallback: string): Promise<string> {
  const { data } = await db
    .from("smrtbot_messages")
    .select("text")
    .eq("org_id", orgId)
    .eq("bot_id", botId)
    .eq("env", env)
    .eq("msg_key", key)
    .maybeSingle();
  return (data?.text as string) || fallback;
}

// ── logging ─────────────────────────────────────────────────────────────────
async function logMsg(
  orgId: string,
  botId: string,
  phone: string,
  direction: "IN" | "OUT",
  env: BotEnv,
  messageType: string,
  body: string,
  nodeKey?: string,
): Promise<void> {
  const { error } = await db.from("smrtbot_bot_logs").insert({
    org_id: orgId,
    bot_id: botId,
    phone,
    direction,
    env,
    message_type: messageType,
    body,
    node_key: nodeKey ?? null,
  });
  if (error) console.error("[smrtbot/engine] logMsg", error.message);
}

// ── menu engine ─────────────────────────────────────────────────────────────
async function loadNodes(orgId: string, botId: string, env: BotEnv): Promise<MenuNode[]> {
  const { data } = await db
    .from("smrtbot_menu_nodes")
    .select("id, node_key, type, label, title_he, body_text, buttons, action, parent_key, image_url")
    .eq("org_id", orgId)
    .eq("bot_id", botId)
    .eq("env", env)
    .eq("active", true)
    .order("sort_order");
  return (data as MenuNode[]) ?? [];
}

/** Root menu: prefer a node keyed main/main_welcome/main_menu, else a
 *  parent-less node that has buttons. Mirrors botsite findRootNode. */
function findRootNode(nodes: MenuNode[]): MenuNode | null {
  const byKey = (k: string) => nodes.find((n) => n.node_key === k);
  return (
    byKey("main") ||
    byKey("main_welcome") ||
    byKey("main_menu") ||
    nodes.find((n) => !n.parent_key && (n.buttons?.length ?? 0) > 0) ||
    nodes[0] ||
    null
  );
}

function buttonOf(b: MenuNode["buttons"][number]): ReplyButton | null {
  const id = b.id ?? b.value;
  const title = b.title ?? b.label;
  if (!id || !title) return null;
  return { id, title };
}

async function sendMenuNode(
  channel: BotChannel,
  orgId: string,
  botId: string,
  env: BotEnv,
  phone: string,
  node: MenuNode,
): Promise<void> {
  const bodyText = node.body_text || node.title_he || node.label || "";
  const buttons = (node.buttons ?? []).map(buttonOf).filter((b): b is ReplyButton => b !== null);

  if (node.image_url) {
    await channel.image(node.image_url, bodyText || undefined);
    await logMsg(orgId, botId, phone, "OUT", env, "image", node.image_url, node.node_key);
  }
  if (buttons.length > 0) {
    await channel.buttons(bodyText, buttons);
    await logMsg(orgId, botId, phone, "OUT", env, "buttons", bodyText, node.node_key);
  } else if (bodyText && !node.image_url) {
    await channel.text(bodyText);
    await logMsg(orgId, botId, phone, "OUT", env, "text", bodyText, node.node_key);
  }
}

async function routeNode(
  channel: BotChannel,
  orgId: string,
  bot: BotRow,
  env: BotEnv,
  phone: string,
  nodeKey: string,
  nodes: MenuNode[],
): Promise<boolean> {
  const node = nodes.find((n) => n.node_key === nodeKey);
  if (!node) return false;

  // Dispatch by node type (mirrors botsite routeNode switch).
  if (node.type === "action") {
    const act = node.action || node.node_key;
    if (act === "nav_home") {
      const root = findRootNode(nodes);
      if (root) await sendMenuNode(channel, orgId, bot.id, env, phone, root);
      return true;
    }
    if (act === "nav_back") {
      const s = await getState(bot.id, phone);
      const back = nodes.find((n) => n.node_key === String(s.lastMenu || "main")) ?? findRootNode(nodes);
      if (back) await sendMenuNode(channel, orgId, bot.id, env, phone, back);
      return true;
    }
    if (await handleVideoAction(bot, env, phone, act, channel)) return true;
    // Unknown action → render the node as a menu so the user isn't stuck.
    await sendMenuNode(channel, orgId, bot.id, env, phone, node);
    return true;
  }
  if (node.type === "video_list" || node.type === "text") {
    await handleVideoNode(bot, env, phone, node, channel);
    return true;
  }
  // menu (default)
  await setState(bot.id, phone, { lastMenu: node.parent_key || "main", currentNodeKey: nodeKey });
  await sendMenuNode(channel, orgId, bot.id, env, phone, node);
  return true;
}

// ── free text → FAQ search ──────────────────────────────────────────────────
function normalizeHe(text: string): string {
  return (text || "")
    .replace(/[֑-ׇ]/g, "") // niqqud/te'amim
    .replace(/["'.,!?;:()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function handleFreeText(
  channel: BotChannel,
  orgId: string,
  bot: BotRow,
  env: BotEnv,
  phone: string,
  text: string,
): Promise<void> {
  const { data } = await db
    .from("smrtbot_knowledge_base")
    .select("question_pattern, keywords, answer")
    .eq("org_id", orgId)
    .eq("bot_id", bot.id)
    .eq("env", env)
    .eq("active", true);

  const norm = normalizeHe(text);
  const tokens = norm.split(" ").filter(Boolean);
  let best: { answer: string; score: number } | null = null;
  for (const row of (data as { question_pattern: string; keywords: string | null; answer: string }[]) ?? []) {
    const hay = normalizeHe(`${row.question_pattern} ${row.keywords ?? ""}`);
    let score = 0;
    for (const tok of tokens) if (tok.length > 1 && hay.includes(tok)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { answer: row.answer, score };
  }

  if (best) {
    await channel.text(best.answer);
    await logMsg(orgId, bot.id, phone, "OUT", env, "text", best.answer, "faq");
    return;
  }

  // No match → log a question for the admin + a gentle fallback.
  const { error: qErr } = await db.from("smrtbot_questions").insert({
    org_id: orgId,
    bot_id: bot.id,
    phone,
    message_text: text,
    question_type: "general",
    needs_human: true,
    status: "pending",
  });
  if (qErr) console.error("[smrtbot/engine] question insert", qErr.message);
  await emitEvent(orgId, "smrtbot", "question.received", "question", phone, { message_text: text });
  const fallback = await msg(orgId, bot.id, env, "no_results", "לא הבנתי, נסה שוב או בחר מהתפריט.");
  await channel.text(fallback);
  await logMsg(orgId, bot.id, phone, "OUT", env, "text", fallback, "no_results");
}

// ── inbound dispatch ─────────────────────────────────────────────────────────
export interface InboundMessage {
  from: string;
  name?: string | null;
  type?: string;
  text?: string;
  buttonId?: string; // interactive button/list reply id
}

/** Entry point: a single inbound message for a bot+env.
 *
 *  WhatsApp callers (internal.ts) omit `channelOverride` — we resolve the bot's
 *  Meta creds and build a WhatsApp channel. The web channel (web.ts) passes a
 *  WebChannel so the exact same flow runs, but replies are broadcast to the
 *  browser instead of sent to Meta. */
export async function handleInbound(
  bot: BotRow,
  env: BotEnv,
  message: InboundMessage,
  channelOverride?: BotChannel,
): Promise<void> {
  const orgId = bot.org_id;
  const phone = message.from;

  let channel = channelOverride;
  if (!channel) {
    const creds = resolveCreds(bot, env);
    if (!creds) {
      await reportError(orgId, {
        area: "engine",
        title: `Missing ${env} WhatsApp credentials`,
        message: `Bot "${bot.slug}" has no ${env} phone_number_id/access_token, so it cannot reply.`,
        botId: bot.id,
        details: { bot: bot.slug, env },
      });
      return;
    }
    channel = whatsappChannel(creds, phone);
  }

  try {
    // First-contact detection (for referral credit + new-user welcome).
    const { data: existingUser } = await db
      .from("smrtbot_wa_users")
      .select("id")
      .eq("bot_id", bot.id)
      .eq("phone", phone)
      .maybeSingle();
    const existed = !!existingUser;

    await touchUser(orgId, bot, phone, message.name ?? null);
    await logMsg(orgId, bot.id, phone, "IN", env, message.type ?? "text", message.text ?? message.buttonId ?? "");

    const state = await getState(bot.id, phone);
    const text = (message.text ?? "").trim();

    // Referral credit on first contact via a share deep link ("...הגעתי דרך <phone>").
    if (!existed && text) {
      const m = text.match(/דרך\s+(\d{6,})/);
      if (m && m[1] !== phone) await processReferral(bot, env, phone, m[1]);
    }

    // 1. Mid-flow text input (game onboarding / profile edit / reminder / search).
    if (text && state.expectedInput) {
      if (state.expectedInput === "SEARCH") await handleSearchText(bot, env, phone, text, channel);
      else await handleGameText(bot, env, phone, text, state, channel);
      return;
    }

    // 2. Game action (button id or a text that maps to a game action).
    const action = message.buttonId ?? text;
    if (action && (await handleGameAction(bot, env, phone, action, channel))) return;

    const nodes = await loadNodes(orgId, bot.id, env);

    // 2b. Navigation + video/holiday/search actions sent as raw button ids.
    if (action) {
      if (action === "nav_home") {
        const root = findRootNode(nodes);
        if (root) await sendMenuNode(channel, orgId, bot.id, env, phone, root);
        return;
      }
      if (action === "nav_back") {
        const back = nodes.find((n) => n.node_key === String(state.lastMenu || "main")) ?? findRootNode(nodes);
        if (back) await sendMenuNode(channel, orgId, bot.id, env, phone, back);
        return;
      }
      if (await handleVideoAction(bot, env, phone, action, channel)) return;
    }

    // 3. Menu-tree node by key (button id or text equal to a node_key).
    if (action) {
      const node = nodes.find((n) => n.node_key === action);
      if (node) {
        await routeNode(channel, orgId, bot, env, phone, action, nodes);
        return;
      }
    }

    // 4. Existing user's free text with no match → FAQ search.
    if (text && existed) {
      await handleFreeText(channel, orgId, bot, env, phone, text);
      return;
    }

    // 5. New users / empty input → root menu so they land on the welcome.
    const root = findRootNode(nodes);
    if (root) await sendMenuNode(channel, orgId, bot.id, env, phone, root);
  } catch (e) {
    const { message: msg, stack } = errInfo(e);
    await reportError(orgId, {
      area: "engine",
      title: `Conversation failed for bot ${bot.slug}`,
      message: msg,
      botId: bot.id,
      stack,
      details: { bot: bot.slug, env, phone, inbound: message },
    });
  }
}
