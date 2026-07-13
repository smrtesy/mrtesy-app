/**
 * smrtBot — error reporting.
 *
 * Every attention-worthy error funnels through here: it persists a full,
 * copy-able record to smrtbot_error_logs AND raises a notifyError to the org's
 * error handler (so it lands in the inbox). The Errors panel renders these with
 * a Copy button so the operator can paste the whole context into Claude Code.
 */
import { db } from "../../db";
import { notifyError } from "../../lib/platform";

export interface ReportErrorParams {
  area: "engine" | "webhook" | "cron" | "send" | "route";
  title: string;
  message?: string;
  botId?: string | null;
  /** Bot env this error belongs to. "test" errors are logged but never raise a
   *  notification — operators only want inbox/push pings for LIVE numbers. */
  env?: "test" | "live" | null;
  details?: Record<string, unknown>;
  stack?: string;
  link?: string;
}

export async function reportError(orgId: string, p: ReportErrorParams): Promise<void> {
  const { error } = await db.from("smrtbot_error_logs").insert({
    org_id: orgId,
    bot_id: p.botId ?? null,
    area: p.area,
    title: p.title,
    message: p.message ?? null,
    details: p.details ?? {},
    stack: p.stack ?? null,
  });
  if (error) console.error("[smrtbot/reportError] persist failed:", error.message);

  // Test-env bots are sandbox numbers. Keep the persisted log (still visible in
  // the Errors panel for debugging) but do NOT raise an inbox/push notification —
  // operators only want to be pinged for LIVE numbers. (User request 2026-07-09.)
  if (p.env === "test") return;

  // Pack the full context into the notification body so the inbox's existing
  // "copy for AI" button captures everything for pasting into Claude Code.
  const body = [
    p.message,
    p.details && Object.keys(p.details).length > 0 ? `details: ${JSON.stringify(p.details)}` : null,
    p.stack ? `stack:\n${p.stack.split("\n").slice(0, 5).join("\n")}` : null,
  ]
    .filter((l): l is string => Boolean(l))
    .join("\n");

  await notifyError(orgId, "smrtbot", {
    title: `🔴 smrtBot — ${p.title}`,
    body,
    link: p.link ?? (p.botId ? `/bots/${p.botId}` : "/bots"),
  });
}

/** Convenience: derive message + stack from a thrown value.
 *
 * When the error carries a `detail` payload (e.g. WhatsAppSendError holds
 * Meta's raw error body), fold it into the message so the notification/log
 * shows *why* Meta rejected the send — otherwise a bare "Meta API 400"
 * strands the real reason (error code, subcode) in a field nobody reads. */
export function errInfo(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) {
    const detail = (e as { detail?: unknown }).detail;
    return { message: e.message + formatDetail(detail), stack: e.stack };
  }
  return { message: String(e) };
}

/** Render an error's `detail` as a short suffix, capped so a large upstream
 *  body can't bloat the notification. Empty/absent detail → no suffix. */
function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null || detail === "") return "";
  const str = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (!str) return "";
  const MAX = 800;
  return ` — ${str.length > MAX ? `${str.slice(0, MAX)}…` : str}`;
}
