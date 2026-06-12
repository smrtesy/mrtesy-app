/**
 * smrtReach — one-off test sends ("שלח לעצמי").
 *
 * Renders a campaign's email/WhatsApp content with sample variables and sends a
 * single message to the address the user typed — without touching the queue,
 * the campaign status, tracking or logs. Kept separate from the queue services
 * to avoid an import cycle (it reuses `render` from send-service).
 */

import { db } from "../../db";
import { sendEmail } from "./ses-client";
import { render, resolveRegion } from "./send-service";

const SMRTBOT_SEND_URL =
  process.env.SMRTBOT_INTERNAL_URL ??
  `http://127.0.0.1:${process.env.PORT ?? "3001"}/api/bot/internal/send`;
const SMRTBOT_SECRET = process.env.SMRTBOT_INTERNAL_SECRET || process.env.CRON_SECRET || "";

// Sample variables so {{first_name}} etc. render in the preview/test.
const SAMPLE_VARS: Record<string, string> = {
  first_name: "בדיקה",
  last_name: "בדיקה",
  full_name: "בדיקה בדיקה",
  email: "test@example.com",
  phone: "",
};

export async function sendTestMessage(
  orgId: string,
  campaignId: string,
  target: { email: string | null; phone: string | null },
): Promise<{ email?: string; whatsapp?: string }> {
  const out: { email?: string; whatsapp?: string } = {};

  if (target.email) {
    const { data: detail } = await db
      .from("smrtreach_campaign_email")
      .select("subject, preview, html_body, sender, reply_to, language")
      .eq("campaign_id", campaignId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!detail?.sender) throw new Error("campaign has no sender set");
    // The sender must be a verified sender for this org.
    const { data: sender } = await db
      .from("smrtreach_senders").select("email").eq("org_id", orgId).eq("email", detail.sender).maybeSingle();
    if (!sender) throw new Error(`sender "${detail.sender}" is not a verified sender for this org`);

    const region = await resolveRegion(orgId, (detail.language as string) ?? "he");
    const subject = `[בדיקה] ${render((detail.subject as string) ?? "", SAMPLE_VARS)}`;
    const html = render((detail.html_body as string) ?? "", SAMPLE_VARS);
    const { messageId } = await sendEmail({
      region,
      from: detail.sender as string,
      to: target.email,
      subject,
      html,
      replyTo: (detail.reply_to as string | null) ?? null,
    });
    out.email = messageId ?? "sent";
  }

  if (target.phone) {
    if (!SMRTBOT_SECRET) throw new Error("SMRTBOT_INTERNAL_SECRET (or CRON_SECRET) is not set");
    const { data: detail } = await db
      .from("smrtreach_campaign_whatsapp")
      .select("bot_ref, template, template_lang, template_params, body_text")
      .eq("campaign_id", campaignId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!detail?.bot_ref) throw new Error("campaign has no bot selected");
    if (!detail.template && !detail.body_text) throw new Error("campaign has no WhatsApp template or text");

    const resp = await fetch(SMRTBOT_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-smrtbot-secret": SMRTBOT_SECRET },
      body: JSON.stringify({
        bot_id: detail.bot_ref,
        recipients: [{ phone: target.phone, contact_id: null }],
        ...(detail.template
          ? { template: { name: detail.template, lang: detail.template_lang ?? "he", components: detail.template_params ?? undefined } }
          : { text: detail.body_text }),
      }),
    });
    if (!resp.ok) throw new Error(`smrtBot send-service ${resp.status}`);
    const json = (await resp.json()) as { results?: { status: string; error?: string }[] };
    const r = json.results?.[0];
    if (!r || r.status === "failed") throw new Error(r?.error ?? "whatsapp test failed");
    out.whatsapp = r.status;
  }

  return out;
}
