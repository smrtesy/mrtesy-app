/**
 * smrtCRM event handler: contact.observed (from smrtBot).
 *
 * smrtBot emits contact.observed when a WhatsApp user interacts with a bot
 * (engine.ts). smrtCRM ingests it (CRM-5): upsert the contact by phone (deduped)
 * and tag it with the source bot's project tag. smrtBot never writes smrtCRM
 * tables — the event is the seam.
 *
 * Event payload (from smrtbot engine): { bot_id, phone, name }.
 * entityId is the phone.
 *
 * Invoked by platform/emit.ts via dynamic import; signature is the event object.
 */

import { db } from "../../../db";
import { upsertContact, ensureTag, assignTag } from "../../../modules/smrtcrm/contacts-service";

interface PlatformEvent {
  id: string;
  orgId: string;
  sourceApp: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

/** created_by is NOT NULL → attribute bot-ingested contacts to the org owner. */
async function orgOwner(orgId: string): Promise<string | null> {
  const { data } = await db.from("organizations").select("created_by").eq("id", orgId).maybeSingle();
  return (data?.created_by as string) ?? null;
}

export default async function onBotContact(event: PlatformEvent): Promise<void> {
  const botId = event.payload.bot_id as string | undefined;
  const phone = (event.payload.phone as string | undefined) ?? event.entityId;
  const name = (event.payload.name as string | undefined) ?? null;
  if (!phone) return;

  const owner = await orgOwner(event.orgId);
  if (!owner) {
    console.error("[smrtcrm.onBotContact] org has no owner:", event.orgId);
    return;
  }

  // Split a single name into first/last (botsite stored one name field).
  let first_name: string | null = null;
  let last_name: string | null = null;
  if (name) {
    const parts = name.trim().split(/\s+/);
    first_name = parts[0] || null;
    last_name = parts.slice(1).join(" ") || null;
  }

  try {
    const result = await upsertContact(event.orgId, owner, {
      phone,
      first_name,
      last_name,
      source: "bot",
    });

    // Project tag derived from the source bot's name (cross-app read of
    // smrtbot_bots — declared in the manifest's entities.reads).
    if (botId) {
      const { data: bot } = await db
        .from("smrtbot_bots")
        .select("name")
        .eq("id", botId)
        .maybeSingle();
      const tagName = ((bot?.name as string) || `בוט ${botId.slice(0, 8)}`).trim();
      const tagId = await ensureTag(event.orgId, tagName, { kind: "project", botRef: botId, createdBy: owner });
      await assignTag(event.orgId, result.id, tagId);
    }
  } catch (e) {
    console.error("[smrtcrm.onBotContact]", e instanceof Error ? e.message : e);
  }
}
