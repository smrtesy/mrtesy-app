/**
 * smrtCRM event handler: contact.preference_changed (from smrtReach).
 *
 * smrtReach's public preferences page emits this rather than writing smrtCRM
 * tables directly (Reach-4 / CRM-6 + the no-cross-app-import rule). The chosen
 * email_frequency lives in CRM, the source of truth about the person. Choosing
 * 'none' also flips email_unsubscribed on; any other tier clears it (a re-opt-in).
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

const VALID = new Set(["all", "weekly", "monthly", "none"]);

export default async function onPreferenceChanged(event: PlatformEvent): Promise<void> {
  const contactId = event.entityId;
  const frequency = String(event.payload?.frequency ?? "");
  if (!contactId || !VALID.has(frequency)) return;

  const { error } = await db
    .from("smrtcrm_contacts")
    .update({ email_frequency: frequency, email_unsubscribed: frequency === "none" })
    .eq("org_id", event.orgId)
    .eq("id", contactId);

  if (error) {
    console.error("[smrtcrm.onPreferenceChanged]", error.message);
  }
}
