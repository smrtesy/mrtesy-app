/**
 * smrtReach — WhatsApp send service (stage G).
 *
 * smrtReach never talks to Meta directly (Reach-2). It resolves the audience
 * from smrtCRM, queues recipients (country-filtered, capped, scheduled) and
 * hands bounded batches to smrtBot's send-service (POST /api/bot/internal/send,
 * shared-secret) which owns the tokens, per-number throttle, opt-out
 * enforcement and retries. Status comes back synchronously in the response.
 *
 * Mirrors the email queue: due-scheduled + status + send-window gating, atomic
 * claim → send → log → flip campaign on drain (shared maybeCompleteCampaign).
 */

import { db } from "../../db";
import { emitEvent } from "../../lib/platform";
import { resolveAudience } from "./audience-service";
import type { AudienceRef } from "./audience-service";
import { maybeCompleteCampaign } from "./send-service";
import { withinSendWindow, matchesCountry, tzForPhone, nextOccurrenceOfHourInTz, type SendHours } from "./send-window";

const SMRTBOT_SEND_URL =
  process.env.SMRTBOT_INTERNAL_URL ??
  `http://127.0.0.1:${process.env.PORT ?? "3001"}/api/bot/internal/send`;
const SMRTBOT_SECRET = process.env.SMRTBOT_INTERNAL_SECRET || process.env.CRON_SECRET || "";

const MAX_SEND_ATTEMPTS = 3;

interface SendResult {
  phone: string;
  contact_id: string | null;
  status: "sent" | "failed" | "skipped";
  wa_message_id?: string | null;
  error?: string;
}

/** Resolve recipients for a campaign's WhatsApp channel and enqueue them. */
export async function enqueueCampaignWhatsapp(orgId: string, campaignId: string): Promise<number> {
  const { data: campaign, error: cErr } = await db
    .from("smrtreach_campaigns")
    .select("audience, channel, status, scheduled_at, country_filter, ignore_send_window")
    .eq("org_id", orgId)
    .eq("id", campaignId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!campaign) throw new Error("campaign not found");
  if (campaign.channel !== "whatsapp" && campaign.channel !== "both") {
    throw new Error("campaign channel is not whatsapp");
  }
  if (campaign.status === "sending" || campaign.status === "done") {
    throw new Error(`campaign already ${campaign.status} — cannot send again`);
  }

  const { data: detail, error: dErr } = await db
    .from("smrtreach_campaign_whatsapp")
    .select("bot_ref, template, body_text, recipient_cap, tz_hour")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (dErr) throw new Error(dErr.message);
  if (!detail?.bot_ref) throw new Error("campaign has no bot selected");
  if (!detail.template && !detail.body_text) throw new Error("campaign has no WhatsApp template or text");

  let recipients = await resolveAudience(orgId, (campaign.audience ?? {}) as AudienceRef, "whatsapp");
  recipients = recipients.filter((r) => r.phone);

  const countryFilter = campaign.country_filter as string | null;
  if (countryFilter && countryFilter !== "all") {
    recipients = recipients.filter((r) => matchesCountry(r.phone, countryFilter));
  }

  // Recipient cap (botsite max_recipients) — hard limit on this broadcast.
  const cap = detail.recipient_cap as number | null;
  if (cap && cap > 0 && recipients.length > cap) {
    recipients = recipients.slice(0, cap);
  }

  // "Send now" ignores the campaign schedule (rows become due immediately).
  // Otherwise: a tz_hour sends each recipient at that LOCAL hour in their own
  // timezone (derived from phone prefix); else the campaign-level scheduled_at.
  const ignoreWindow = campaign.ignore_send_window === true;
  const tzHour = (detail.tz_hour as number | null) ?? null;
  const campaignScheduled = !ignoreWindow && campaign.scheduled_at ? new Date(campaign.scheduled_at as string) : new Date();
  const fallbackIso = !ignoreWindow && campaign.scheduled_at ? campaignScheduled.toISOString() : null;
  const rows = recipients.map((r) => {
    let scheduledAt = fallbackIso;
    if (!ignoreWindow && tzHour !== null) {
      scheduledAt = nextOccurrenceOfHourInTz(tzHour, tzForPhone(r.phone), campaignScheduled).toISOString();
    }
    return {
      org_id: orgId,
      campaign_id: campaignId,
      channel: "whatsapp",
      contact_id: r.contact_id,
      to_address: r.phone as string,
      status: "pending",
      scheduled_at: scheduledAt,
    };
  });
  if (rows.length === 0) return 0;

  let queued = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("smrtreach_queue").insert(chunk);
    if (error) throw new Error(`enqueue: ${error.message}`);
    queued += chunk.length;
  }

  await db.from("smrtreach_campaigns").update({ status: "sending" }).eq("org_id", orgId).eq("id", campaignId);
  await emitEvent(orgId, "smrtreach", "campaign.sending", "campaign", campaignId, { queued, channel: "whatsapp" });
  return queued;
}

interface ProcessResult { sent: number; failed: number; skipped: number; remaining: number }

/** Reset WhatsApp rows orphaned in 'sending' back to pending (capped). */
export async function reapStuckWhatsapp(orgId: string, olderThanMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { data: stuck } = await db
    .from("smrtreach_queue")
    .select("id, attempts")
    .eq("org_id", orgId)
    .eq("channel", "whatsapp")
    .eq("status", "sending")
    .lt("claimed_at", cutoff);
  if (!stuck || stuck.length === 0) return 0;
  let requeued = 0;
  for (const row of stuck) {
    const attempts = (row.attempts as number) ?? 0;
    if (attempts + 1 >= MAX_SEND_ATTEMPTS) {
      await db.from("smrtreach_queue").update({ status: "failed", error: "exceeded max send attempts", attempts: attempts + 1 }).eq("id", row.id);
    } else {
      await db.from("smrtreach_queue").update({ status: "pending", claimed_at: null, attempts: attempts + 1 }).eq("id", row.id);
      requeued++;
    }
  }
  return requeued;
}

interface WaDetail {
  bot_ref: string;
  template: string | null;
  template_lang: string | null;
  template_params: unknown[] | null;
  body_text: string | null;
  sendHours: SendHours;
  excludeShabbat: boolean;
}

/**
 * Claim a bounded batch of *due* pending WhatsApp rows and hand them to
 * smrtBot's send-service, grouped by campaign. Only 'sending' campaigns within
 * their send-window send (pause/schedule/Shabbat hold). Concurrency-safe via
 * the conditional claim.
 */
export async function processWhatsappQueue(orgId: string, limit = 100): Promise<ProcessResult> {
  if (!SMRTBOT_SECRET) throw new Error("SMRTBOT_INTERNAL_SECRET (or CRON_SECRET) is not set");

  const nowIso = new Date().toISOString();
  const { data: candidates, error: candErr } = await db
    .from("smrtreach_queue")
    .select("id, campaign_id")
    .eq("org_id", orgId)
    .eq("channel", "whatsapp")
    .eq("status", "pending")
    .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit * 3);
  if (candErr) throw new Error(candErr.message);
  if (!candidates || candidates.length === 0) return { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  const detailCache = new Map<string, WaDetail | null>();
  const sendableCache = new Map<string, boolean>();

  async function getDetail(campaignId: string): Promise<WaDetail | null> {
    if (detailCache.has(campaignId)) return detailCache.get(campaignId)!;
    const { data } = await db
      .from("smrtreach_campaign_whatsapp")
      .select("bot_ref, template, template_lang, template_params, body_text, send_hours, exclude_shabbat")
      .eq("campaign_id", campaignId)
      .maybeSingle();
    const detail: WaDetail | null = data
      ? {
          bot_ref: data.bot_ref as string,
          template: (data.template as string | null) ?? null,
          template_lang: (data.template_lang as string | null) ?? null,
          template_params: (data.template_params as unknown[] | null) ?? null,
          body_text: (data.body_text as string | null) ?? null,
          sendHours: (data.send_hours as SendHours | null) ?? {},
          excludeShabbat: (data.exclude_shabbat as boolean | null) ?? true,
        }
      : null;
    detailCache.set(campaignId, detail);
    return detail;
  }

  async function campaignSendable(campaignId: string): Promise<boolean> {
    if (sendableCache.has(campaignId)) return sendableCache.get(campaignId)!;
    const { data: c } = await db
      .from("smrtreach_campaigns").select("status, ignore_send_window").eq("org_id", orgId).eq("id", campaignId).maybeSingle();
    const detail = await getDetail(campaignId);
    // "Send now" bypasses the send-window/Shabbat rule.
    const ignoreWindow = c?.ignore_send_window === true;
    const w = ignoreWindow ? { ok: true } : detail ? withinSendWindow(detail.sendHours, detail.excludeShabbat) : { ok: false };
    const ok = c?.status === "sending" && w.ok;
    sendableCache.set(campaignId, ok);
    return ok;
  }

  // Pick claimable ids for sendable campaigns, up to the overall limit.
  const claimIds: string[] = [];
  for (const row of candidates) {
    if (claimIds.length >= limit) break;
    if (!(await campaignSendable(row.campaign_id as string))) continue;
    claimIds.push(row.id as string);
  }
  if (claimIds.length === 0) return { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  const { data: claimed, error: claimErr } = await db
    .from("smrtreach_queue")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .in("id", claimIds)
    .select("id, campaign_id, contact_id, to_address");
  if (claimErr) throw new Error(claimErr.message);
  if (!claimed || claimed.length === 0) return { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  // Group claimed rows by campaign.
  const byCampaign = new Map<string, typeof claimed>();
  for (const row of claimed) {
    const cid = row.campaign_id as string;
    const arr = byCampaign.get(cid) ?? [];
    arr.push(row);
    byCampaign.set(cid, arr);
  }

  let sent = 0, failed = 0, skipped = 0;

  for (const [campaignId, rows] of byCampaign) {
    const detail = await getDetail(campaignId);
    if (!detail?.bot_ref || (!detail.template && !detail.body_text)) {
      for (const row of rows) {
        await db.from("smrtreach_queue").update({ status: "failed", error: "missing bot/template" }).eq("id", row.id);
        failed++;
      }
      continue;
    }

    // Hand the batch to smrtBot's send-service (template preferred, else text).
    let results: SendResult[] = [];
    try {
      const resp = await fetch(SMRTBOT_SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-smrtbot-secret": SMRTBOT_SECRET },
        body: JSON.stringify({
          bot_id: detail.bot_ref,
          recipients: rows.map((r) => ({ phone: r.to_address, contact_id: r.contact_id })),
          ...(detail.template
            ? { template: { name: detail.template, lang: detail.template_lang ?? "he", components: detail.template_params ?? undefined } }
            : { text: detail.body_text }),
        }),
      });
      if (!resp.ok) throw new Error(`smrtBot send-service ${resp.status}`);
      const json = (await resp.json()) as { results?: SendResult[] };
      results = json.results ?? [];
    } catch (e) {
      // Whole batch failed to hand off — mark rows failed so the reaper/retry can re-pick.
      const msg = e instanceof Error ? e.message : String(e);
      for (const row of rows) {
        await db.from("smrtreach_queue").update({ status: "failed", error: msg }).eq("id", row.id);
        failed++;
      }
      continue;
    }

    // Map results back to queue rows by phone.
    const byPhone = new Map(results.map((r) => [r.phone, r]));
    for (const row of rows) {
      const r = byPhone.get(row.to_address as string);
      if (!r) {
        await db.from("smrtreach_queue").update({ status: "failed", error: "no result returned" }).eq("id", row.id);
        failed++;
        continue;
      }
      if (r.status === "sent") {
        const { error: mErr } = await db.from("smrtreach_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id);
        if (mErr) console.error("[smrtreach.wa] mark sent failed:", row.id, mErr.message);
        await db.from("smrtreach_logs").insert({
          org_id: orgId, campaign_id: campaignId, contact_id: row.contact_id,
          channel: "whatsapp", status: "sent", wa_message_id: r.wa_message_id ?? null, sent_at: new Date().toISOString(),
        });
        sent++;
      } else if (r.status === "skipped") {
        await db.from("smrtreach_queue").update({ status: "skipped", error: r.error ?? "skipped" }).eq("id", row.id);
        skipped++;
      } else {
        const { error: mErr } = await db.from("smrtreach_queue").update({ status: "failed", error: r.error ?? "failed" }).eq("id", row.id);
        if (mErr) console.error("[smrtreach.wa] mark failed failed:", row.id, mErr.message);
        await db.from("smrtreach_logs").insert({
          org_id: orgId, campaign_id: campaignId, contact_id: row.contact_id,
          channel: "whatsapp", status: "failed", error: r.error ?? "failed",
        });
        failed++;
      }
    }
  }

  // Flip drained campaigns to done (shared with email so 'both' waits for both).
  for (const campaignId of byCampaign.keys()) {
    await maybeCompleteCampaign(orgId, campaignId);
  }

  const { count: remaining } = await db
    .from("smrtreach_queue")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("channel", "whatsapp").eq("status", "pending");

  return { sent, failed, skipped, remaining: remaining ?? 0 };
}
