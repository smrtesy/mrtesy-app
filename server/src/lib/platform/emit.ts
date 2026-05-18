import { db } from "../../db";
import { APP_REGISTRY } from "./registry";
import { notify } from "./notify";

export async function emitEvent(
  orgId: string,
  sourceApp: string,
  eventType: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { data: event, error } = await db
    .from("app_events")
    .insert({
      org_id:      orgId,
      source_app:  sourceApp,
      event_type:  eventType,
      entity_type: entityType,
      entity_id:   entityId,
      payload,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[platform.emit] insert failed:", error.message);
    return;
  }

  // Find the source manifest to check notification definitions
  const sourceManifest = APP_REGISTRY.find((m) => m.slug === sourceApp);
  const notifDef = sourceManifest?.notifications[eventType];

  if (notifDef) {
    // Resolve the target user: find the org owner to receive notifications by default.
    // Apps can override this by calling notify() directly with a specific user.
    const { data: org } = await db
      .from("organizations")
      .select("created_by, error_handler_user_id")
      .eq("id", orgId)
      .maybeSingle();

    if (org) {
      const userId = org.created_by as string;
      const title = typeof notifDef.title === "function"
        ? notifDef.title(payload)
        : notifDef.title;
      const body = notifDef.body
        ? (typeof notifDef.body === "function" ? notifDef.body(payload) : notifDef.body)
        : undefined;
      const link = notifDef.link
        ? (typeof notifDef.link === "function" ? notifDef.link(payload) : notifDef.link)
        : undefined;

      await notify(orgId, userId, {
        app_slug:    sourceApp,
        type:        notifDef.type,
        title,
        body,
        link,
        entity_type: entityType,
        entity_id:   entityId,
      });
    }
  }

  // Route to subscribed apps
  const processed: string[] = [];
  for (const manifest of APP_REGISTRY) {
    if (manifest.slug === sourceApp) continue;
    const sub = manifest.subscribes.find(
      (s) => s.event === eventType && (s.source === sourceApp || s.source === "*"),
    );
    if (!sub) continue;

    try {
      const handler = await import(`../../apps/${manifest.slug}/${sub.handler}`);
      await handler.default({ id: event.id, orgId, sourceApp, eventType, entityType, entityId, payload });
      processed.push(manifest.slug);
    } catch (e) {
      console.error(`[platform.emit] handler ${manifest.slug}/${sub.handler}:`, e);
    }
  }

  if (processed.length > 0) {
    const { error: updateErr } = await db
      .from("app_events")
      .update({ processed_by: processed })
      .eq("id", event.id);
    if (updateErr) console.error("[platform.emit] processed_by update failed:", updateErr.message);
  }
}
