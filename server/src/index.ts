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
import cron from "node-cron";
import { db } from "./db";
import quickActionRouter from "./routes/quick-action";
import inboxRouter from "./routes/inbox";
import messagesRouter from "./routes/messages";
import platformRouter from "./modules/platform";
import adminRouter from "./modules/admin";
import smrttaskRouter from "./modules/smrttask";

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

// Limit bumped to 10mb for legacy WhatsApp history payloads — the webhook
// has moved to Vercel but other routes (admin imports, batch payloads) may
// rely on the headroom. Trim later if profile shows it's unused.
app.use(express.json({ limit: "10mb" }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Public webhook FIRST — mounted at app level, before any auth-guarded
// The WhatsApp webhook moved to Vercel (src/app/api/webhooks/whatsapp/
// route.ts) so its mount-first dance at the app level is gone too. Public
// routes that need to bypass auth-chained sub-routers should be mounted
// here, above the smrttask/admin routers, the same way the webhook was.
app.use("/api", platformRouter);
app.use("/api", adminRouter);
app.use("/api", smrttaskRouter);
app.use("/api/quick-action", quickActionRouter);
app.use("/api/inbox", inboxRouter);
app.use("/api/messages", messagesRouter);

// ── Cron Scheduler ────────────────────────────────────────────────────────────
// Reads sync_schedules table to decide which users/parts to run automatically.
// Default: 3x/day (7:00, 14:00, 21:00 local)

async function runScheduledJobs() {
  const now = new Date().toISOString();

  const { data: schedules } = await db
    .from("sync_schedules")
    .select("user_id, part")
    .eq("is_auto", true)
    .eq("is_enabled", true)
    .lt("next_run_at", now);

  if (!schedules || schedules.length === 0) return;

  for (const schedule of schedules) {
    try {
      // All cron-driven parts (part1 collection, part2 WhatsApp, part3
      // classification) moved to Supabase Edge Functions with their own
      // cron in Supabase. Legacy sync_schedules rows are silently skipped
      // until a follow-up migration cleans them up.
      if (schedule.part === "part1" || schedule.part === "part2" || schedule.part === "part3") {
        continue;
      }

      // Advance next_run_at by 15 minutes
      const next = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await db
        .from("sync_schedules")
        .update({ last_run_at: now, next_run_at: next })
        .eq("user_id", schedule.user_id)
        .eq("part", schedule.part);
    } catch (e) {
      console.error(`[cron] ${schedule.part} for ${schedule.user_id}:`, e);
    }
  }
}

// Check every 15 minutes whether any scheduled job is due
cron.schedule("*/15 * * * *", () => {
  runScheduledJobs().catch(console.error);
});

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
