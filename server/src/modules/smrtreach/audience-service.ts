/**
 * smrtReach — audience resolution.
 *
 * Resolves a campaign's audience (a reference to a smrtCRM segment / tag /
 * "all") into a concrete recipient list. This is the cross-app READ
 * declared in the manifest (entities.reads). It uses the org-scoped db client
 * directly — no code is imported from smrtCRM, honoring the platform's
 * no-cross-app-import rule.
 *
 * Channel-aware deliverability:
 *   - email   → require a non-null email AND email_unsubscribed = false
 *   - whatsapp → require a non-null phone
 */

import { db } from "../../db";

export type Channel = "whatsapp" | "email" | "both";

export interface AudienceRef {
  kind: "all" | "segment" | "tag";
  id?: string;
}

export interface SegmentFilter {
  tag_id?: string;
  has_email?: boolean;
  source?: string;
}

export interface Recipient {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
}

/** Look up the contact ids belonging to a tag (org-scoped). */
async function contactIdsForTag(orgId: string, tagId: string): Promise<string[]> {
  const { data, error } = await db
    .from("smrtcrm_tag_assignments")
    .select("contact_id")
    .eq("org_id", orgId)
    .eq("tag_id", tagId);
  if (error) throw new Error(`audience tag lookup: ${error.message}`);
  return (data ?? []).map((r) => r.contact_id as string);
}

/**
 * Resolve an audience reference into recipients, filtered for the channel's
 * deliverability requirements.
 */
export async function resolveAudience(
  orgId: string,
  audience: AudienceRef,
  channel: Channel,
): Promise<Recipient[]> {
  // 1. Determine the candidate contact id set (null = "all contacts in org").
  let restrictIds: string[] | null = null;

  if (audience.kind === "tag" && audience.id) {
    restrictIds = await contactIdsForTag(orgId, audience.id);
  } else if (audience.kind === "segment" && audience.id) {
    const { data: seg, error } = await db
      .from("smrtcrm_segments")
      .select("filter")
      .eq("org_id", orgId)
      .eq("id", audience.id)
      .maybeSingle();
    if (error) throw new Error(`audience segment lookup: ${error.message}`);
    const filter = (seg?.filter ?? {}) as SegmentFilter;

    // Intersect the tag id set declared in the segment filter.
    if (filter.tag_id) {
      restrictIds = await contactIdsForTag(orgId, filter.tag_id);
    }
    // has_email / source are applied as column filters below via the segment.
    if (restrictIds && restrictIds.length === 0) return [];

    return queryContacts(orgId, restrictIds, channel, {
      hasEmail: filter.has_email,
      source: filter.source,
    });
  }

  if (restrictIds && restrictIds.length === 0) return [];
  return queryContacts(orgId, restrictIds, channel, {});
}

async function queryContacts(
  orgId: string,
  restrictIds: string[] | null,
  channel: Channel,
  extra: { hasEmail?: boolean; source?: string },
): Promise<Recipient[]> {
  let query = db
    .from("smrtcrm_contacts")
    .select("id, first_name, last_name, phone, email")
    .eq("org_id", orgId);

  if (restrictIds) query = query.in("id", restrictIds);

  // Deliverability per channel.
  if (channel === "email") {
    query = query.not("email", "is", null).eq("email_unsubscribed", false);
  } else if (channel === "whatsapp") {
    query = query.not("phone", "is", null);
  } else {
    // "both" — needs at least one reachable channel; we keep all and let the
    // per-channel queue build skip unreachable rows.
  }

  if (extra.hasEmail) query = query.not("email", "is", null);
  if (extra.source) query = query.eq("source", extra.source);

  const { data, error } = await query;
  if (error) throw new Error(`audience contacts query: ${error.message}`);

  return (data ?? []).map((c) => ({
    contact_id: c.id as string,
    first_name: (c.first_name as string | null) ?? null,
    last_name: (c.last_name as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    email: (c.email as string | null) ?? null,
  }));
}
