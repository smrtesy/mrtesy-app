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

/** Convenience: derive message + stack from a thrown value. */
export function errInfo(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  return { message: String(e) };
}
