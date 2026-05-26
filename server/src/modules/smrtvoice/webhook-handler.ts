/**
 * Webhook handler for voice-engine callbacks.
 *
 * MOUNTED AT APP LEVEL, BEFORE THE AUTH MIDDLEWARE, because voice-engine
 * authenticates these requests via HMAC, not via a Supabase JWT.
 *
 * Body must be the raw JSON we receive; do not modify it before
 * verification.
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
        await handleJobStarted(job_id, project_id);
        break;
      case "smrtvoice.line.completed":
        await handleLineCompleted(job_id, project_id, data ?? {});
        break;
      case "smrtvoice.job.completed":
        await handleJobCompleted(job_id, project_id, data ?? {});
        break;
      case "smrtvoice.job.failed":
        await handleJobFailed(job_id, project_id, data ?? {});
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

async function handleJobStarted(jobId: string, projectId: string): Promise<void> {
  await db
    .from("smrtvoice_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
    })
    .eq("voice_engine_job_id", jobId);

  await db
    .from("smrtvoice_projects")
    .update({ status: "processing" })
    .eq("id", projectId);
}

async function handleLineCompleted(
  _jobId: string,
  projectId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const lineId = data.line_id as string | undefined;
  const audioPath = data.output_audio_path as string | undefined;
  const duration = (data.duration_seconds as number | undefined) ?? 0;
  const cost = (data.cost_usd as number | undefined) ?? 0;

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
  }

  // Increment per-project totals via RPC.
  await db.rpc("increment_project_progress", {
    p_project_id: projectId,
    p_cost: cost,
    p_duration: duration,
  });
}

async function handleJobCompleted(
  jobId: string,
  projectId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const totalCost = (data.total_cost_usd as number | undefined) ?? 0;
  const totalDuration = (data.total_duration_seconds as number | undefined) ?? 0;
  const linesCompleted = (data.lines_completed as number | undefined) ?? 0;
  const linesFailed = (data.lines_failed as number | undefined) ?? 0;

  await db
    .from("smrtvoice_jobs")
    .update({
      status: "completed",
      progress: 100,
      completed_at: new Date().toISOString(),
      total_cost_usd: totalCost,
      result: data,
    })
    .eq("voice_engine_job_id", jobId);

  const { data: project, error: projectErr } = await db
    .from("smrtvoice_projects")
    .update({
      status: "audio_ready",
      audio_ready_at: new Date().toISOString(),
      total_cost_usd: totalCost,
      total_duration_seconds: totalDuration,
      completed_lines: linesCompleted,
      failed_lines: linesFailed,
    })
    .eq("id", projectId)
    .select()
    .maybeSingle();

  if (projectErr) {
    console.error("[smrtvoice webhook] project update failed:", projectErr.message);
    return;
  }
  if (!project) return;

  await notify(project.org_id, project.created_by, {
    app_slug: "smrtvoice",
    type: "success",
    title: `הקול לפרויקט ${project.name} מוכן`,
    body: `${linesCompleted} שורות הסתיימו בהצלחה. עלות: $${totalCost.toFixed(2)}`,
    link: `/voice/projects/${projectId}/audio`,
    entity_type: "project",
    entity_id: projectId,
  });

  await emitEvent(
    project.org_id,
    "smrtvoice",
    "audio.ready",
    "project",
    projectId,
    {
      lines_completed: linesCompleted,
      total_cost_usd: totalCost,
      total_duration_seconds: totalDuration,
    },
  );
}

async function handleJobFailed(
  jobId: string,
  projectId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const errorMessage = (data.error as string | undefined) ?? "Unknown error";

  await db
    .from("smrtvoice_jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("voice_engine_job_id", jobId);

  const { data: project } = await db
    .from("smrtvoice_projects")
    .update({ status: "failed" })
    .eq("id", projectId)
    .select()
    .maybeSingle();

  if (project) {
    await notifyError(project.org_id, "smrtvoice", {
      title: `הייצור לפרויקט ${project.name} נכשל`,
      body: errorMessage,
      link: `/voice/projects/${projectId}`,
    });
  }
}

export default router;
