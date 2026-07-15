/**
 * Webhook handler for voice-engine callbacks.
 *
 * MOUNTED AT APP LEVEL, BEFORE THE AUTH MIDDLEWARE, because voice-engine
 * authenticates these requests via HMAC, not via a Supabase JWT.
 *
 * Body must be the raw JSON we receive; do not modify it before
 * verification.
 *
 * v2: work is scoped to a SCRIPT (a project is now a folder of scripts).
 * The webhook envelope still carries `project_id` at the top level, but the
 * script it belongs to is resolved from the job row (smrtvoice_jobs.script_id)
 * or, for line events, from `data.script_id` sent by the orchestrator.
 */

import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { emitEvent, notify, notifyError } from "../../lib/platform";

import { getVoiceEngineClient } from "./voice-engine-client";

const router = Router();

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

router.post("/api/voice/webhook", async (req: Request, res: Response) => {
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];

  if (typeof signature !== "string" || typeof timestamp !== "string") {
    return res.status(401).json({ error: "Missing signature headers" });
  }

  // Verify against the EXACT bytes voice-engine signed. server/src/index.ts
  // captures these via express.json({verify: ...}) into req.rawBody.
  // If the buffer is missing (shouldn't happen in this app), we fall back to
  // re-serialising, but key ordering may not match and the signature will fail.
  const rawBuf = (req as RawBodyRequest).rawBody;
  const rawBody = rawBuf ? rawBuf.toString("utf8") : JSON.stringify(req.body ?? {});

  const client = getVoiceEngineClient();
  if (!client.verifyWebhookSignature(rawBody, signature, timestamp)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { event_type, job_id, project_id, data } = req.body ?? {};
  if (!event_type || !job_id || !project_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    switch (event_type) {
      case "smrtvoice.job.started":
        await handleJobStarted(job_id);
        break;
      case "smrtvoice.line.completed":
        await handleLineCompleted(job_id, data ?? {});
        break;
      case "smrtvoice.job.completed":
        await handleJobCompleted(job_id, data ?? {});
        break;
      case "smrtvoice.job.failed":
        await handleJobFailed(job_id, data ?? {});
        break;
      default:
        // Unknown event types are non-fatal — log and ack.
        console.warn(`[smrtvoice webhook] unknown event: ${event_type}`);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[smrtvoice webhook] handler failed:", err);
    return res.status(500).json({ error: "Handler failed" });
  }
});

async function handleJobStarted(jobId: string): Promise<void> {
  // Promote ONLY from 'queued'. job.started is now durable + re-delivered, so a
  // late/duplicate copy could otherwise arrive after job.completed (or after
  // the user cancelled) and flip a finished job/script back to running. The
  // status guard makes it a no-op once the job has left 'queued'.
  const { data: job, error } = await db
    .from("smrtvoice_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("voice_engine_job_id", jobId)
    .eq("status", "queued")
    .select("script_id")
    .maybeSingle();

  if (error) {
    console.error("[smrtvoice webhook] job.started update failed:", error.message);
    return;
  }

  // Only advance the script when THIS call actually promoted the job — never
  // drag a script that's already audio_ready/failed back to processing.
  const scriptId = (job?.script_id as string | undefined) ?? null;
  if (scriptId) {
    await db
      .from("smrtvoice_scripts")
      .update({ status: "processing" })
      .eq("id", scriptId)
      .eq("status", "queued");
  }
}

async function handleLineCompleted(
  jobId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const lineId = data.line_id as string | undefined;
  const audioPath = data.output_audio_path as string | undefined;
  const duration = (data.duration_seconds as number | undefined) ?? 0;
  const cost = (data.cost_usd as number | undefined) ?? 0;
  const model = (data.model as string | undefined) ?? null;

  if (lineId && audioPath) {
    await db
      .from("smrtvoice_lines")
      .update({
        status: "completed",
        output_audio_path: audioPath,
        output_duration_seconds: duration,
        generation_cost_usd: cost,
      })
      .eq("id", lineId);

    // NOTE: take history (smrtvoice_line_takes) is written DIRECTLY by the
    // voice-engine worker (db/takes.py) as each clip lands — webhook-independent,
    // the same reliability pattern used for line status/progress. We deliberately
    // do NOT insert takes here: this callback is best-effort and often never
    // arrives, and doing so would double-record whenever it does.
  }

  // Unified cost ledger — Resemble TTS generation (best-effort).
  if (cost > 0) {
    try {
      await db.from("ai_usage").insert({
        provider: "resemble",
        component: "resemble.tts",
        model: model ?? "resemble",
        cost_usd: cost,
        ref_id: lineId ?? null,
      });
    } catch { /* ledger insert must not break webhook handling */ }
  }

  // NOTE: per-script progress counters (completed_lines, stage, cost, duration)
  // are now written DIRECTLY by the voice-engine worker, keyed by script_id, as
  // each line lands — see orchestrator._set_stage. That path is authoritative
  // and webhook-independent (it works even when this callback URL is
  // misconfigured). We deliberately do NOT increment here anymore: doing so
  // would double-count the moment both paths are live.
}

async function handleJobCompleted(
  jobId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const totalCost = (data.total_cost_usd as number | undefined) ?? 0;
  const totalDuration = (data.total_duration_seconds as number | undefined) ?? 0;
  const linesCompleted = (data.lines_completed as number | undefined) ?? 0;
  const linesFailed = (data.lines_failed as number | undefined) ?? 0;

  const { data: job, error: jobErr } = await db
    .from("smrtvoice_jobs")
    .update({
      status: "completed",
      progress: 100,
      completed_at: new Date().toISOString(),
      total_cost_usd: totalCost,
      result: data,
    })
    .eq("voice_engine_job_id", jobId)
    .select("id, job_type, script_id")
    .maybeSingle();

  if (jobErr) {
    console.error("[smrtvoice webhook] job.completed update failed:", jobErr.message);
    return;
  }

  const scriptId =
    (job?.script_id as string | undefined) ?? (data.script_id as string | undefined) ?? null;
  if (!scriptId) return;

  // A line-regeneration job must not clobber a fully-completed script back to
  // audio_ready with a partial count — only stamp counts on full generation.
  const isRegenerate = job?.job_type === "regenerate_line";

  const scriptUpdate: Record<string, unknown> = {
    status: "audio_ready",
    audio_ready_at: new Date().toISOString(),
  };
  if (!isRegenerate) {
    scriptUpdate.total_cost_usd = totalCost;
    scriptUpdate.total_duration_seconds = totalDuration;
    scriptUpdate.completed_lines = linesCompleted;
    scriptUpdate.failed_lines = linesFailed;
  }

  const { data: script, error: scriptErr } = await db
    .from("smrtvoice_scripts")
    .update(scriptUpdate)
    .eq("id", scriptId)
    .select("id, org_id, project_id, created_by, code, name")
    .maybeSingle();

  if (scriptErr) {
    console.error("[smrtvoice webhook] script update failed:", scriptErr.message);
    return;
  }
  if (!script) return;

  // Fire the user-facing notification + event EXACTLY once. The engine now
  // writes terminal status directly AND durably re-delivers this webhook (and
  // overlapping drains can deliver it twice), so a status/read-then-write guard
  // would race. Claim atomically: stamp terminal_notified_at only where it is
  // still NULL; if this call didn't win the claim, another already notified.
  if (!(await claimTerminalNotify(job?.id as string | undefined))) return;

  const label = script.name || script.code;
  await notify(script.org_id, script.created_by, {
    app_slug: "smrtvoice",
    type: "success",
    title: `הקול ל-${label} מוכן`,
    body: `${linesCompleted} שורות הסתיימו בהצלחה. עלות: $${totalCost.toFixed(2)}`,
    link: `/voice/scripts/${scriptId}`,
    entity_type: "script",
    entity_id: scriptId,
  });

  await emitEvent(script.org_id, "smrtvoice", "audio.ready", "script", scriptId, {
    project_id: script.project_id,
    lines_completed: linesCompleted,
    total_cost_usd: totalCost,
    total_duration_seconds: totalDuration,
  });
}

/**
 * Atomically claim the one-time terminal notification for a job. Sets
 * terminal_notified_at only if it is currently NULL and returns true iff THIS
 * call performed the transition — so concurrent/duplicate webhook deliveries
 * (and the direct-write + webhook race) notify at most once. Returns false when
 * jobId is missing or already claimed; logs and returns false on a DB error
 * (better to skip a duplicate-risk notify than to spam on every redelivery).
 */
async function claimTerminalNotify(jobId: string | undefined): Promise<boolean> {
  if (!jobId) return false;
  const { data, error } = await db
    .from("smrtvoice_jobs")
    .update({ terminal_notified_at: new Date().toISOString() })
    .eq("id", jobId)
    .is("terminal_notified_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[smrtvoice webhook] terminal-notify claim failed:", error.message);
    return false;
  }
  return Boolean(data);
}

async function handleJobFailed(
  jobId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const errorMessage = (data.error as string | undefined) ?? "Unknown error";

  const { data: job, error: jobErr } = await db
    .from("smrtvoice_jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("voice_engine_job_id", jobId)
    .select("id, script_id")
    .maybeSingle();

  if (jobErr) {
    console.error("[smrtvoice webhook] job.failed update failed:", jobErr.message);
    return;
  }

  const scriptId =
    (job?.script_id as string | undefined) ?? (data.script_id as string | undefined) ?? null;
  if (!scriptId) return;

  const { data: script } = await db
    .from("smrtvoice_scripts")
    .update({ status: "failed" })
    .eq("id", scriptId)
    .select("id, org_id, code, name")
    .maybeSingle();

  // Notify exactly once — the failure webhook is durably re-delivered and may
  // race the engine's direct write, so claim atomically (see handleJobCompleted).
  if (script && (await claimTerminalNotify(job?.id as string | undefined))) {
    await notifyError(script.org_id, "smrtvoice", {
      title: `הייצור ל-${script.name || script.code} נכשל`,
      body: errorMessage,
      link: `/voice/scripts/${scriptId}`,
    });
  }
}

export default router;
