/**
 * smrtTask — selective WhatsApp auto-reply (Coexistence-safe).
 *
 * Called from the inbound webhook for genuine live incoming messages only (not
 * echoes / history / groups / statuses). Opt-in and allowlist-only:
 *   - the connection's master switch (autoreply_enabled) must be ON;
 *   - a rule (whatsapp_autoreply_rules) must match the sender;
 *   - no match → silent (the default), so personal contacts aren't bothered.
 *
 * "known" = the sender has prior Coexistence history or is in the CRM; "unknown"
 * = a first-time/stranger. This is the practical stand-in for "saved in your
 * contacts", which the Cloud API does not expose.
 */
import type { createAdminSupabaseClient } from "@/lib/supabase/admin";

type SupabaseAdmin = NonNullable<ReturnType<typeof createAdminSupabaseClient>>;

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export interface IncomingForReply {
  sender: string;
  name: string;
  text: string;
}

interface RuleRow {
  match_type: "phone" | "prefix" | "tag" | "known" | "unknown";
  match_value: string | null;
  response_mode: "reply" | "ai";
  reply_text: string | null;
  reply_buttons: { id?: string; title?: string }[] | null;
  ai_instructions: string | null;
  priority: number;
}

function splitValues(raw: string | null): string[] {
  return (raw ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function ruleMatches(rule: RuleRow, sender: string, tags: string[], known: boolean): boolean {
  switch (rule.match_type) {
    case "phone":
      return splitValues(rule.match_value).includes(sender);
    case "prefix":
      return splitValues(rule.match_value).some((v) => {
        const p = v.endsWith("*") ? v.slice(0, -1) : v;
        return p.length > 0 && sender.startsWith(p); // never match on an empty/"*" prefix
      });
    case "tag":
      return splitValues(rule.match_value).some((v) => tags.includes(v));
    case "known":
      return known;
    case "unknown":
      return !known;
    default:
      return false;
  }
}

async function senderTags(db: SupabaseAdmin, userId: string, sender: string): Promise<string[]> {
  const { data } = await db
    .from("whatsapp_contact_tags")
    .select("tags")
    .eq("user_id", userId)
    .eq("phone", sender)
    .maybeSingle();
  return splitValues((data?.tags as string | null) ?? null);
}

/** Known = there is prior Coexistence history with this peer on the user's own
 *  number. (We deliberately do NOT consult smrtcrm_contacts: it is org-scoped,
 *  not user-scoped, so under the service-role client it would leak across
 *  tenants and mis-classify strangers as "known".) */
async function isKnownSender(db: SupabaseAdmin, userId: string, sender: string): Promise<boolean> {
  const { data: hist } = await db
    .from("whatsapp_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("from_phone", sender)
    .eq("is_history", true)
    .limit(1)
    .maybeSingle();
  return !!hist;
}

async function aiReply(instructions: string | null, text: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const system =
    (instructions?.trim() ||
      "אתה עונה בשם בעל המספר על הודעות וואטסאפ. ענה בעברית, קצר, מנומס וברור.") +
    " שמור כל קישור (URL) בדיוק כפי שהוא, ללא קיצור. אל תמציא פרטים שאינך יודע.";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: text || "(הודעה ריקה)" }],
      }),
    });
    if (!res.ok) {
      console.error("[wa-autoreply] anthropic", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const out = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    return out || null;
  } catch (e) {
    console.error("[wa-autoreply] anthropic", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function sendWhatsApp(
  apiVersion: string,
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
  buttons: { id?: string; title?: string }[],
): Promise<void> {
  const valid = buttons.filter((b) => b.id && b.title).slice(0, 3);
  const payload =
    valid.length > 0
      ? {
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text },
            action: { buttons: valid.map((b) => ({ type: "reply", reply: { id: b.id, title: (b.title ?? "").slice(0, 20) } })) },
          },
        }
      : { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("[wa-autoreply] send", res.status, (await res.text()).slice(0, 200));
  }
}

/** Evaluate + send selective auto-replies for a batch of live incoming messages. */
export async function runAutoReplies(
  db: SupabaseAdmin,
  userId: string,
  phoneNumberId: string,
  accessToken: string | null,
  apiVersion: string,
  incoming: IncomingForReply[],
): Promise<void> {
  if (!accessToken || incoming.length === 0) return;

  // Master switch — gated OFF by default so nothing sends until the user opts in.
  const { data: conn } = await db
    .from("whatsapp_connections")
    .select("autoreply_enabled, display_phone_number")
    .eq("phone_number_id", phoneNumberId)
    .is("disconnected_at", null)
    .maybeSingle();
  if (!conn?.autoreply_enabled) return;
  const ownNumber = String(conn.display_phone_number ?? "");

  const { data: rulesData } = await db
    .from("whatsapp_autoreply_rules")
    .select("match_type, match_value, response_mode, reply_text, reply_buttons, ai_instructions, priority")
    .eq("user_id", userId)
    .eq("active", true)
    .order("priority", { ascending: true });
  const rules = (rulesData as RuleRow[]) ?? [];
  if (rules.length === 0) return;

  // One reply per distinct sender (latest message wins).
  const bySender = new Map<string, IncomingForReply>();
  for (const m of incoming) if (m.sender && m.sender !== ownNumber) bySender.set(m.sender, m);

  for (const msg of bySender.values()) {
    try {
      const [tags, known] = await Promise.all([
        senderTags(db, userId, msg.sender),
        isKnownSender(db, userId, msg.sender),
      ]);
      const rule = rules.find((r) => ruleMatches(r, msg.sender, tags, known));
      if (!rule) continue; // silent for non-matches — the default

      let body = rule.reply_text ?? "";
      if (rule.response_mode === "ai") {
        const ai = await aiReply(rule.ai_instructions, msg.text);
        if (!ai) {
          if (!body) continue; // no AI + no fallback text → stay silent
        } else {
          body = ai;
        }
      }
      if (!body) continue;
      await sendWhatsApp(apiVersion, phoneNumberId, accessToken, msg.sender, body, rule.reply_buttons ?? []);
    } catch (e) {
      console.error("[wa-autoreply] sender", msg.sender, e instanceof Error ? e.message : String(e));
    }
  }
}
