/**
 * Railway deploy webhook → platform notification system.
 *
 * Railway POSTs here on every deployment status change. On a FAILED/CRASHED
 * deploy we fetch the build log via the Railway API and write a level='error'
 * row to log_entries — the notify_superadmins_on_error trigger then fans it out
 * to every super-admin's notification inbox, with the actual error inline. So
 * the reason a deploy failed reaches us without opening the Railway dashboard.
 *
 * This route lives on Vercel (NOT the Railway server) on purpose: if Railway is
 * down or crash-looping, the receiver must still be up to record why.
 *
 * Setup (one-time):
 *   1. Railway → Project → Settings → Webhooks → add
 *        https://<domain>/api/webhooks/railway
 *      with header x-railway-secret: <RAILWAY_WEBHOOK_SECRET>.
 *      (Legacy ?secret=<...> query param still works but is deprecated —
 *      secrets in URLs end up in access logs.)
 *   2. Vercel env: RAILWAY_WEBHOOK_SECRET (any random string) and
 *      RAILWAY_API_TOKEN (Railway → Settings → Tokens).
 *
 * Manual pull (to report an already-failed deploy without waiting for a new
 * one): GET .../api/webhooks/railway?secret=<S>&deploymentId=<ID>
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { fetchDeploymentLogs } from "@/lib/railway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAILURE_STATUSES = new Set(["FAILED", "CRASHED", "BUILD_FAILED", "DEPLOY_FAILED"]);

/** Treat anything in the known set OR any status that reads as a failure as an
 *  alert, so a status string Railway adds later isn't silently dropped. */
function isFailureStatus(status: string): boolean {
  return FAILURE_STATUSES.has(status) || /FAIL|CRASH|ERROR/.test(status);
}

// Constant-time secret comparison. `===` short-circuits on the first differing
// character, which leaks how much of the secret an attacker has guessed.
// timingSafeEqual requires equal-length buffers, so compare HMACs of both
// values (fixed 32-byte digests) under an ephemeral per-process key — the
// standard length-safe pattern.
const HMAC_KEY = randomBytes(32);
function secretsEqual(provided: string, expected: string): boolean {
  const a = createHmac("sha256", HMAC_KEY).update(provided).digest();
  const b = createHmac("sha256", HMAC_KEY).update(expected).digest();
  return timingSafeEqual(a, b);
}

function secretOk(request: NextRequest): boolean {
  const expected = process.env.RAILWAY_WEBHOOK_SECRET;
  if (!expected) return false;
  // Preferred: x-railway-secret header (keeps the secret out of URLs, which
  // land in access logs and browser history).
  const fromHeader = request.headers.get("x-railway-secret");
  if (fromHeader !== null) return secretsEqual(fromHeader, expected);
  // Deprecated fallback: ?secret= query param, kept for webhooks configured
  // before the header was supported.
  const fromQuery = new URL(request.url).searchParams.get("secret");
  if (fromQuery !== null) {
    console.warn(
      "[railway-webhook] secret received via ?secret= query param — deprecated; move it to the x-railway-secret header"
    );
    return secretsEqual(fromQuery, expected);
  }
  return false;
}

interface RailwayPayload {
  status?: string;
  type?: string;
  project?: { name?: string };
  environment?: { name?: string };
  service?: { name?: string };
  deployment?: { id?: string; status?: string; staticUrl?: string };
  deploymentId?: string;
}

/** Fetch the deployment's logs and record a super-admin alert. Returns the row id. */
async function reportFailure(meta: {
  deploymentId: string | null;
  status: string;
  service?: string;
  project?: string;
  environment?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = createAdminSupabaseClient();
  if (!db) return { ok: false, error: "admin client unavailable" };

  const logs = meta.deploymentId
    ? await fetchDeploymentLogs(meta.deploymentId)
    : "(no deploymentId in payload — cannot fetch logs)";

  const header = [
    `סטטוס: ${meta.status}`,
    meta.service ? `שירות: ${meta.service}` : null,
    meta.project ? `פרויקט: ${meta.project}` : null,
    meta.environment ? `סביבה: ${meta.environment}` : null,
    meta.deploymentId ? `Deployment: ${meta.deploymentId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const { error } = await db.from("log_entries").insert({
    level: "error",
    category: "railway",
    status: "failed",
    source_type: "railway",
    subject: `🚂 דפלוי Railway נכשל${meta.service ? ` · ${meta.service}` : ""}`,
    error_message: `${header}\n\n${logs}`.slice(0, 8000),
    details: { ...meta },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── POST: Railway webhook ─────────────────────────────────────
export async function POST(request: NextRequest): Promise<Response> {
  if (!secretOk(request)) return new Response("unauthorized", { status: 401 });

  const payload = (await request.json().catch(() => ({}))) as RailwayPayload;
  const status = (payload.status ?? payload.deployment?.status ?? "").toUpperCase();
  const deploymentId = payload.deployment?.id ?? payload.deploymentId ?? null;

  if (!isFailureStatus(status)) {
    return Response.json({ ok: true, ignored: status || "unknown" });
  }

  const result = await reportFailure({
    deploymentId,
    status,
    service: payload.service?.name,
    project: payload.project?.name,
    environment: payload.environment?.name,
  });
  // Always ack 2xx so Railway doesn't retry-storm; surface our own result.
  return Response.json({ ok: result.ok, recorded: result.ok, error: result.error });
}

// ── GET: manual pull for an already-failed deployment ─────────
export async function GET(request: NextRequest): Promise<Response> {
  if (!secretOk(request)) return new Response("unauthorized", { status: 401 });
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ error: "deploymentId is required" }, { status: 400 });

  const result = await reportFailure({ deploymentId, status: "MANUAL_PULL" });
  return Response.json({ ok: result.ok, recorded: result.ok, error: result.error });
}
