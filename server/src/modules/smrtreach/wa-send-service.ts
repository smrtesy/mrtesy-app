/**
 * smrtReach — WhatsApp send service (stage G).
 *
 * smrtReach never talks to Meta directly (Reach-2). It resolves the audience
 * from smrtCRM, queues recipients, and hands bounded batches to smrtBot's
 * send-service (POST /api/bot/internal/send, shared-secret) which owns the
 * tokens, per-number throttle, opt-out enforcement and retries. Status comes
 * back synchronously in the response and is written to smrtReach's own tables.
 *
 * Mirrors the email queue: atomic claim → send → log → flip campaign on drain.
 */

import { db } from "../../db";
import { emitEvent } from "../../lib/platform";
import { resolveAudience } from "./audience-service";
import type { AudienceRef } from "./audience-service";

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
    .select("audience, channel, status")
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
    .select("bot_ref, template")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (dErr) throw new Error(dErr.message);
  if (!detail?.bot_ref) throw new Error("campaign has no bot selected");
  if (!detail.template) throw new Error("campaign has no WhatsApp template");

  const recipients = await resolveAudience(orgId, (campaign.audience ?? {}) as AudienceRef, "whatsapp");
  const rows = recipients
    .filter((r) => r.phone)
    .map((r) => ({
      org_id: orgId,
      campaign_id: campaignId,
      channel: "whatsapp",
      contact_id: r.contact_id,
      to_address: r.phone as string,
      status: "pending",
    }));
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

/**
 * Claim a bounded batch of pending WhatsApp rows and hand them to smrtBot's
 * send-service, grouped by campaign. Concurrency-safe via the conditional claim.
 */
export async function processWhatsappQueue(orgId: string, limit = 100): Promise<ProcessResult> {
  if (!SMRTBOT_SECRET) throw new Error("SMRTBOT_INTERNAL_SECRET (or CRON_SECRET) is not set");

  const { data: candidates, error: candErr } = await db
    .from("smrtreach_queue")
    .select("id")
    .eq("org_id", orgId)
    .eq("channel", "whatsapp")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (candErr) throw new Error(candErr.message);
  if (!candidates || candidates.length === 0) return { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  const ids = candidates.map((r) => r.id as string);
  const { data: claimed, error: claimErr } = await db
    .from("smrtreach_queue")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .in("id", ids)
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
    const { data: detail } = await db
      .from("smrtreach_campaign_whatsapp")
      .select("bot_ref, template, template_lang, template_params")
      .eq("campaign_id", campaignId)
      .maybeSingle();

    if (!detail?.bot_ref || !detail.template) {
      for (const row of rows) {
        await db.from("smrtreach_queue").update({ status: "failed", error: "missing bot/template" }).eq("id", row.id);
        failed++;
      }
      continue;
    }

    // Hand the batch to smrtBot's send-service.
    let results: SendResult[] = [];
    try {
      const resp = await fetch(SMRTBOT_SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-smrtbot-secret": SMRTBOT_SECRET },
        body: JSON.stringify({
          bot_id: detail.bot_ref,
          recipients: rows.map((r) => ({ phone: r.to_address, contact_id: r.contact_id })),
          template: {
            name: detail.template,
            lang: detail.template_lang ?? "he",
            components: detail.template_params ?? undefined,
          },
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

  // Flip drained campaigns to done.
  for (const campaignId of byCampaign.keys()) {
    const { count } = await db
      .from("smrtreach_queue")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("campaign_id", campaignId).in("status", ["pending", "sending"]);
    if ((count ?? 0) === 0) {
      await db.from("smrtreach_campaigns").update({ status: "done" }).eq("org_id", orgId).eq("id", campaignId);
      const { data: c } = await db.from("smrtreach_campaigns").select("name").eq("id", campaignId).maybeSingle();
      const { count: sentCount } = await db
        .from("smrtreach_logs").select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId).eq("status", "sent");
      await emitEvent(orgId, "smrtreach", "campaign.done", "campaign", campaignId, { name: c?.name ?? "", sent: sentCount ?? 0 });
    }
  }

  const { count: remaining } = await db
    .from("smrtreach_queue")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("channel", "whatsapp").eq("status", "pending");

  return { sent, failed, skipped, remaining: remaining ?? 0 };
}
