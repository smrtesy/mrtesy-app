import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware";
import { db } from "../db";

/**
 * POST /api/client-errors
 *
 * The backend sink for the frontend global error catcher (src/lib/error-capture.ts).
 * Every failed API call, uncaught JS error, and unhandled promise rejection the
 * browser catches is recorded here as a level='error' log_entries row
 * (category='client_error'). That single row is fanned out to every super-admin by
 * the notify_superadmins_on_error trigger and surfaces in the daily health report —
 * so client-side errors become visible platform-wide, not just on the device.
 *
 * Feature-channels reuses this same sink (docs/feature-channels-plan.md §8) with
 * two extra categories on the SAME row shape — no separate endpoint:
 *   • 'feature'        — a PaneErrorBoundary auto-caught a crash inside a feature.
 *   • 'feature_report' — the user pressed "report a problem" and sent the context.
 * Both carry feature_id / screen_key in details; a report also carries its
 * user-shown context under details.report.
 *
 * Auth: requireAuth only. log_entries is user-scoped (no org_id column), and we want
 * to attribute the error to whoever hit it — no app/org gate to fail on.
 */
const router = Router();

// Per-user in-memory rate limit — a client-side loop is already de-duplicated and
// capped in the browser; this is the server-side backstop so a misbehaving or
// malicious client can't flood log_entries. 40 rows / 5 min / user, best-effort.
const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 40;
const hits = new Map<string, { start: number; count: number }>();

function overLimit(userId: string): boolean {
  const now = Date.now();
  // Opportunistic eviction so the map doesn't grow one permanent entry per user
  // for the process lifetime — prune stale windows whenever it gets sizeable.
  if (hits.size > 500) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  const h = hits.get(userId);
  if (!h || now - h.start > WINDOW_MS) {
    hits.set(userId, { start: now, count: 1 });
    return false;
  }
  h.count += 1;
  return h.count > MAX_PER_WINDOW;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// The category the row lands under. Anything outside this allowlist (or absent)
// falls back to the original client_error, so a malformed client can't invent
// arbitrary categories.
const ALLOWED_CATEGORIES = new Set(["client_error", "feature", "feature_report"]);

/** Cap a nested report/object so a client can't push an unbounded blob into the
 *  row's details. Serialises, truncates, and reparses (best-effort). */
function clampObject(v: unknown, max: number): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined;
  try {
    const s = JSON.stringify(v);
    if (s.length <= max) return v as Record<string, unknown>;
    return { truncated: true, preview: s.slice(0, max) };
  } catch {
    return undefined;
  }
}

router.post("/", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  // Always ack — the client fires this best-effort and must never see an error
  // FROM the error reporter (that would recurse through the same catcher).
  if (overLimit(userId)) return res.status(202).json({ ok: true, throttled: true });

  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = str(b.kind, 16) ?? "unknown";
  const message = str(b.message, 2000) ?? "(no message)";
  const route = str(b.route, 500);
  const categoryIn = str(b.category, 32);
  const category = categoryIn && ALLOWED_CATEGORIES.has(categoryIn) ? categoryIn : "client_error";

  const details: Record<string, unknown> = {
    kind,
    route,
    status: typeof b.status === "number" ? b.status : undefined,
    method: str(b.method, 12) ?? undefined,
    url: str(b.url, 500) ?? undefined,
    response_body: str(b.responseBody, 800) ?? undefined,
    stack: str(b.stack, 4000) ?? undefined,
    user_agent: str(b.userAgent, 400) ?? undefined,
    // Feature-channels tags (present only on 'feature' / 'feature_report' rows).
    feature_id: str(b.feature_id, 128) ?? undefined,
    screen_key: str(b.screen_key, 200) ?? undefined,
    // The user-shown context of a proactive report (recent errors, failed
    // requests, app version, channel, browser). Capped so it can't bloat the row.
    report: clampObject(b.report, 8000),
  };

  const { error } = await db.from("log_entries").insert({
    user_id: userId,
    level: "error",
    category,
    status: "failed",
    error_message: message,
    source_type: `client:${kind}`,
    source_url: route,
    details,
  });
  if (error) {
    // Log for our own operators; still ack so the browser doesn't retry-storm.
    console.error("[client-errors] insert failed:", error.message);
  }
  return res.status(202).json({ ok: true });
});

export default router;
