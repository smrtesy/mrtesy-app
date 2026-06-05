import { db } from "../../db";
import type { NotifyParams, NotifyErrorParams } from "./types";

export async function notify(
  orgId: string,
  userId: string,
  params: NotifyParams,
): Promise<void> {
  const { error } = await db.from("notifications").insert({
    org_id:       orgId,
    user_id:      userId,
    app_slug:     params.app_slug,
    type:         params.type,
    title:        params.title,
    body:         params.body ?? null,
    link:         params.link ?? null,
    entity_type:  params.entity_type ?? null,
    entity_id:    params.entity_id ?? null,
    from_user_id: params.from_user_id ?? null,
  });
  if (error) console.error("[platform.notify]", error.message);
}

/**
 * Route a technical error to the org's designated error handler.
 * Falls back to the org owner when error_handler_user_id is not set.
 *
 * In addition to the tenant-level handler notification, this records the error
 * in log_entries (level='error'), which is the platform's single super-admin
 * fan-out channel: the notify_superadmins_on_error trigger turns that row into
 * an alert for every super-admin (deduped per affected-user + category + error).
 * Because every app already calls notifyError() for handling-required failures,
 * this gives super-admins comprehensive, future-proof coverage — any current or
 * future app that uses this helper is automatically included, exactly like the
 * smrtTask/Google pipeline that writes log_entries directly.
 */
export async function notifyError(
  orgId: string,
  appSlug: string,
  params: NotifyErrorParams,
): Promise<void> {
  // Resolve the error handler for this org
  const { data: org } = await db
    .from("organizations")
    .select("error_handler_user_id, created_by")
    .eq("id", orgId)
    .maybeSingle();

  if (!org) return;

  const handlerUserId = org.error_handler_user_id ?? org.created_by;

  // Tenant-level: notify the org's designated error handler — UNLESS the handler
  // is a super-admin, who will already receive the platform-level alert from the
  // notify_superadmins_on_error trigger (via the log_entries row below). Skipping
  // here avoids a double notification for super-admin org owners.
  const { data: sa } = await db
    .from("super_admins")
    .select("user_id")
    .eq("user_id", handlerUserId)
    .maybeSingle();

  if (!sa) {
    await notify(orgId, handlerUserId, {
      app_slug: appSlug,
      type:     "action_required",
      title:    params.title,
      body:     params.body,
      link:     params.link,
    });
  }

  // Platform-level: log the error so the super-admin fan-out trigger picks it
  // up. user_id is the org's handler/owner (best available "who" without the
  // request user); category is the app slug so it groups + dedups per app.
  // Best-effort: a logging failure must never break the caller's error path.
  const { error: logErr } = await db.from("log_entries").insert({
    user_id:       handlerUserId,
    level:         "error",
    category:      appSlug,
    status:        "failed",
    source_type:   appSlug,
    subject:       params.title,
    error_message: params.body ?? params.title,
  });
  if (logErr) console.error("[platform.notifyError] log_entries insert:", logErr.message);
}
