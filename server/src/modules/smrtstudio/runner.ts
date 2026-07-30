/**
 * smrtStudio — the fal runner (stage C of docs/studio-build-plan.md).
 *
 * The studio's production engine for fal-hosted models, mirroring the
 * video-lab harness contract exactly:
 *   * async QUEUE only (queue.fal.run) — never the blocking run endpoint;
 *   * full write-once provenance on every run (endpoint verbatim, the exact
 *     payload, the fal request id — the join key to real billing);
 *   * outputs downloaded to the studio-media bucket the moment they exist,
 *     because fal links die after 24 hours;
 *   * quantity-aware cost estimate BEFORE submit (rule 2: the client shows it
 *     and the user approves it — the route refuses to run without the ack);
 *     a unit price is NEVER recorded as a total (the 2026-07-30 cost-bug fix).
 *
 * Completion arrives twice on purpose: a per-run webhook (fast path, verified
 * by a per-run token minted at submit) AND a cron poller that sweeps runs
 * stuck in `submitted` — a lost webhook must never strand a paid output past
 * the 24h link window.
 */

import crypto from "node:crypto";
import { db } from "../../db";

const QUEUE_BASE = "https://queue.fal.run";

type Row = Record<string, unknown>;

export function falKey(): string | null {
  return process.env.FAL_KEY || null;
}

function publicUrl(): string | null {
  const raw = process.env.SMRTESY_PUBLIC_URL || null;
  if (!raw) return null;
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

// --- cost estimate (port of the harness quantity-aware fix) -----------------

const PER_CALL_UNITS = ["image", "clip", "shot", "request", "call", "video", "unit"];

function durationSeconds(args: Record<string, unknown>): number | null {
  for (const key of ["duration", "num_seconds", "duration_seconds", "seconds"]) {
    const v = args[key];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const m = /^(\d+(?:\.\d+)?)\s*s?$/.exec(v.trim());
      if (m) return parseFloat(m[1]);
    }
  }
  return null;
}

/** (usd|null, basis). null = "cannot be honestly estimated up front" — the
 *  client shows that in words; it is never rendered as $0. */
export function estimateRunCost(
  model: { price_usd: number | string | null; price_unit: string | null },
  args: Record<string, unknown>,
): { usd: number | null; basis: string } {
  const usd = model.price_usd == null ? null : Number(model.price_usd);
  if (usd == null || Number.isNaN(usd)) return { usd: null, basis: "no_price" };
  const unit = (model.price_unit || "unit").toLowerCase();
  if (unit.includes("megapixel") || unit.includes("token")) {
    return { usd: null, basis: `unit_price_only:${unit}` };
  }
  if (unit.includes("second")) {
    const dur = durationSeconds(args);
    if (dur) return { usd: Math.round(usd * dur * 1000) / 1000, basis: `per_second×${dur}s` };
    return { usd: null, basis: "per_second_unknown_duration" };
  }
  if (PER_CALL_UNITS.some((u) => unit.includes(u))) {
    return { usd, basis: `per_${unit}` };
  }
  return { usd: null, basis: `unit_price_only:${unit}` };
}

// --- fal queue ---------------------------------------------------------------

export async function queueSubmit(
  endpointId: string,
  input: Record<string, unknown>,
  webhookUrl: string | null,
): Promise<{ request_id: string }> {
  const key = falKey();
  if (!key) throw new Error("FAL_KEY is not configured on the backend");
  const url = new URL(`${QUEUE_BASE}/${endpointId}`);
  if (webhookUrl) url.searchParams.set("fal_webhook", webhookUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`fal queue submit ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) throw new Error("fal queue submit returned no request_id");
  return { request_id: data.request_id };
}

export async function queueResult(
  endpointId: string,
  requestId: string,
): Promise<{ status: "completed" | "in_progress" | "failed"; result: unknown }> {
  const key = falKey();
  if (!key) throw new Error("FAL_KEY is not configured on the backend");
  const headers = { Authorization: `Key ${key}` };
  const status = await fetch(
    `${QUEUE_BASE}/${endpointId}/requests/${requestId}/status`,
    { headers },
  );
  if (!status.ok) {
    throw new Error(`fal status ${status.status}: ${(await status.text()).slice(0, 300)}`);
  }
  const s = (await status.json()) as { status?: string };
  if (s.status !== "COMPLETED") {
    return { status: s.status === "FAILED" ? "failed" : "in_progress", result: null };
  }
  const res = await fetch(`${QUEUE_BASE}/${endpointId}/requests/${requestId}`, { headers });
  if (!res.ok) {
    throw new Error(`fal result ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return { status: "completed", result: await res.json() };
}

// --- output handling ----------------------------------------------------------

/** Pull (url, kind) pairs out of a fal result of any common shape — the same
 *  extraction the harness uses (images / video / audio / bare url). */
export function extractOutputUrls(result: unknown): { url: string; kind: string }[] {
  const out: { url: string; kind: string }[] = [];
  if (!result || typeof result !== "object") return out;
  const r = result as Record<string, unknown>;
  const add = (obj: unknown, kind: string) => {
    if (Array.isArray(obj)) { for (const item of obj) add(item, kind); return; }
    if (obj && typeof obj === "object" && typeof (obj as Row).url === "string") {
      out.push({ url: (obj as Row).url as string, kind });
    }
  };
  add(r.images, "image");
  add(r.image, "image");
  add(r.video, "video");
  add(r.videos, "video");
  add(r.audio, "audio");
  if (!out.length && typeof r.url === "string") out.push({ url: r.url, kind: "file" });
  return out;
}

function extFromUrl(url: string, kind: string): string {
  const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url);
  if (m) return m[1].toLowerCase();
  return kind === "image" ? "png" : kind === "audio" ? "mp3" : "mp4";
}

/**
 * Download every output into studio-media (<org_id>/<code>/<n>.<ext>) and
 * return signed URLs. Immediate by design — rule 6, fal links die in 24h.
 */
export async function downloadOutputs(
  orgId: string,
  code: string,
  urls: { url: string; kind: string }[],
): Promise<{ storage_paths: string[]; output_url: string | null; download_errors: string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const { url, kind } = urls[i];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const path = `${orgId}/${code}/${i}.${extFromUrl(url, kind)}`;
      const { error } = await db.storage
        .from("studio-media")
        .upload(path, bytes, { contentType: res.headers.get("content-type") ?? undefined, upsert: true });
      if (error) throw new Error(error.message);
      paths.push(path);
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let outputUrl: string | null = null;
  if (paths.length) {
    const { data } = await db.storage
      .from("studio-media")
      .createSignedUrl(paths[0], 60 * 60 * 24 * 365);
    outputUrl = data?.signedUrl ?? null;
  }
  return { storage_paths: paths, output_url: outputUrl, download_errors: errors };
}

// --- completion (shared by webhook and poller) ---------------------------------

/**
 * Drive one submitted run to its terminal state. Idempotent: a webhook and a
 * poller may both call it; the first to find a terminal state wins and the
 * second sees run_status != submitted and returns.
 */
export async function settleRun(runId: string): Promise<void> {
  const { data: run, error } = await db.from("experiment_runs")
    .select("id, org_id, code, endpoint_id, fal_request_id, run_status, meta")
    .eq("id", runId).maybeSingle();
  if (error || !run) return;
  if (run.run_status !== "submitted" || !run.endpoint_id || !run.fal_request_id) return;

  let outcome: { status: string; result: unknown };
  try {
    outcome = await queueResult(run.endpoint_id as string, run.fal_request_id as string);
  } catch (e) {
    // Transient read failure: leave it `submitted`; the poller retries.
    console.error(`[studio-runner] settle ${run.code}:`, e);
    return;
  }
  if (outcome.status === "in_progress") return;

  if (outcome.status === "failed") {
    await db.from("experiment_runs").update({
      run_status: "failed",
      error: "fal reported FAILED",
    }).eq("id", runId);
    return;
  }

  const urls = extractOutputUrls(outcome.result);
  const dl = await downloadOutputs(run.org_id as string, run.code as string, urls);
  const meta = { ...((run.meta as Row) ?? {}) } as Row;
  meta.storage_paths = dl.storage_paths;
  if (dl.download_errors.length) meta.download_errors = dl.download_errors;
  const seed = (outcome.result as Row | null)?.seed;
  if (seed !== undefined) meta.seed_returned = seed;

  const { error: upErr } = await db.from("experiment_runs").update({
    run_status: dl.storage_paths.length ? "downloaded" : "failed",
    error: dl.storage_paths.length ? null : "no output url in fal result",
    output_url: dl.output_url,
    meta,
  }).eq("id", runId).eq("run_status", "submitted");
  if (upErr) console.error(`[studio-runner] settle update ${run.code}:`, upErr.message);
}

/** Sweep runs stuck in `submitted` — the webhook-loss safety net. */
export async function pollSubmittedRuns(olderThanMinutes = 2): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { data, error } = await db.from("experiment_runs")
    .select("id")
    .eq("run_status", "submitted")
    .lt("created_at", cutoff)
    .limit(50);
  if (error || !data) return 0;
  for (const r of data) await settleRun(r.id as string);
  return data.length;
}

export function newRunCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (const byte of crypto.randomBytes(4)) code += alphabet[byte % alphabet.length];
  return code;
}

export function newWebhookToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function webhookUrlFor(runId: string, token: string): string | null {
  const base = publicUrl();
  if (!base) return null;
  return `${base}/api/studio/jobs/fal-webhook?run=${runId}&token=${token}`;
}
