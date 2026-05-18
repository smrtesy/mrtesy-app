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

  await notify(orgId, handlerUserId, {
    app_slug: appSlug,
    type:     "action_required",
    title:    params.title,
    body:     params.body,
    link:     params.link,
  });
}
