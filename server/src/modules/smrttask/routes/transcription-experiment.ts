/**
 * Transcription A/B experiment routes.
 *
 *   GET  /transcription-experiment/config        flags + arm settings
 *   GET  /transcription-experiment/pending       rows awaiting verdict
 *   GET  /transcription-experiment/stats         win-rate + cost summary
 *   POST /transcription-experiment/:id/verdict   { verdict: 'a'|'b'|'tie'|'skip', note? }
 *   POST /transcription-experiment/backfill      { days: 7 } — re-run on history
 *
 * The dual transcription itself is invoked from whatsapp-webhook.ts via
 * the helper exported below; this file owns the read+verdict API surface
 * and the backfill driver.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireFullTask } from "../lib/access";
import { getAppSecret } from "../../../db";
import { transcribeAudioDetailed } from "../../../gemini";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

// ── Experiment config helpers ────────────────────────────────────────────

export interface ExperimentArm {
  model: string;
  thinkingLevel: string;
}

export interface ExperimentConfig {
  enabled: boolean;
  armA: ExperimentArm;
  armB: ExperimentArm;
}

const DEFAULT_ARM_A: ExperimentArm = { model: "gemini-3-flash-preview", thinkingLevel: "high" };
const DEFAULT_ARM_B: ExperimentArm = { model: "gemini-2.5-pro",         thinkingLevel: "medium" };

export async function loadExperimentConfig(): Promise<ExperimentConfig> {
  const [enabled, modelA, thinkA, modelB, thinkB] = await Promise.all([
    getAppSecret("smrttask", "TRANSCRIPTION_EXPERIMENT_ENABLED", "TRANSCRIPTION_EXPERIMENT_ENABLED"),
    getAppSecret("smrttask", "TRANSCRIPTION_EXPERIMENT_MODEL_A", "TRANSCRIPTION_EXPERIMENT_MODEL_A"),
    getAppSecret("smrttask", "TRANSCRIPTION_EXPERIMENT_THINKING_A", "TRANSCRIPTION_EXPERIMENT_THINKING_A"),
    getAppSecret("smrttask", "TRANSCRIPTION_EXPERIMENT_MODEL_B", "TRANSCRIPTION_EXPERIMENT_MODEL_B"),
    getAppSecret("smrttask", "TRANSCRIPTION_EXPERIMENT_THINKING_B", "TRANSCRIPTION_EXPERIMENT_THINKING_B"),
  ]);
  return {
    enabled: String(enabled ?? "").toLowerCase() === "true",
    armA: { model: modelA || DEFAULT_ARM_A.model, thinkingLevel: thinkA || DEFAULT_ARM_A.thinkingLevel },
    armB: { model: modelB || DEFAULT_ARM_B.model, thinkingLevel: thinkB || DEFAULT_ARM_B.thinkingLevel },
  };
}

// ── Dual-transcription helper (called from the webhook) ──────────────────

interface DualTranscriptionInput {
  userId: string;
  wamid: string;
  whatsappMessageId: string | null;
  chatId: string | null;
  audioMime: string;
  audioReceivedAt: string | null;
  base64: string;
  source: "webhook" | "backfill";
  config: ExperimentConfig;
}

/**
 * Run both arms in parallel and upsert one row into transcription_experiments.
 * Returns the arm-A transcript so the caller can use it as the production
 * `body_text` value (the webhook does this when the flag is on).
 *
 * Existing rows for the same (user, wamid) are replaced — useful when the
 * backfill is re-run with different arm configs.
 */
export async function runDualTranscription(input: DualTranscriptionInput): Promise<{
  textA: string | null;
  textB: string | null;
}> {
  const { config } = input;

  const [resA, resB] = await Promise.allSettled([
    transcribeAudioDetailed(input.base64, input.audioMime, {
      model: config.armA.model,
      thinkingLevel: config.armA.thinkingLevel,
    }),
    transcribeAudioDetailed(input.base64, input.audioMime, {
      model: config.armB.model,
      thinkingLevel: config.armB.thinkingLevel,
    }),
  ]);

  const a = resA.status === "fulfilled" ? resA.value : null;
  const b = resB.status === "fulfilled" ? resB.value : null;
  const errA = resA.status === "rejected" ? String(resA.reason).slice(0, 500) : null;
  const errB = resB.status === "rejected" ? String(resB.reason).slice(0, 500) : null;

  // Preserve any verdict the user has already recorded for this wamid —
  // an upsert with verdict=null would otherwise wipe their judgment when
  // the backfill re-runs the same message with different arm configs.
  const { data: existing } = await db
    .from("transcription_experiments")
    .select("verdict, verdict_note, verdict_at")
    .eq("user_id", input.userId)
    .eq("wamid", input.wamid)
    .maybeSingle();

  const row: Record<string, unknown> = {
    user_id: input.userId,
    whatsapp_message_id: input.whatsappMessageId,
    wamid: input.wamid,
    chat_id: input.chatId,
    audio_received_at: input.audioReceivedAt,
    audio_mime: input.audioMime,
    model_a: config.armA.model,
    thinking_a: config.armA.thinkingLevel,
    transcript_a: a?.text ?? null,
    cost_a_usd: a?.costUsd ?? null,
    latency_a_ms: a?.latencyMs ?? null,
    error_a: errA,
    model_b: config.armB.model,
    thinking_b: config.armB.thinkingLevel,
    transcript_b: b?.text ?? null,
    cost_b_usd: b?.costUsd ?? null,
    latency_b_ms: b?.latencyMs ?? null,
    error_b: errB,
    source: input.source,
  };
  if (existing?.verdict) {
    row.verdict       = existing.verdict;
    row.verdict_note  = existing.verdict_note;
    row.verdict_at    = existing.verdict_at;
  }

  const { error } = await db
    .from("transcription_experiments")
    .upsert(row, { onConflict: "user_id,wamid" });
  if (error) {
    console.warn("[transcription-experiment] upsert failed:", error.message);
  }
  return { textA: a?.text ?? null, textB: b?.text ?? null };
}

// ── GET /transcription-experiment/config ─────────────────────────────────

router.get("/transcription-experiment/config", async (_req: Request, res: Response) => {
  const config = await loadExperimentConfig();
  res.json({ config });
});

// ── GET /transcription-experiment/pending ───────────────────────────────

router.get("/transcription-experiment/pending", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const limit = Math.min(Number(req.query.limit ?? 30), 200);

  const { data, error } = await db
    .from("transcription_experiments")
    .select("*")
    .eq("user_id", userId)
    .is("verdict", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  const experiments = (data ?? []) as Array<Record<string, unknown>>;

  // Resolve the corresponding whatsapp_messages rows in one round-trip so
  // the UI gets a media_url to play back and a sender name to show. We
  // join by wamid rather than the nullable FK to handle webhook-path rows
  // where the FK wasn't set at insert time.
  const wamids = experiments.map((e) => e.wamid as string).filter(Boolean);
  let msgByWamid: Record<string, Record<string, unknown>> = {};
  if (wamids.length > 0) {
    const { data: msgs } = await db
      .from("whatsapp_messages")
      .select("wamid, media_url, media_id, body_text, from_name, from_phone, received_at")
      .eq("user_id", userId)
      .in("wamid", wamids);
    msgByWamid = Object.fromEntries(
      (msgs ?? []).map((m) => [m.wamid as string, m as Record<string, unknown>]),
    );
  }
  for (const e of experiments) {
    e.whatsapp_message = msgByWamid[e.wamid as string] ?? null;
  }

  res.json({ experiments });
});

// ── POST /transcription-experiment/:id/verdict ──────────────────────────

router.post("/transcription-experiment/:id/verdict", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { verdict, note } = req.body ?? {};
  if (!["a", "b", "tie", "skip"].includes(verdict)) {
    return res.status(400).json({ error: "verdict must be a|b|tie|skip" });
  }
  const { error } = await db
    .from("transcription_experiments")
    .update({
      verdict,
      verdict_note: typeof note === "string" ? note.slice(0, 500) : null,
      verdict_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /transcription-experiment/stats ─────────────────────────────────

router.get("/transcription-experiment/stats", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { data, error } = await db
    .from("transcription_experiments")
    .select("verdict, model_a, model_b, cost_a_usd, cost_b_usd, latency_a_ms, latency_b_ms, error_a, error_b")
    .eq("user_id", userId);
  if (error) return res.status(500).json({ error: error.message });

  const rows = data ?? [];
  let totalCostA = 0;
  let totalCostB = 0;
  let countA = 0;
  let countB = 0;
  let latencyASum = 0;
  let latencyBSum = 0;
  let latencyACount = 0;
  let latencyBCount = 0;
  let errorsA = 0;
  let errorsB = 0;
  let verdictA = 0;
  let verdictB = 0;
  let verdictTie = 0;
  let verdictSkip = 0;
  let verdictPending = 0;

  let modelA: string | null = null;
  let modelB: string | null = null;

  for (const r of rows as Array<Record<string, unknown>>) {
    modelA = modelA ?? (r.model_a as string | null);
    modelB = modelB ?? (r.model_b as string | null);
    if (r.cost_a_usd != null) { totalCostA += Number(r.cost_a_usd); countA++; }
    if (r.cost_b_usd != null) { totalCostB += Number(r.cost_b_usd); countB++; }
    if (r.latency_a_ms != null) { latencyASum += Number(r.latency_a_ms); latencyACount++; }
    if (r.latency_b_ms != null) { latencyBSum += Number(r.latency_b_ms); latencyBCount++; }
    if (r.error_a) errorsA++;
    if (r.error_b) errorsB++;
    if (r.verdict === "a")       verdictA++;
    else if (r.verdict === "b")  verdictB++;
    else if (r.verdict === "tie") verdictTie++;
    else if (r.verdict === "skip") verdictSkip++;
    else                          verdictPending++;
  }

  res.json({
    total: rows.length,
    pending: verdictPending,
    verdicts: { a: verdictA, b: verdictB, tie: verdictTie, skip: verdictSkip },
    arm_a: {
      model: modelA,
      runs: countA,
      total_cost_usd: round6(totalCostA),
      avg_cost_usd: countA ? round6(totalCostA / countA) : 0,
      avg_latency_ms: latencyACount ? Math.round(latencyASum / latencyACount) : null,
      errors: errorsA,
    },
    arm_b: {
      model: modelB,
      runs: countB,
      total_cost_usd: round6(totalCostB),
      avg_cost_usd: countB ? round6(totalCostB / countB) : 0,
      avg_latency_ms: latencyBCount ? Math.round(latencyBSum / latencyBCount) : null,
      errors: errorsB,
    },
  });
});

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ── POST /transcription-experiment/backfill ─────────────────────────────

/**
 * Backfill the last N days of incoming audio messages. Runs in the
 * background — the response returns immediately with the count of
 * messages it plans to process.
 *
 * Caveat: Meta retains media for ~30 days from receipt. Messages older
 * than that will fail download and end up as `error_a` / `error_b` rows.
 */
router.post("/transcription-experiment/backfill", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const days = Math.min(Math.max(Number(req.body?.days ?? 7), 1), 30);
  const config = await loadExperimentConfig();

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Find audio/voice messages the user received within range that don't
  // already have an experiment row for this (user_id, wamid).
  const { data: candidates, error: candErr } = await db
    .from("whatsapp_messages")
    .select("id, wamid, chat_id, media_id, media_mime, received_at")
    .eq("user_id", userId)
    .in("message_type", ["audio", "voice"])
    .gte("received_at", since)
    .not("media_id", "is", null)
    .order("received_at", { ascending: false })
    .limit(500);

  if (candErr) return res.status(500).json({ error: candErr.message });
  const rows = (candidates ?? []) as Array<{
    id: string;
    wamid: string;
    chat_id: string | null;
    media_id: string;
    media_mime: string | null;
    received_at: string;
  }>;

  if (rows.length === 0) {
    return res.json({ queued: 0, days });
  }

  // Filter out wamids that already have an experiment row.
  const wamids = rows.map((r) => r.wamid);
  const { data: existing } = await db
    .from("transcription_experiments")
    .select("wamid")
    .eq("user_id", userId)
    .in("wamid", wamids);
  const alreadyDone = new Set((existing ?? []).map((e) => (e as { wamid: string }).wamid));
  const todo = rows.filter((r) => !alreadyDone.has(r.wamid));

  res.json({ queued: todo.length, days, skipped_already_done: alreadyDone.size });

  // Background worker — fire and forget. Each iteration awaits its own
  // dual transcription to avoid stampeding the Gemini quota.
  void (async () => {
    const accessToken = await loadAccessTokenForUser(userId);
    if (!accessToken) {
      console.warn(`[backfill] no whatsapp access token for user ${userId}, aborting`);
      return;
    }

    for (const row of todo) {
      try {
        const blob = await downloadMetaMediaById(row.media_id, accessToken);

        // Persist audio to storage and stamp media_url on the source row
        // so the review UI can play it back. We only fill media_url if
        // it's currently empty — we don't want to clobber a path written
        // by some other flow.
        try {
          const path = await persistAudioBlob(userId, row.wamid, blob);
          await db
            .from("whatsapp_messages")
            .update({ media_url: path })
            .eq("user_id", userId)
            .eq("id", row.id)
            .is("media_url", null);
        } catch (e) {
          console.warn(`[backfill] audio storage upload failed for ${row.wamid}:`, e);
        }

        await runDualTranscription({
          userId,
          wamid: row.wamid,
          whatsappMessageId: row.id,
          chatId: row.chat_id,
          audioMime: row.media_mime || blob.mimeType || "audio/ogg",
          audioReceivedAt: row.received_at,
          base64: blob.base64,
          source: "backfill",
          config,
        });
      } catch (e) {
        // Log a placeholder row so the user can see this wamid failed.
        const { error: phErr } = await db.from("transcription_experiments").upsert({
          user_id: userId,
          whatsapp_message_id: row.id,
          wamid: row.wamid,
          chat_id: row.chat_id,
          audio_received_at: row.received_at,
          audio_mime: row.media_mime,
          model_a: config.armA.model,
          thinking_a: config.armA.thinkingLevel,
          error_a: String(e).slice(0, 500),
          model_b: config.armB.model,
          thinking_b: config.armB.thinkingLevel,
          error_b: String(e).slice(0, 500),
          source: "backfill",
        }, { onConflict: "user_id,wamid" });
        if (phErr) console.warn(`[backfill] placeholder upsert failed for ${row.wamid}:`, phErr.message);
      }
    }
    console.log(`[backfill] done — ${todo.length} messages processed for user ${userId}`);
  })();
});

// Local helper: fetch the user's WhatsApp access token from Vault. Mirrors
// the resolveConnection path in whatsapp-webhook.ts.
async function loadAccessTokenForUser(userId: string): Promise<string | null> {
  const { data } = await db
    .from("whatsapp_connections")
    .select("access_token_secret_id")
    .eq("user_id", userId)
    .is("disconnected_at", null)
    .maybeSingle();
  const secretId = (data?.access_token_secret_id as string | null | undefined) ?? null;
  if (!secretId) return null;
  const { data: plaintext, error } = await db.rpc("vault_read_secret", { secret_id: secretId });
  if (error) {
    console.error(`[backfill] vault_read_secret(${secretId}) failed:`, error.message);
    return null;
  }
  return typeof plaintext === "string" ? plaintext : null;
}

// Upload audio bytes to the same `whatsapp-media` bucket the webhook uses
// for images. Mirrors persistMediaBlobToStorage in whatsapp-webhook.ts but
// without the cross-module export friction; we only need the path so we
// can stamp media_url on the source row.
async function persistAudioBlob(
  userId: string,
  wamid: string,
  blob: { base64: string; mimeType: string },
): Promise<string> {
  const buf = Buffer.from(blob.base64, "base64");
  const ext = audioExtForMime(blob.mimeType);
  const path = `${userId}/${wamid}-audio.${ext}`;
  const { error } = await db.storage.from("whatsapp-media").upload(path, buf, {
    contentType: blob.mimeType || "audio/ogg",
    upsert: true,
  });
  if (error) throw new Error(`storage upload: ${error.message}`);
  return path;
}

function audioExtForMime(mime: string | null | undefined): string {
  if (!mime) return "ogg";
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

// Local copy of downloadMetaMedia using the public Graph API. Duplicated
// (rather than imported from whatsapp-webhook.ts) because that file is
// a router with side effects and exporting an internal helper would
// pull along its module initialization.
async function downloadMetaMediaById(mediaId: string, token: string): Promise<{ base64: string; mimeType: string }> {
  const apiVersion = (await getAppSecret("smrttask", "META_API_VERSION", "META_API_VERSION")) || "v23.0";
  const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) throw new Error(`Meta media metadata ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new Error("Meta media response missing url");

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`Meta media download ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: meta.mime_type ?? "application/octet-stream" };
}

export default router;
