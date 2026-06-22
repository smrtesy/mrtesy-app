/**
 * smrtCRM — Express routes.
 *
 * Every route requires the standard chain:
 *   requireAuth → requireOrg → requireApp("smrtcrm")
 *
 * Permissions (CRM-2): two roles (project_manager / user) are modeled at the
 * app-membership level, but enforcement is currently equal — everyone added to
 * the org can do everything here. The structure is ready to restrict later
 * (e.g. add requireRole on writes) without a migration.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { emitEvent, notifyError } from "../../lib/platform";

import {
  upsertContact,
  ensureTag,
  assignTag,
  normalizeEmail,
  normalizePhone,
} from "./contacts-service";
import type { ContactInput, ImportRow } from "./types";
import { parseSpreadsheetId, fetchSheetGrid } from "../../services/sheets";

const router = Router();

router.use(requireAuth, requireOrg, requireApp("smrtcrm"));

// ============================================================
// SHARED FILTERING
// ============================================================

/** The set of filters a contact list / bulk action can be scoped by. */
interface ContactFilter {
  q?: string;
  tag_id?: string | null;
  segment_id?: string | null;
  has_email?: boolean;
}

/**
 * A segment is a saved query (its `filter` JSONB mirrors ContactFilter), so
 * picking a segment is equivalent to applying its stored tag/has_email filter.
 * Returns the effective tag_id / has_email after folding the segment in.
 */
async function resolveSegment(
  orgId: string,
  f: ContactFilter,
): Promise<{ tagId: string | null; hasEmail: boolean }> {
  let tagId = f.tag_id ?? null;
  let hasEmail = f.has_email ?? false;
  if (f.segment_id) {
    const { data, error } = await db
      .from("smrtcrm_segments")
      .select("filter")
      .eq("org_id", orgId)
      .eq("id", f.segment_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const seg = (data?.filter ?? {}) as { tag_id?: string; has_email?: boolean };
    if (seg.tag_id) tagId = seg.tag_id;
    if (seg.has_email) hasEmail = true;
  }
  return { tagId, hasEmail };
}

/**
 * Resolve a filter to the full set of matching contact ids (no pagination).
 * Used by "select all matching the filter" bulk actions so the client never
 * has to enumerate thousands of ids itself.
 */
async function matchingContactIds(orgId: string, f: ContactFilter): Promise<string[]> {
  const { tagId, hasEmail } = await resolveSegment(orgId, f);

  // Mirror the GET /crm/contacts restrict logic so "select all matching" can
  // never target a wider set than the list the user is looking at.
  let restrictIds: string[] | null = null;
  if (tagId) {
    const { data, error } = await db
      .from("smrtcrm_tag_assignments")
      .select("contact_id")
      .eq("org_id", orgId)
      .eq("tag_id", tagId);
    if (error) throw new Error(error.message);
    restrictIds = (data ?? []).map((r) => r.contact_id as string);
    if (restrictIds.length === 0) return [];
  }

  let query = db.from("smrtcrm_contacts").select("id").eq("org_id", orgId);
  if (restrictIds) query = query.in("id", restrictIds);
  if (hasEmail) query = query.not("email", "is", null);
  if (f.q) {
    const safe = f.q.replace(/[,()*\\]/g, " ");
    const like = `%${safe}%`;
    query = query.or(
      `first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},email.ilike.${like}`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id as string);
}

/** Split a large id list so a single PostgREST request never blows the URL/IN limit. */
function chunk<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ============================================================
// CONTACTS
// ============================================================

// GET /crm/contacts?q=&tag_id=&segment_id=&has_email=&limit=&offset=
router.get("/crm/contacts", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const segmentId = typeof req.query.segment_id === "string" ? req.query.segment_id : null;

  // A segment is a saved filter — fold its tag/has_email into the live filter.
  let tagId: string | null;
  let hasEmail: boolean;
  try {
    ({ tagId, hasEmail } = await resolveSegment(orgId, {
      tag_id: typeof req.query.tag_id === "string" ? req.query.tag_id : null,
      segment_id: segmentId,
      has_email: req.query.has_email === "true",
    }));
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  // Resolve the id set for the tag filter first (cheap, indexed).
  let restrictIds: string[] | null = null;
  if (tagId) {
    const { data, error } = await db
      .from("smrtcrm_tag_assignments")
      .select("contact_id")
      .eq("org_id", orgId)
      .eq("tag_id", tagId);
    if (error) return res.status(500).json({ error: error.message });
    restrictIds = (data ?? []).map((r) => r.contact_id as string);
  }

  // An empty restrict set means "no matches" — short-circuit.
  if (restrictIds && restrictIds.length === 0) {
    return res.json({ contacts: [], total: 0 });
  }

  let query = db
    .from("smrtcrm_contacts")
    .select("*", { count: "exact" })
    .eq("org_id", orgId);

  if (restrictIds) query = query.in("id", restrictIds);
  if (hasEmail) query = query.not("email", "is", null);
  if (q) {
    // PostgREST splits the .or() string on commas and treats ()/* as syntax,
    // so neutralize those separators in the user-supplied term first.
    const safe = q.replace(/[,()*\\]/g, " ");
    const like = `%${safe}%`;
    query = query.or(
      `first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},email.ilike.${like}`,
    );
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    await notifyError(orgId, "smrtcrm", { title: "Failed to list contacts", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.json({ contacts: data ?? [], total: count ?? 0 });
});

// POST /crm/contacts  — create (or merge) a single contact, optionally tagged.
router.post("/crm/contacts", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = (req.body ?? {}) as ContactInput & { tag_id?: string };

  if (!body.phone && !body.email && !body.first_name?.trim()) {
    return res.status(400).json({ error: "at least one of phone, email or first_name is required" });
  }

  try {
    const result = await upsertContact(orgId, req.user!.id, { ...body, source: body.source ?? "manual" });
    if (body.tag_id) await assignTag(orgId, result.id, body.tag_id);

    await emitEvent(
      orgId,
      "smrtcrm",
      result.outcome === "created" ? "contact.created" : "contact.merged",
      "contact",
      result.id,
      { source: body.source ?? "manual" },
    );

    const { data } = await db.from("smrtcrm_contacts").select("*").eq("id", result.id).single();
    res.status(result.outcome === "created" ? 201 : 200).json({ contact: data, outcome: result.outcome });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtcrm", { title: "Failed to create contact", body: msg });
    res.status(500).json({ error: msg });
  }
});

// PATCH /crm/contacts/:id  — direct field update (no dedup; explicit edit).
router.patch("/crm/contacts/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = (req.body ?? {}) as ContactInput;

  const patch: Record<string, unknown> = {};
  if (body.first_name !== undefined) patch.first_name = body.first_name?.trim() || null;
  if (body.last_name !== undefined) patch.last_name = body.last_name?.trim() || null;
  if (body.phone !== undefined) patch.phone = normalizePhone(body.phone);
  if (body.email !== undefined) patch.email = normalizeEmail(body.email);
  if (body.notes !== undefined) patch.notes = body.notes ?? null;
  if (body.custom_fields !== undefined) patch.custom_fields = body.custom_fields ?? {};

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "no updatable fields provided" });
  }

  const { data, error } = await db
    .from("smrtcrm_contacts")
    .update(patch)
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    await notifyError(orgId, "smrtcrm", { title: "Failed to update contact", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "contact not found" });

  await emitEvent(orgId, "smrtcrm", "contact.updated", "contact", req.params.id, {});
  res.json({ contact: data });
});

// DELETE /crm/contacts/:id
router.delete("/crm/contacts/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { error } = await db
    .from("smrtcrm_contacts")
    .delete()
    .eq("org_id", orgId)
    .eq("id", req.params.id);

  if (error) {
    await notifyError(orgId, "smrtcrm", { title: "Failed to delete contact", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  await emitEvent(orgId, "smrtcrm", "contact.deleted", "contact", req.params.id, {});
  res.json({ ok: true });
});

// POST /crm/contacts/bulk
//   { action, contact_ids[], tag_id? }                         — explicit ids
//   { action, filter: {q,tag_id,segment_id,has_email}, ... }   — "select all matching"
// `filter` is resolved to the full matching id set server-side, so the client
// never has to enumerate ids when the user picks "select all by the filter".
router.post("/crm/contacts/bulk", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { action, contact_ids, tag_id, filter } = (req.body ?? {}) as {
    action?: string;
    contact_ids?: string[];
    tag_id?: string;
    filter?: ContactFilter;
  };

  try {
    let ids: string[];
    if (Array.isArray(contact_ids) && contact_ids.length > 0) {
      ids = contact_ids;
    } else if (filter) {
      ids = await matchingContactIds(orgId, filter);
    } else {
      return res
        .status(400)
        .json({ error: "a non-empty contact_ids array or a filter is required" });
    }

    if (!action) return res.status(400).json({ error: "action is required" });
    if (ids.length === 0) return res.json({ ok: true, affected: 0 });

    if (action === "add_tag") {
      if (!tag_id) return res.status(400).json({ error: "tag_id is required for add_tag" });
      for (const batch of chunk(ids)) {
        const rows = batch.map((cid) => ({ org_id: orgId, contact_id: cid, tag_id }));
        const { error } = await db
          .from("smrtcrm_tag_assignments")
          .upsert(rows, { onConflict: "contact_id,tag_id" });
        if (error) throw new Error(error.message);
      }
    } else if (action === "remove_tag") {
      if (!tag_id) return res.status(400).json({ error: "tag_id is required for remove_tag" });
      for (const batch of chunk(ids)) {
        const { error } = await db
          .from("smrtcrm_tag_assignments")
          .delete()
          .eq("org_id", orgId)
          .eq("tag_id", tag_id)
          .in("contact_id", batch);
        if (error) throw new Error(error.message);
      }
    } else if (action === "delete") {
      for (const batch of chunk(ids)) {
        const { error } = await db
          .from("smrtcrm_contacts")
          .delete()
          .eq("org_id", orgId)
          .in("id", batch);
        if (error) throw new Error(error.message);
      }
    } else {
      return res.status(400).json({ error: `unknown action: ${action}` });
    }
    res.json({ ok: true, affected: ids.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtcrm", { title: "Bulk action failed", body: msg });
    res.status(500).json({ error: msg });
  }
});

// ============================================================
// TAGS
// ============================================================

router.get("/crm/tags", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtcrm_tags")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tags: data ?? [] });
});

router.post("/crm/tags", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });

  try {
    const id = await ensureTag(orgId, name, { kind: "manual", createdBy: req.user!.id });
    await emitEvent(orgId, "smrtcrm", "tag.created", "tag", id, { name });
    const { data } = await db.from("smrtcrm_tags").select("*").eq("id", id).single();
    res.status(201).json({ tag: data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtcrm", { title: "Failed to create tag", body: msg });
    res.status(500).json({ error: msg });
  }
});

router.delete("/crm/tags/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtcrm_tags")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// SEGMENTS (saved dynamic queries — CRM-1; read by smrtReach as audiences)
// ============================================================

router.get("/crm/segments", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtcrm_segments")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ segments: data ?? [] });
});

router.post("/crm/segments", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });

  const { data, error } = await db
    .from("smrtcrm_segments")
    .insert({ org_id: orgId, created_by: req.user!.id, name, filter: req.body?.filter ?? {} })
    .select("*")
    .single();

  if (error) {
    await notifyError(orgId, "smrtcrm", { title: "Failed to create segment", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  await emitEvent(orgId, "smrtcrm", "segment.created", "segment", data.id, { name });
  res.status(201).json({ segment: data });
});

// ============================================================
// CSV IMPORT
// ============================================================
// The frontend parses the CSV and posts the mapped rows here, plus an optional
// tag to apply to every row. Each row goes through upsertContact, so the
// dedup logic (CRM-3) handles duplicates automatically.

router.post("/crm/import", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { rows, tag_id } = (req.body ?? {}) as {
    rows?: ImportRow[];
    tag_id?: string;
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "a non-empty rows array is required" });
  }
  if (rows.length > 10000) {
    return res.status(400).json({ error: "import is limited to 10,000 rows per request" });
  }

  let created = 0;
  let merged = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.phone && !row.email && !row.first_name) {
      skipped++;
      continue;
    }
    try {
      const result = await upsertContact(orgId, req.user!.id, { ...row, source: "csv" });
      if (result.outcome === "created") created++;
      else merged++;
      if (tag_id) await assignTag(orgId, result.id, tag_id);
    } catch (e) {
      skipped++;
      if (errors.length < 20) errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  await emitEvent(orgId, "smrtcrm", "import.completed", "import", orgId, { created, merged, skipped });
  res.json({ created, merged, skipped, errors });
});

// Google Sheets import — fetch the grid and return headers + rows so the
// client can reuse the exact same column-mapping UI as the CSV flow and post
// the mapped rows to POST /crm/import. We deliberately only read the sheet
// here; all dedup/tagging stays in the shared import path.
router.post("/crm/import/sheet", async (req: Request, res: Response) => {
  const { url, range } = (req.body ?? {}) as { url?: string; range?: string };
  const spreadsheetId = parseSpreadsheetId(url ?? "");
  if (!spreadsheetId) {
    return res.status(400).json({ error: "invalid_sheet_url" });
  }

  try {
    const grid = await fetchSheetGrid(req.user!.id, spreadsheetId, range);
    const nonEmpty = grid.filter((r) => r.some((c) => c.trim() !== ""));
    if (nonEmpty.length < 2) {
      return res.status(400).json({ error: "sheet_no_data" });
    }
    const headers = nonEmpty[0];
    const rows = nonEmpty.slice(1, 10001); // cap to the import limit
    res.json({ headers, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/No credentials found/i.test(msg)) {
      return res.status(400).json({ error: "google_not_connected" });
    }
    if (/insufficient|insufficientPermissions|forbidden|\b403\b|PERMISSION_DENIED|invalid authentication|invalid_grant/i.test(msg)) {
      return res.status(400).json({ error: "sheet_access_denied" });
    }
    if (/not found|\b404\b/i.test(msg)) {
      return res.status(400).json({ error: "sheet_not_found" });
    }
    return res.status(500).json({ error: msg });
  }
});

// ============================================================
// API CONNECTIONS (CRM-1: inbound API; contacts are auto-tagged)
// ============================================================

router.get("/crm/connections", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtcrm_api_connections")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ connections: data ?? [] });
});

router.post("/crm/connections", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });

  // Optional tag to auto-apply; if a tag name is given, ensure it exists.
  let tagId: string | null = null;
  if (typeof req.body?.tag_name === "string" && req.body.tag_name.trim()) {
    try {
      tagId = await ensureTag(orgId, req.body.tag_name.trim(), { kind: "source", createdBy: req.user!.id });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  } else if (typeof req.body?.tag_id === "string") {
    tagId = req.body.tag_id;
  }

  const token = randomBytes(24).toString("hex");
  const { data, error } = await db
    .from("smrtcrm_api_connections")
    .insert({ org_id: orgId, created_by: req.user!.id, name, tag_id: tagId, token })
    .select("*")
    .single();
  if (error) {
    await notifyError(orgId, "smrtcrm", { title: "Failed to create connection", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ connection: data });
});

router.delete("/crm/connections/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtcrm_api_connections")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
