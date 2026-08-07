import dotenv from "dotenv";
dotenv.config({ override: true }); // .env always wins over shell environment

// ── Startup env diagnostics (visible in Railway logs) ────────────────────────
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const presentEnv = REQUIRED_ENV.map((k) => `${k}=${process.env[k] ? "✓" : "✗ MISSING"}`);
const optionalEnv = ["ANTHROPIC_API_KEY", "FRONTEND_URL", "PORT", "NODE_ENV", "RESEND_API_KEY", "RESEND_FROM_EMAIL"]
  .map((k) => `${k}=${process.env[k] ? "✓" : "—"}`);
console.log("[startup] required env:", presentEnv.join(", "));
console.log("[startup] optional env:", optionalEnv.join(", "));

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[startup] FATAL: missing required env vars: ${missing.join(", ")}`);
  console.error("[startup] Set them in your hosting provider (Railway → Variables) and redeploy.");
  process.exit(1);
}

import express from "express";
import cors from "cors";
import { db } from "./db";
import quickActionRouter from "./routes/quick-action";
import inboxRouter from "./routes/inbox";
import messagesRouter from "./routes/messages";
import clientErrorsRouter from "./routes/client-errors";
import platformRouter, { searchCronRouter } from "./modules/platform";
import { ensureDestinationsIndexed } from "./modules/platform/search/indexer";
import adminRouter from "./modules/admin";
import { webActionRouter, startIdleSweeper as startWebActionSweeper } from "./modules/web-action";
import { startHealthSampler } from "./lib/health-sampler";
import smrttaskRouter, { claudeSessionRouter, dailyReportJobsRouter, driveCatalogRouter } from "./modules/smrttask";
import smrtvoiceRouter, { webhookRouter as smrtvoiceWebhookRouter } from "./modules/smrtvoice";
import smrtcrmRouter, { ingestRouter as smrtcrmIngestRouter } from "./modules/smrtcrm";
import smrtdesignRouter from "./modules/smrtdesign";
import smrtreachRouter, { unsubscribeRouter as smrtreachUnsubscribeRouter, publicRouter as smrtreachPublicRouter } from "./modules/smrtreach";
import smrtbotRouter, { internalRouter as smrtbotInternalRouter, webRouter as smrtbotWebRouter, jobsRouter as smrtbotJobsRouter, initBaileysConnections } from "./modules/smrtbot";
import smrtplanRouter, { jobsRouter as smrtplanJobsRouter, sessionReportRouter as smrtplanSessionReportRouter, experimentsMachineRouter as smrtplanExperimentsMachineRouter } from "./modules/smrtplan";
import smrtstudioRouter, { jobsRouter as smrtstudioJobsRouter } from "./modules/smrtstudio";
import correctionsJobsRouter from "./modules/smrttask/corrections/jobs";
import developerMonitorJobsRouter from "./modules/admin/developer-monitor/jobs";
import smrtvaultRouter from "./modules/smrtvault";
import smrtinfoRouter, { cronRouter as smrtinfoCronRouter } from "./modules/smrtinfo";
import claudeRouter, {
  claudeActionM2MRouter,
  claudeDeployQueueRouter,
  startClaudeRunRecovery,
  startDeployCoordinator,
  startShipWatcher,
} from "./modules/claude";

const app = express();
// Disable Express's automatic weak ETag on responses. Every route here serves
// dynamic, per-user authenticated JSON (e.g. the ~1s Claude-console `/live`
// poll) — none of it should be conditionally cached. With an ETag, an unchanged
// poll body makes the browser revalidate and Express answers 304 Not Modified;
// the frontend `api()` client treats any non-2xx (304 included) as a failure,
// logs a `client_error` row and pages every super-admin. A 304 is a success,
// not an error — removing the validator means no conditional request and no 304
// ever surfaces. (The service worker's offline snapshot lives in Cache Storage,
// independent of the HTTP cache, so it is unaffected.)
app.set("etag", false);
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "0.0.0.0"; // Bind to all interfaces — required by Railway/Fly/Render

// ── Middleware ────────────────────────────────────────────────────────────────
// CORS MUST be registered BEFORE express.json() so preflight OPTIONS requests
// don't have their bodies parsed (and so OPTIONS short-circuits without hitting
// downstream middleware that could 502 on a proxy like Railway).
//
// Allowed origins come from FRONTEND_URL (comma-separated). Falls back to
// localhost:3000 for local development only — production hosts must set the env var.
// We also accept any *.<APP_DOMAIN> subdomain (the multi-tenant model gives each
// org its own subdomain, plus app.<APP_DOMAIN> for the platform). Otherwise we'd
// need to update FRONTEND_URL on every new tenant.
const allowedOrigins = (process.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const appDomain = (process.env.APP_DOMAIN ?? process.env.NEXT_PUBLIC_APP_DOMAIN ?? "")
  .trim()
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");

console.log("[cors] allowed origins:", allowedOrigins.join(", "), appDomain ? `| wildcard: *.${appDomain}` : "");

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;
  if (!appDomain) return false;
  try {
    const host = new URL(origin).hostname;
    // Match the apex (smrtesy.com) and any subdomain (app.smrtesy.com,
    // <tenant>.smrtesy.com). Guards against suffix tricks like
    // "evilsmrtesy.com" by requiring an exact host match or "<x>.<appDomain>".
    return host === appDomain || host.endsWith(`.${appDomain}`);
  } catch {
    return false;
  }
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // Server-to-server or curl/Postman calls have no Origin header — allow.
    if (!origin) return cb(null, true);
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn(`[cors] rejected origin: ${origin}`);
    cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Org-Id", "X-Cron-Secret"],
};

app.use(cors(corsOptions));
// Explicitly handle ALL preflight requests so they short-circuit BEFORE any
// body-parsing or route logic. Some proxies (Railway, Vercel) otherwise 502.
app.options(/.*/, cors(corsOptions));

// `verify` exposes the raw, unparsed body to downstream handlers via
// `req.rawBody`. The WhatsApp webhook needs the exact bytes Meta signed in
// X-Hub-Signature-256, and re-stringifying the parsed JSON loses the
// original whitespace/ordering. Limit bumped to 10mb for history chunks.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

// Captured at module load — when this Node process booted. Servers a deploy
// "tag" the frontend can show next to its own one, so the user can spot
// staleness without leaving the app.
const BACKEND_BOOT_AT = new Date().toISOString();

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Deploy info — commit SHA + boot time from Railway env vars (or any other
// host that injects RAILWAY_GIT_*). Used by /settings to show which backend
// the frontend is talking to. Intentionally open (no auth) so the frontend
// can call it before login too.
app.get("/api/version", (_req, res) => {
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA ?? "";
  res.json({
    commit:          commit || null,
    commit_short:    commit ? commit.slice(0, 7) : null,
    branch:          process.env.RAILWAY_GIT_BRANCH ?? null,
    commit_message:  process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? null,
    deployment_id:   process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    boot_at:         BACKEND_BOOT_AT,
    uptime_seconds:  Math.floor(process.uptime()),
  });
});

// NOTE: the WhatsApp inbound webhook is no longer served here. It moved to
// the Vercel Next.js route src/app/api/webhooks/whatsapp/route.ts (for uptime
// — a Railway dyno restart no longer drops incoming messages). Meta delivers
// directly to that route; this Express server only serves the API.

// smrtVoice webhook is also unauthenticated — voice-engine signs it with HMAC,
// so it must come BEFORE the auth-guarded routers (same reasoning as above).
app.use(smrtvoiceWebhookRouter);

// smrtReach public endpoints are unauthenticated (recipients clicking links,
// SES/SNS, and the secret-guarded cron caller aren't logged-in users), so they
// must come BEFORE the auth-guarded smrtReach router.
app.use("/api", smrtreachUnsubscribeRouter);
app.use("/api", smrtreachPublicRouter);

// smrtCRM public inbound ingest is token-authenticated (no JWT), so before auth.
app.use("/api", smrtcrmIngestRouter);

// smrtBot internal inbound + cron job routes — shared-secret guarded (the
// Vercel webhook / pg_cron call them), so they come BEFORE the auth guards.
app.use(smrtbotInternalRouter);
app.use(smrtbotWebRouter);
app.use(smrtbotJobsRouter);

// smrtPlan engine refresh — shared-secret guarded (pg_cron calls it), so it
// comes BEFORE the auth-guarded routers (same reasoning as smrtBot jobs).
app.use(smrtplanJobsRouter);
app.use(smrtstudioJobsRouter);
// Correction-triage recovery sweep — same shared-secret pattern, so a triage
// lost to a redeploy is picked up instead of leaving the user's correction
// silently unjudged.
app.use(correctionsJobsRouter);

// smrtTask Claude Code session proposals — x-cron-secret guarded (the Claude
// Code Stop hook calls it), so it comes BEFORE the auth-guarded routers too.
app.use("/api", claudeSessionRouter);

// Claude console coalescing deploy queue — x-cron-secret guarded (a console run's
// hook / push step calls it), so it comes BEFORE the auth-guarded routers too.
// docs/claude-console/deploy-queue-plan.md.
app.use("/api", claudeDeployQueueRouter);

// Google Drive catalog scanner — x-cron-secret guarded (kicked by this session
// and self-draining server-side). Walks a shared Drive subtree into
// public.drive_catalog. Mounted before the auth guards like the other machine
// routers.
app.use("/api", driveCatalogRouter);

// smrtPlan Claude Code auto session report — x-cron-secret guarded (a Claude
// Code Stop hook calls it), so it comes BEFORE the auth-guarded routers too.
app.use("/api", smrtplanSessionReportRouter);

// smrtPlan video-lab experiment writes — x-cron-secret guarded (the video-lab
// harness calls it), so it comes BEFORE the auth-guarded routers too.
app.use("/api", smrtplanExperimentsMachineRouter);

// דוח יומי weekly report job — x-cron-secret guarded (pg_cron calls it), so it
// comes BEFORE the auth-guarded routers (route path already includes /api).
app.use(dailyReportJobsRouter);

// smrtInfo batch extraction — x-cron-secret guarded (the data-population runner
// calls it), so it comes BEFORE the auth-guarded routers too.
app.use("/api", smrtinfoCronRouter);
app.use("/api", searchCronRouter);

// Developer-access monitor sweep — x-cron-secret guarded (pg_cron calls it every
// 5 min), so it comes BEFORE the auth-guarded routers (route path includes /api).
app.use(developerMonitorJobsRouter);

app.use("/api", platformRouter);
app.use("/api", adminRouter);
app.use("/api", webActionRouter);
app.use("/api", smrttaskRouter);
app.use("/api", smrtvoiceRouter);
app.use("/api", smrtcrmRouter);
app.use("/api", smrtreachRouter);
app.use("/api", smrtbotRouter);
app.use("/api", smrtplanRouter);
app.use("/api", smrtstudioRouter);
app.use("/api", smrtvaultRouter);
app.use("/api", smrtinfoRouter);
app.use("/api", smrtdesignRouter);
app.use("/api", claudeRouter);
// The in-app Claude's machine-to-machine gate (destructive-migration approval),
// gated by the shared internal secret rather than a JWT — mounted alongside the
// other m2m surface (claudeSessionRouter) and NOT under the super-admin chain.
app.use("/api", claudeActionM2MRouter);
app.use("/api/quick-action", quickActionRouter);
app.use("/api/inbox", inboxRouter);
app.use("/api/messages", messagesRouter);
// Frontend global error catcher sink (requireAuth only; user-scoped log_entries).
app.use("/api/client-errors", clientErrorsRouter);

// ── Global error safety-net ───────────────────────────────────────────────────
// Any error reaching here was NOT handled by a route's own try/catch (those
// already call notifyError). Record it as a level='error' log_entries row so the
// notify_superadmins_on_error trigger fans it out to every super-admin — closing
// the "unhandled 500" gap so server errors reach platform operators even when a
// route forgot to report them. Best-effort logging; the 500 response is always
// sent. (Process-level crashes / edge functions are outside this net by nature.)
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const userId = (req as express.Request & { user?: { id?: string } }).user?.id ?? null;
  console.error("[global-error-handler]", req.method, req.path, message);
  // Fire-and-forget; never let the safety-net's own logging throw or block the
  // 500 response. Wrapped in an async IIFE so a rejection can't escape.
  void (async () => {
    try {
      const { error } = await db.from("log_entries").insert({
        user_id: userId,
        level: "error",
        category: "server",
        status: "failed",
        source_type: "server",
        subject: `${req.method} ${req.originalUrl}`.slice(0, 500),
        error_message: message,
      });
      if (error) console.error("[global-error-handler] log insert:", error.message);
    } catch (e) {
      console.error("[global-error-handler] log threw:", e);
    }
  })();
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

// ── smrtTask pipeline ─────────────────────────────────────────────────────────
// Collection + classification run exclusively through Supabase pg_cron edge
// functions (gmail-sync / batch-details / ai-process). The legacy server-side
// scheduler was removed — it duplicated that work and produced an untracked
// Sonnet bill. Manual/on-demand runs still go through routes/sync.ts.

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * Ensure the Chromium browser used by the admin domain-tracker is present —
 * downloaded once into PLAYWRIGHT_BROWSERS_PATH (a persistent Railway volume),
 * NOT during the build. `playwright install` is idempotent: it skips when the
 * right version is already there, so this only actually downloads on first boot
 * after a fresh volume or a Playwright upgrade. The OS libraries come from the
 * image (build step). Best-effort + non-blocking — never delays/crashes boot.
 */
function ensureChromium(): void {
  if (process.env.INSTALL_CHROMIUM !== "1") return;
  void (async () => {
    try {
      const { execFile } = await import("node:child_process");
      const path = await import("node:path");
      // Resolve the playwright CLI via its package dir (subpath imports are
      // blocked by the package's "exports"); run it from there.
      const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
      execFile(process.execPath, [cli, "install", "chromium"], { env: process.env }, (err, stdout) => {
        if (err) console.error("[chromium] install failed (domain-tracker may be unavailable):", err.message);
        else console.log("[chromium] ready:", (stdout || "").toString().trim().split("\n").pop() || "ok");
      });
    } catch (e) {
      console.error("[chromium] ensure skipped:", e instanceof Error ? e.message : e);
    }
  })();
}

app.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
  ensureChromium();
  // web-action: sweep idle browser sessions so a walked-away signup can't hold
  // a Chromium on the host forever. No-op until a session is created.
  startWebActionSweeper();
  // Seed the global-search navigation destinations so settings/pages search
  // works immediately after a deploy. Best-effort, non-blocking; skips when
  // already seeded (see ensureDestinationsIndexed).
  void ensureDestinationsIndexed().catch((e) =>
    console.error("[startup] ensureDestinationsIndexed failed:", e),
  );
  // Resume any unofficial WhatsApp (Baileys) connections that were already
  // paired. Best-effort — a failure here must never crash boot. Assumes a
  // single replica (two sockets on one number get logged out by WhatsApp).
  void initBaileysConnections().catch((e) =>
    console.error("[startup] initBaileysConnections failed:", e),
  );
  // Continue Claude console turns whose in-process child died with a restarted
  // container: find runs stuck 'running'/'queued' with no live process and
  // re-execute them (context rebuilt from our DB). Runs on the subscription — no
  // paid tokens. Assumes a single replica, same as the Baileys note above.
  startClaudeRunRecovery();

  // Coalescing deploy queue coordinator (docs/claude-console/deploy-queue-plan.md).
  // A no-op unless DEPLOY_QUEUE_ENABLED=1 — safe to ship while phase 2 (the push
  // gate that feeds the queue) is still flag-gated off.
  startDeployCoordinator();

  // Ship-status watcher — polls the production build state of every thread that
  // pushed to main and flips its rail dot green (live) / red (build failed). Runs
  // ALWAYS (not queue-flag gated): a frontend push straight to main is exactly the
  // deploy that used to end with an unfulfilled "אעדכן כשזה יעלה". Zero paid tokens.
  startShipWatcher();

  // Passive backend health sampler — records event-loop lag + in-flight console
  // run count + provider states into server_health_samples every ~30s, so the
  // sidebar status strip can show real history and "did a fix help?" is a query,
  // not a synthetic load test. Zero paid tokens; single replica like the above.
  startHealthSampler();
});

// Surface unhandled errors so Railway logs show them instead of a silent crash
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
