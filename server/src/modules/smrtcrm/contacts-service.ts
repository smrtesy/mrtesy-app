/**
 * smrtCRM — contacts service.
 *
 * Houses the normalization + dedup/upsert logic (CRM-3), ported from botsite
 * (`src/contacts/contactsModule.js`) and re-scoped from bot_id to org_id.
 *
 * Matching order on upsert: phone → email → insert. On a match we UPDATE with
 * COALESCE semantics (fill gaps, never overwrite an existing non-null value).
 *
 * Normalization is enforced BEFORE every comparison — this is the one real
 * improvement over botsite, which compared raw strings and so missed
 * "Foo@x.com" vs "foo@x.com" and "050-123" vs "+97250123". See the
 * merge-scenarios table in docs/smrtcrm-smrtreach-open-questions.md.
 */

import { db } from "../../db";
import type { ContactInput, UpsertResult } from "./types";

/** Lowercase + trim. Returns null for empty/blank input. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v.length ? v : null;
}

/**
 * Normalize a phone number to E.164 where we can infer it, defaulting to the
 * Israeli numbering plan (the primary tenant). Strips spaces, dashes, parens.
 *   050-123-4567  → +972501234567
 *   0501234567    → +972501234567
 *   972501234567  → +972501234567
 *   +972501234567 → +972501234567 (unchanged)
 * Anything we can't confidently normalize is returned digits-only with a
 * leading "+" preserved, so at least equal inputs normalize equally.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (hadPlus) return `+${digits}`;
  if (digits.startsWith("972")) return `+${digits}`;
  if (digits.startsWith("0")) return `+972${digits.slice(1)}`;
  // Unknown format — keep digits only (no country code we can trust).
  return digits;
}

/**
 * Upsert a contact within an org, deduplicating by phone-then-email.
 *
 * @returns the contact id and whether it was created or merged.
 */
export async function upsertContact(
  orgId: string,
  createdBy: string,
  input: ContactInput,
): Promise<UpsertResult> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);

  // 1. Match by phone, then by email (scoped to org).
  let existing: { id: string } | null = null;

  if (phone) {
    const { data } = await db
      .from("smrtcrm_contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("phone", phone)
      .maybeSingle();
    if (data) existing = data as { id: string };
  }

  if (!existing && email) {
    const { data } = await db
      .from("smrtcrm_contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("email", email)
      .maybeSingle();
    if (data) existing = data as { id: string };
  }

  // 2. Merge into the existing contact: fill gaps, never overwrite non-null.
  if (existing) {
    const { data: current, error: readErr } = await db
      .from("smrtcrm_contacts")
      .select("first_name, last_name, phone, email, notes, custom_fields")
      .eq("id", existing.id)
      .single();

    if (readErr) throw new Error(`upsertContact read: ${readErr.message}`);

    // Gap-fill phone/email only if the incoming value isn't already held by a
    // DIFFERENT contact in the org — otherwise the partial unique index would
    // reject the update. (Happens when we matched by phone on contact A but the
    // row's email belongs to contact B.) In that case we keep A as-is and leave
    // the conflicting value with its existing owner.
    let fillPhone = current.phone ?? phone;
    if (!current.phone && phone) {
      const { data: clash } = await db
        .from("smrtcrm_contacts")
        .select("id")
        .eq("org_id", orgId)
        .eq("phone", phone)
        .neq("id", existing.id)
        .maybeSingle();
      if (clash) fillPhone = current.phone ?? null;
    }

    let fillEmail = current.email ?? email;
    if (!current.email && email) {
      const { data: clash } = await db
        .from("smrtcrm_contacts")
        .select("id")
        .eq("org_id", orgId)
        .eq("email", email)
        .neq("id", existing.id)
        .maybeSingle();
      if (clash) fillEmail = current.email ?? null;
    }

    const merged = {
      first_name: current.first_name ?? input.first_name ?? null,
      last_name: current.last_name ?? input.last_name ?? null,
      phone: fillPhone,
      email: fillEmail,
      notes: current.notes ?? input.notes ?? null,
      custom_fields: {
        ...(input.custom_fields ?? {}),
        ...((current.custom_fields as Record<string, unknown>) ?? {}),
      },
    };

    const { error: updErr } = await db
      .from("smrtcrm_contacts")
      .update(merged)
      .eq("id", existing.id);

    if (updErr) throw new Error(`upsertContact update: ${updErr.message}`);
    return { id: existing.id, outcome: "merged" };
  }

  // 3. No match — insert a new contact.
  const { data: inserted, error: insErr } = await db
    .from("smrtcrm_contacts")
    .insert({
      org_id: orgId,
      created_by: createdBy,
      first_name: input.first_name ?? null,
      last_name: input.last_name ?? null,
      phone,
      email,
      notes: input.notes ?? null,
      custom_fields: input.custom_fields ?? {},
      source: input.source ?? "manual",
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`upsertContact insert: ${insErr.message}`);
  return { id: inserted.id as string, outcome: "created" };
}

/**
 * Ensure a tag exists for the org (by name), creating it if missing.
 * Used for project tags auto-derived from a bot and for CSV/API import tags.
 */
export async function ensureTag(
  orgId: string,
  name: string,
  opts: { kind?: "manual" | "project" | "source"; botRef?: string; createdBy?: string } = {},
): Promise<string> {
  const trimmed = name.trim();
  const { data: existing } = await db
    .from("smrtcrm_tags")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", trimmed)
    .maybeSingle();

  if (existing) return existing.id as string;

  const { data, error } = await db
    .from("smrtcrm_tags")
    .insert({
      org_id: orgId,
      name: trimmed,
      kind: opts.kind ?? "manual",
      bot_ref: opts.botRef ?? null,
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`ensureTag: ${error.message}`);
  return data.id as string;
}

/** Assign a tag to a contact (idempotent). */
export async function assignTag(orgId: string, contactId: string, tagId: string): Promise<void> {
  const { error } = await db
    .from("smrtcrm_tag_assignments")
    .upsert(
      { org_id: orgId, contact_id: contactId, tag_id: tagId },
      { onConflict: "contact_id,tag_id" },
    );
  if (error) throw new Error(`assignTag: ${error.message}`);
}
