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
import syncRouter from "./routes/sync";
import actionsRouter from "./routes/actions";
import quickActionRouter from "./routes/quick-action";
import inboxRouter from "./routes/inbox";
import messagesRouter from "./routes/messages";
import baseRouter from "./modules/base";
import adminRouter from "./modules/admin";
import { runPart1 } from "./parts/part1-collector";
import { runPart2 } from "./parts/part2-whatsapp";
import { runPart3 } from "./parts/part3-classifier";

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
const allowedOrigins = (process.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

console.log("[cors] allowed origins:", allowedOrigins.join(", "));

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // Server-to-server or curl/Postman calls have no Origin header — allow.
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
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

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/api", baseRouter);
app.use("/api", adminRouter);
app.use("/api/sync", syncRouter);
app.use("/api/actions", actionsRouter);
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
      if (schedule.part === "part1") {
        await runPart1({ userId: schedule.user_id });
      } else if (schedule.part === "part2") {
        await runPart2({ userId: schedule.user_id });
      } else if (schedule.part === "part3") {
        // Part 3 is org-aware: use the user's primary org (oldest membership).
        // Skip the schedule entry if the user has no org or smrtesy isn't enabled there.
        const { data: membership } = await db
          .from("org_members")
          .select("org_id")
          .eq("user_id", schedule.user_id)
          .order("joined_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!membership) {
          console.warn(`[cron] part3 skipped — user ${schedule.user_id} has no org`);
          continue;
        }

        const { data: app } = await db.from("apps").select("id").eq("slug", "smrtesy").maybeSingle();
        const { data: entitled } = await db
          .from("app_memberships")
          .select("org_id")
          .eq("org_id", membership.org_id)
          .eq("app_id", app?.id ?? "")
          .maybeSingle();
        if (!entitled) {
          console.warn(`[cron] part3 skipped — smrtesy not enabled for org ${membership.org_id}`);
          continue;
        }

        await runPart3({ userId: schedule.user_id, orgId: membership.org_id as string });
      }

      // Advance next_run_at by 8 hours
      const next = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
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
