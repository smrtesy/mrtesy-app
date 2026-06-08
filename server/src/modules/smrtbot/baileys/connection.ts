/**
 * smrtBot — unofficial WhatsApp connection manager (Baileys).
 *
 * Owns the long-lived WhatsApp-Web socket for each Baileys-transport bot. Runs
 * inside the Railway server process (MVP); because two concurrent sockets on
 * the same number get logged out by WhatsApp, this assumes a SINGLE server
 * replica and guards against concurrent starts per bot with an in-memory map.
 *
 * Responsibilities:
 *   • connect from the Supabase-persisted auth-state, expose the pairing QR
 *   • reconnect on transient drops, surface a logout so the UI re-scans
 *   • sync the groups/communities the bot participates in (+ admin flag)
 *   • send text/image to a group JID (the broadcast send path)
 *
 * Lifecycle status is mirrored into smrtbot_wa_sessions so the admin UI can
 * poll it without holding a socket reference.
 */
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";

import { db } from "../../../db";
import { reportError, errInfo } from "../report-error";
import { useSupabaseAuthState, clearAuthState } from "./auth-state";

export type WaStatus = "connecting" | "qr" | "open" | "closed";

interface LiveConn {
  sock: WASocket;
  orgId: string;
  status: WaStatus;
}

// botId → live connection. Single-replica assumption (see file header).
const conns = new Map<string, LiveConn>();
// Guard against two concurrent startConnection() calls for the same bot.
const starting = new Set<string>();

// Baileys wants a pino-like logger; provide a silent one to avoid the dep and
// keep its chatter out of Railway logs.
const silentLogger = {
  level: "silent",
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger;
  },
};

async function setSession(
  orgId: string,
  botId: string,
  patch: {
    status?: WaStatus;
    last_qr?: string | null;
    connected_phone?: string | null;
    connected_at?: string | null;
    last_error?: string | null;
  },
): Promise<void> {
  const { error } = await db.from("smrtbot_wa_sessions").upsert(
    {
      org_id: orgId,
      bot_id: botId,
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "bot_id" },
  );
  if (error) console.error("[baileys/conn] setSession", botId, error.message);
}

/**
 * Start (or restart) the WhatsApp connection for a bot. Idempotent: if a socket
 * is already open or currently starting, it returns without opening a second.
 */
export async function startConnection(orgId: string, botId: string): Promise<void> {
  if (starting.has(botId)) return;
  const existing = conns.get(botId);
  if (existing && (existing.status === "open" || existing.status === "connecting")) return;

  starting.add(botId);
  try {
    const { state, saveCreds } = await useSupabaseAuthState(orgId, botId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: silentLogger as any,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    conns.set(botId, { sock, orgId, status: "connecting" });
    await setSession(orgId, botId, { status: "connecting", last_error: null });

    sock.ev.on("creds.update", () => {
      void saveCreds();
    });

    sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      void handleConnectionUpdate(orgId, botId, update);
    });
  } catch (e) {
    const { message, stack } = errInfo(e);
    await setSession(orgId, botId, { status: "closed", last_error: message });
    await reportError(orgId, {
      area: "engine",
      title: "Baileys connect failed",
      message,
      botId,
      stack,
    });
    conns.delete(botId);
  } finally {
    starting.delete(botId);
  }
}

async function handleConnectionUpdate(
  orgId: string,
  botId: string,
  update: Partial<ConnectionState>,
): Promise<void> {
  const { connection, lastDisconnect, qr } = update;
  const conn = conns.get(botId);

  if (qr) {
    if (conn) conn.status = "qr";
    try {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      await setSession(orgId, botId, { status: "qr", last_qr: dataUrl });
    } catch (e) {
      console.error("[baileys/conn] qr encode", botId, errInfo(e).message);
    }
  }

  if (connection === "open") {
    if (conn) conn.status = "open";
    const phone = conn?.sock.user?.id?.split(":")[0]?.split("@")[0] ?? null;
    await setSession(orgId, botId, {
      status: "open",
      last_qr: null,
      connected_phone: phone,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    // Pull the group/community list now that we're live.
    void syncGroups(botId).catch((e) =>
      console.error("[baileys/conn] auto group sync", botId, errInfo(e).message),
    );
  }

  if (connection === "close") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    conns.delete(botId);

    if (loggedOut) {
      // The number unlinked the device — wipe creds so the next connect re-scans.
      await clearAuthState(botId);
      await setSession(orgId, botId, {
        status: "closed",
        last_qr: null,
        connected_phone: null,
        last_error: "logged out — re-scan required",
      });
      return;
    }

    // Transient drop — reconnect with a short backoff.
    await setSession(orgId, botId, {
      status: "closed",
      last_error: errInfo(lastDisconnect?.error).message || "connection closed",
    });
    setTimeout(() => {
      void startConnection(orgId, botId);
    }, 3000);
  }
}

/** Reconnect every Baileys-transport bot that already has a saved session. */
export async function initBaileysConnections(): Promise<void> {
  const { data: bots, error } = await db
    .from("smrtbot_bots")
    .select("id, org_id")
    .eq("transport", "baileys")
    .eq("active", true);
  if (error) {
    console.error("[baileys/init]", error.message);
    return;
  }
  for (const bot of (bots ?? []) as { id: string; org_id: string }[]) {
    // Only resume bots that have persisted creds (otherwise wait for a manual
    // connect from the UI to show the QR to a human).
    const { data: creds } = await db
      .from("smrtbot_wa_auth")
      .select("id")
      .eq("bot_id", bot.id)
      .eq("auth_key", "creds")
      .maybeSingle();
    if (creds) {
      console.log("[baileys/init] resuming", bot.id);
      void startConnection(bot.org_id, bot.id);
    }
  }
}

/** Latest known status for a bot (from memory; falls back to 'closed'). */
export function liveStatus(botId: string): WaStatus {
  return conns.get(botId)?.status ?? "closed";
}

/** Log out + wipe the linked device for a bot. */
export async function logoutConnection(orgId: string, botId: string): Promise<void> {
  const conn = conns.get(botId);
  if (conn) {
    try {
      await conn.sock.logout();
    } catch (e) {
      console.error("[baileys/conn] logout", botId, errInfo(e).message);
    }
    conns.delete(botId);
  }
  await clearAuthState(botId);
  await setSession(orgId, botId, {
    status: "closed",
    last_qr: null,
    connected_phone: null,
    connected_at: null,
    last_error: null,
  });
}

/** Fetch the bot's groups/communities and upsert them into smrtbot_wa_groups. */
export async function syncGroups(botId: string): Promise<number> {
  const conn = conns.get(botId);
  if (!conn || conn.status !== "open") {
    throw new Error("not connected");
  }
  const meId = conn.sock.user?.id?.split(":")[0];
  const meJid = meId ? `${meId.split("@")[0]}@s.whatsapp.net` : null;

  const groups = await conn.sock.groupFetchAllParticipating();
  const rows = Object.values(groups).map((g) => {
    const isAdmin = !!g.participants?.some(
      (p) =>
        (p.id === meJid || p.id === conn.sock.user?.id) &&
        (p.admin === "admin" || p.admin === "superadmin"),
    );
    return {
      org_id: conn.orgId,
      bot_id: botId,
      group_jid: g.id,
      subject: g.subject ?? "",
      // Community announcement groups expose linkedParent / isCommunity hints.
      is_community: !!(g as { isCommunity?: boolean }).isCommunity,
      is_admin: isAdmin,
      participants_count: g.participants?.length ?? 0,
      last_synced_at: new Date().toISOString(),
    };
  });

  if (rows.length > 0) {
    const { error } = await db
      .from("smrtbot_wa_groups")
      .upsert(rows, { onConflict: "bot_id,group_jid" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

export interface BaileysSendResult {
  status: "sent" | "failed";
  wa_message_id?: string | null;
  error?: string;
}

/** Send a text message to a JID (group …@g.us or contact …@s.whatsapp.net). */
export async function sendBaileysText(
  botId: string,
  jid: string,
  text: string,
): Promise<BaileysSendResult> {
  const conn = conns.get(botId);
  if (!conn || conn.status !== "open") {
    return { status: "failed", error: "not connected" };
  }
  try {
    const sent = await conn.sock.sendMessage(jid, { text });
    return { status: "sent", wa_message_id: sent?.key?.id ?? null };
  } catch (e) {
    return { status: "failed", error: errInfo(e).message };
  }
}

/** Send an image (by URL) with an optional caption to a JID. */
export async function sendBaileysImage(
  botId: string,
  jid: string,
  imageUrl: string,
  caption?: string,
): Promise<BaileysSendResult> {
  const conn = conns.get(botId);
  if (!conn || conn.status !== "open") {
    return { status: "failed", error: "not connected" };
  }
  try {
    const sent = await conn.sock.sendMessage(jid, {
      image: { url: imageUrl },
      ...(caption ? { caption } : {}),
    });
    return { status: "sent", wa_message_id: sent?.key?.id ?? null };
  } catch (e) {
    return { status: "failed", error: errInfo(e).message };
  }
}

/** Normalize a phone/JID target into a WhatsApp JID. Group JIDs pass through. */
export function toJid(target: string): string {
  const t = target.trim();
  if (t.endsWith("@g.us") || t.endsWith("@s.whatsapp.net")) return t;
  // Strip non-digits for a bare phone number.
  const digits = t.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}
