import dotenv from "dotenv";
dotenv.config({ override: true }); // .env always wins over shell environment

// ── Startup env diagnostics (visible in Railway logs) ────────────────────────
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const presentEnv = REQUIRED_ENV.map((k) => `${k}=${process.env[k] ? "✓" : "✗ MISSING"}`);
const optionalEnv = ["ANTHROPIC_API_KEY", "FRONTEND_URL", "PORT", "NODE_ENV"]
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
import platformRouter from "./modules/platform";
import adminRouter from "./modules/admin";
import smrttaskRouter from "./modules/smrttask";
import smrtvoiceRouter, { webhookRouter as smrtvoiceWebhookRouter } from "./modules/smrtvoice";
import smrtbotRouter, { internalRouter as smrtbotInternalRouter, jobsRouter as smrtbotJobsRouter } from "./modules/smrtbot";

const app = express();
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

// smrtBot internal inbound + cron job routes — shared-secret guarded (the
// Vercel webhook / pg_cron call them), so they come BEFORE the auth guards.
app.use(smrtbotInternalRouter);
app.use(smrtbotJobsRouter);

app.use("/api", platformRouter);
app.use("/api", adminRouter);
app.use("/api", smrttaskRouter);
app.use("/api", smrtvoiceRouter);
app.use("/api", smrtbotRouter);
app.use("/api/quick-action", quickActionRouter);
app.use("/api/inbox", inboxRouter);
app.use("/api/messages", messagesRouter);

// ── smrtTask pipeline ─────────────────────────────────────────────────────────
// Collection + classification run exclusively through Supabase pg_cron edge
// functions (gmail-sync / batch-details / ai-process). The legacy server-side
// scheduler was removed — it duplicated that work and produced an untracked
// Sonnet bill. Manual/on-demand runs still go through routes/sync.ts.

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
});

// Surface unhandled errors so Railway logs show them instead of a silent crash
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
