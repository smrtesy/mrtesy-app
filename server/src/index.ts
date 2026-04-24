import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { db } from "./db";
import syncRouter from "./routes/sync";
import actionsRouter from "./routes/actions";
import { runPart1 } from "./parts/part1-collector";
import { runPart2 } from "./parts/part2-whatsapp";
import { runPart3 } from "./parts/part3-classifier";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/api/sync", syncRouter);
app.use("/api/actions", actionsRouter);

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
        await runPart3({ userId: schedule.user_id });
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
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
