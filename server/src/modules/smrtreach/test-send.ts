/**
 * smrtReach — one-off sends ("שלח לעצמי") + the shared per-address email send
 * used by the test send and the GMass inbox-placement test.
 *
 * Renders a campaign's content with sample variables and sends a single message
 * — without touching the queue, status, tracking or logs. Provider-aware: email
 * goes via SES or the org's Gmail accounts per the campaign's provider. Kept
 * separate from the queue services to avoid an import cycle (reuses `render`).
 */

import { db } from "../../db";
import { sendEmail } from "./ses-client";
import { sendViaReachGmail } from "./gmail-client";
import { render, resolveRegion, wrapEmailBody } from "./send-service";

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

/**
 * Resolve which Gmail sending inbox a test/GMass send should go out from: the
 * campaign's allocated Gmail sender (first one), falling back to the campaign's
 * `sender` field if it names a Gmail sender. Returns null when the campaign has
 * no Gmail sending inbox selected — the caller then errors rather than silently
 * falling back to an org member's personal connected Gmail.
 */
async function resolveCampaignGmailSender(
  orgId: string,
  campaignId: string,
  fallbackSenderEmail: string | null,
): Promise<{ id: string; email: string; daily_cap: number | null } | null> {
  const { data: allocs } = await db
    .from("smrtreach_campaign_senders")
    .select("sender_id")
    .eq("org_id", orgId)
    .eq("campaign_id", campaignId);
  const ids = (allocs ?? []).map((a) => a.sender_id as string);
  if (ids.length > 0) {
    const { data: senders } = await db
      .from("smrtreach_senders")
      .select("id, email, daily_cap")
      .eq("org_id", orgId)
      .eq("provider", "gmail")
      .in("id", ids)
      .order("id", { ascending: true });
    const s = (senders ?? [])[0];
    if (s) return { id: s.id as string, email: s.email as string, daily_cap: (s.daily_cap as number | null) ?? null };
  }
  if (fallbackSenderEmail) {
    const { data: s } = await db
      .from("smrtreach_senders")
      .select("id, email, daily_cap")
      .eq("org_id", orgId)
      .eq("provider", "gmail")
      .eq("email", fallbackSenderEmail)
      .maybeSingle();
    if (s) return { id: s.id as string, email: s.email as string, daily_cap: (s.daily_cap as number | null) ?? null };
  }
  return null;
}

/**
 * Render a campaign's email content and send it to one address via the
 * campaign's provider (SES or Gmail). Returns the message id and the actual
 * sending address (the Gmail account, or the SES verified sender).
 * @param subjectPrefix prepended to the rendered subject (e.g. "[בדיקה] ").
 */
export async function sendCampaignEmailTo(
  orgId: string,
  campaignId: string,
  to: string,
  subjectPrefix = "",
): Promise<{ messageId: string | null; from: string }> {
  const { data: detail } = await db
    .from("smrtreach_campaign_email")
    .select("subject, html_body, sender, reply_to, language, provider, font_size")
    .eq("campaign_id", campaignId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!detail) throw new Error("campaign has no email content");

  const subject = `${subjectPrefix}${render((detail.subject as string) ?? "", SAMPLE_VARS)}`;
  const html = wrapEmailBody(
    render((detail.html_body as string) ?? "", SAMPLE_VARS),
    (detail.font_size as number | null) ?? null,
  );
  const replyTo = (detail.reply_to as string | null) ?? null;
  const provider = (detail.provider as string) ?? "ses";

  if (provider === "gmail") {
    // Send the test from the SAME inbox the campaign sends from — the allocated
    // smrtReach Gmail sender — never an org member's personal connected Gmail.
    const sender = await resolveCampaignGmailSender(
      orgId,
      campaignId,
      (detail.sender as string | null) ?? null,
    );
    if (!sender) {
      throw new Error(
        "no Gmail sending inbox is selected for this campaign — choose one in the sender allocation",
      );
    }
    return sendViaReachGmail(orgId, sender, { to, subject, html, replyTo });
  }

  if (!detail.sender) throw new Error("campaign has no sender set");
  const { data: sender } = await db
    .from("smrtreach_senders").select("email").eq("org_id", orgId).eq("email", detail.sender).maybeSingle();
  if (!sender) throw new Error(`sender "${detail.sender}" is not a verified sender for this org`);
  const region = await resolveRegion(orgId, (detail.language as string) ?? "he");
  const { messageId } = await sendEmail({
    region, from: detail.sender as string, to, subject, html, replyTo,
  });
  return { messageId, from: detail.sender as string };
}

export async function sendTestMessage(
  orgId: string,
  campaignId: string,
  target: { email: string | null; phone: string | null },
): Promise<{ email?: string; whatsapp?: string }> {
  const out: { email?: string; whatsapp?: string } = {};

  if (target.email) {
    const { messageId } = await sendCampaignEmailTo(orgId, campaignId, target.email, "[בדיקה] ");
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

// ── GMass inbox-placement test (botsite parity) ─────────────────────────────
// GMass passively monitors these public seed addresses; after the campaign is
// sent to them, inbox/spam placement is viewable at gmass.co/inbox?q=<sender>.
// No API key — the seeds are public and monitored by GMass.
export const GMASS_SEEDS = [
  "ajaygoel999@gmail.com", "test@chromecompete.com", "test@ajaygoel.org",
  "me@dropboxslideshow.com", "test@wordzen.com", "rajgoel8477@gmail.com",
  "rajanderson8477@gmail.com", "rajwilson8477@gmail.com", "briansmith8477@gmail.com",
  "oliviasmith8477@gmail.com", "ashsmith8477@gmail.com", "shellysmith8477@gmail.com",
  "ajay@madsciencekidz.com", "ajay2@ctopowered.com", "ajay@arena.tec.br",
];
export const GMASS_RESULTS_BASE = "https://www.gmass.co/inbox";

/** Send the campaign content to the GMass seeds and return the results URL. */
export async function sendGmassInboxTest(
  orgId: string,
  campaignId: string,
): Promise<{ sent: number; failed: number; total: number; errors: string[]; resultsUrl: string }> {
  let sent = 0;
  let failed = 0;
  let senderEmail = "";
  const errors: string[] = [];

  for (const seed of GMASS_SEEDS) {
    try {
      const { from } = await sendCampaignEmailTo(orgId, campaignId, seed);
      if (from) senderEmail = from;
      sent++;
    } catch (e) {
      failed++;
      if (errors.length < 5) errors.push(e instanceof Error ? e.message : String(e));
    }
    await new Promise((r) => setTimeout(r, 200)); // gentle pacing, botsite parity
  }

  const resultsUrl = senderEmail
    ? `${GMASS_RESULTS_BASE}?q=${encodeURIComponent(senderEmail)}`
    : GMASS_RESULTS_BASE;
  return { sent, failed, total: GMASS_SEEDS.length, errors, resultsUrl };
}
