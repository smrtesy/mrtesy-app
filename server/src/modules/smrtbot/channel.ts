/**
 * smrtBot — outbound channel abstraction.
 *
 * The conversation engine (engine.ts + game.ts + videos.ts) is transport-
 * agnostic: it produces text / buttons / lists / images and hands them to a
 * `BotChannel`. Two implementations exist:
 *
 *   - whatsappChannel() — wraps wa.ts (Meta Cloud API). Behaviour is identical
 *     to the pre-refactor direct calls; it just carries the resolved creds +
 *     recipient phone so the engine no longer threads them around.
 *   - WebChannel        — persists each outbound message to smrtbot_web_messages
 *     and broadcasts it over Supabase Realtime to the visitor's session topic,
 *     so the browser widget renders the same experience the WhatsApp user gets.
 *
 * Inbound is normalised to the same InboundMessage the WhatsApp webhook
 * produces, so the engine entry point does not care which channel it is on.
 */
import { randomUUID } from "node:crypto";
import { db } from "../../db";
import {
  sendText,
  sendButtons,
  sendList,
  sendImage,
  type ResolvedCreds,
  type ReplyButton,
  type ListRow,
} from "./wa";

export type { ReplyButton, ListRow };

/** The transport seam the engine talks to. All methods are best-effort and
 *  must resolve (never reject) so one failed send can't abort a conversation. */
export interface BotChannel {
  readonly kind: "whatsapp" | "web";
  text(body: string): Promise<void>;
  buttons(body: string, buttons: ReplyButton[]): Promise<void>;
  list(body: string, buttonLabel: string, rows: ListRow[], sectionTitle?: string): Promise<void>;
  image(url: string, caption?: string): Promise<void>;
}

// ── WhatsApp channel ─────────────────────────────────────────
/** Adapter over wa.ts. Carries the recipient phone + resolved creds so the
 *  engine can stay phone/creds-free. Identical wire behaviour to before. */
export function whatsappChannel(creds: ResolvedCreds, to: string): BotChannel {
  return {
    kind: "whatsapp",
    async text(body) {
      await sendText(creds, to, body);
    },
    async buttons(body, buttons) {
      await sendButtons(creds, to, body, buttons);
    },
    async list(body, buttonLabel, rows, sectionTitle) {
      await sendList(creds, to, body, buttonLabel, rows, sectionTitle);
    },
    async image(url, caption) {
      await sendImage(creds, to, url, caption);
    },
  };
}

// ── Web channel ──────────────────────────────────────────────
export interface WebChannelCtx {
  orgId: string;
  botId: string;
  sessionId: string;
  sessionToken: string;
}

export type WebMessageKind = "text" | "buttons" | "image" | "list";

/** The Realtime topic a browser subscribes to for one session. The session
 *  token is high-entropy, so the topic is effectively private — only the
 *  visitor who created the session knows it. */
export function webTopic(sessionToken: string): string {
  return `smrtbot-web-${sessionToken}`;
}

export const WEB_BROADCAST_EVENT = "bot_message";

/** Fire-and-forget broadcast over Supabase Realtime's HTTP API. Stateless (no
 *  persistent socket), so it suits the serverless/short-lived engine run. */
async function broadcast(topic: string, payload: Record<string, unknown>): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ topic, event: WEB_BROADCAST_EVENT, payload, private: false }],
      }),
    });
  } catch (e) {
    console.error("[smrtbot/channel] broadcast failed", e instanceof Error ? e.message : String(e));
  }
}

/** Web transport: persist the outbound message (for history + admin view) and
 *  push it live to the visitor's browser via Realtime. */
export class WebChannel implements BotChannel {
  readonly kind = "web" as const;
  constructor(private readonly ctx: WebChannelCtx) {}

  private async emit(kind: WebMessageKind, body: string, payload: Record<string, unknown>): Promise<void> {
    // Pre-generate id + created_at so the history insert and the live broadcast
    // can run concurrently (instead of insert→await→broadcast) while carrying
    // identical values. The widget dedups by id across both the broadcast and
    // the catch-up history fetch, so the two must agree — and it also uses id as
    // a React key. The broadcast is the last hop before the reply renders, so
    // taking it off the insert's critical path is what makes a submenu feel snappy.
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const [{ error }] = await Promise.all([
      db.from("smrtbot_web_messages").insert({
        id,
        org_id: this.ctx.orgId,
        bot_id: this.ctx.botId,
        session_id: this.ctx.sessionId,
        direction: "out",
        kind,
        body,
        payload,
        created_at,
      }),
      broadcast(webTopic(this.ctx.sessionToken), {
        id,
        direction: "out",
        kind,
        body,
        payload,
        created_at,
      }),
    ]);
    if (error) console.error("[smrtbot/channel] web emit insert", error.message);
  }

  async text(body: string): Promise<void> {
    await this.emit("text", body, {});
  }

  async buttons(body: string, buttons: ReplyButton[]): Promise<void> {
    await this.emit("buttons", body, { buttons });
  }

  async list(body: string, buttonLabel: string, rows: ListRow[], sectionTitle?: string): Promise<void> {
    await this.emit("list", body, { buttonLabel, rows, sectionTitle: sectionTitle ?? "" });
  }

  async image(url: string, caption?: string): Promise<void> {
    await this.emit("image", caption ?? "", { url, caption: caption ?? "" });
  }
}
