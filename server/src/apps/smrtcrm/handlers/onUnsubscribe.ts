/**
 * smrtCRM event handler: contact.unsubscribed (from smrtReach).
 *
 * smrtReach's public unsubscribe page emits this event rather than writing
 * smrtCRM tables directly (Reach-4 / CRM-6 + the no-cross-app-import rule).
 * Here, in smrtCRM's own code, we flip the contact's email_unsubscribed flag —
 * the source of truth about the person lives in CRM.
 *
 * Invoked by platform/emit.ts via dynamic import; signature is the event object.
 */

import { db } from "../../../db";

interface PlatformEvent {
  id: string;
  orgId: string;
  sourceApp: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export default async function onUnsubscribe(event: PlatformEvent): Promise<void> {
  const contactId = event.entityId;
  if (!contactId) return;

  const { error } = await db
    .from("smrtcrm_contacts")
    .update({ email_unsubscribed: true })
    .eq("org_id", event.orgId)
    .eq("id", contactId);

  if (error) {
    console.error("[smrtcrm.onUnsubscribe]", error.message);
  }
}
