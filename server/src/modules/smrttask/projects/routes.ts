/**
 * Project routes — base module (no AI required).
 * All scoped to active org via X-Org-Id header.
 *
 *   GET    /projects                      list active projects
 *   GET    /projects/:id                  single project + brief
 *   POST   /projects                      create
 *   PATCH  /projects/:id                  update (name, color, keywords, contacts, is_active)
 *   DELETE /projects/:id                  soft-delete (sets is_active = false)
 *
 *   GET    /projects/:id/brief            get project brief
 *   PUT    /projects/:id/brief            upsert brief (create or update)
 *   PATCH  /projects/:id/brief/verify-fact  approve/reject a single pending fact
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";

const router = Router();

// Every project route requires auth + active org + smrtTask enabled for that org.
router.use(requireAuth, requireOrg, requireApp("smrttask"));

const UPDATABLE_PROJECT_FIELDS = new Set([
  "name", "name_he", "color", "keywords", "key_contacts",
  "template_type", "is_active", "parent_id",
  "gmail_label_id", "gcal_calendar_id",
]);

const UPDATABLE_BRIEF_FIELDS = new Set([
  "purpose", "target_audience", "current_status", "ai_context",
  "kpis", "sub_projects", "weekly_workflow", "systems",
  "important_links", "drive_folder_id",
]);

function pick(body: Record<string, unknown>, allowed: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (allowed.has(k)) out[k] = body[k];
  return out;
}

// ── /projects ──────────────────────────────────────────────────────────────

/** GET /projects?include_brief=true */
router.get("/projects", async (req: Request, res: Response) => {
  const includeBrief = req.query.include_brief === "true";
  const select = includeBrief
    ? "*, project_briefs(id, purpose, current_status)"
    : "*";

  const { data, error } = await db
    .from("projects")
    .select(select)
    .eq("organization_id", req.org!.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ projects: data ?? [] });
});

/** GET /projects/:id  — full project with brief */
router.get("/projects/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("projects")
    .select("*, project_briefs(*)")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "project not found" });
  res.json({ project: data });
});

/** POST /projects */
router.post("/projects", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.name || typeof body.name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const payload = {
    user_id: req.user!.id,
    organization_id: req.org!.id,
    template_type: "personal",
    is_active: true,
    ...pick(body, UPDATABLE_PROJECT_FIELDS),
  };

  const { data, error } = await db
    .from("projects")
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ project: data });
});

/** PATCH /projects/:id */
router.patch("/projects/:id", async (req: Request, res: Response) => {
  const updates = pick(req.body ?? {}, UPDATABLE_PROJECT_FIELDS);
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("projects")
    .update(updates)
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "project not found in this org" });
  res.json({ project: data });
});

/** DELETE /projects/:id — soft delete */
router.delete("/projects/:id", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("projects")
    .update({ is_active: false }, { count: "exact" })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "project not found in this org" });
  res.json({ ok: true });
});

// ── /projects/:id/brief ────────────────────────────────────────────────────

/** Verify the project belongs to active org — used by every brief route. */
async function verifyProjectInOrg(projectId: string, orgId: string): Promise<boolean> {
  const { data } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return !!data;
}

/** GET /projects/:id/brief */
router.get("/projects/:id/brief", async (req: Request, res: Response) => {
  if (!await verifyProjectInOrg(req.params.id, req.org!.id)) {
    return res.status(404).json({ error: "project not found in this org" });
  }
  const { data, error } = await db
    .from("project_briefs")
    .select("*")
    .eq("project_id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ brief: data });
});

/** PUT /projects/:id/brief — upsert */
router.put("/projects/:id/brief", async (req: Request, res: Response) => {
  if (!await verifyProjectInOrg(req.params.id, req.org!.id)) {
    return res.status(404).json({ error: "project not found in this org" });
  }

  const updates = pick(req.body ?? {}, UPDATABLE_BRIEF_FIELDS);

  const { data: existing } = await db
    .from("project_briefs")
    .select("id")
    .eq("project_id", req.params.id)
    .maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from("project_briefs")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ brief: data });
  }

  // Create new — only if there's something to write
  if (Object.keys(updates).length === 0) {
    return res.json({ brief: null });
  }

  const { data, error } = await db
    .from("project_briefs")
    .insert({
      project_id: req.params.id,
      user_id: req.user!.id,
      ...updates,
    })
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ brief: data });
});

interface PendingFact {
  id: string;
  type: "contact" | "keyword" | "timeline" | "link" | "topic" | "note";
  value: string;
  extracted_at: string;
}

/** PATCH /projects/:id/brief/verify-fact  body: { fact_id, approve: boolean } */
router.patch("/projects/:id/brief/verify-fact",
  async (req: Request, res: Response) => {
    const { fact_id, approve } = req.body ?? {};
    if (!fact_id || typeof approve !== "boolean") {
      return res.status(400).json({ error: "fact_id and approve required" });
    }
    if (!await verifyProjectInOrg(req.params.id, req.org!.id)) {
      return res.status(404).json({ error: "project not found in this org" });
    }

    // Load current facts arrays
    const { data: brief } = await db
      .from("project_briefs")
      .select("id, pending_facts, verified_facts, rejected_facts")
      .eq("project_id", req.params.id)
      .maybeSingle();

    if (!brief) return res.status(404).json({ error: "brief not found" });

    const pending  = (brief.pending_facts as PendingFact[] | null) ?? [];
    const verified = (brief.verified_facts as PendingFact[] | null) ?? [];
    const rejected = (brief.rejected_facts as PendingFact[] | null) ?? [];

    const fact = pending.find((f) => f.id === fact_id);
    if (!fact) return res.status(404).json({ error: "fact not in pending list" });

    const remaining   = pending.filter((f) => f.id !== fact_id);
    const newVerified = approve ? [...verified, fact] : verified;
    const newRejected = approve ? rejected : [...rejected, fact];

    // Write brief update
    const { error: briefErr } = await db
      .from("project_briefs")
      .update({
        pending_facts: remaining,
        verified_facts: newVerified,
        rejected_facts: newRejected,
      })
      .eq("id", brief.id);
    if (briefErr) return res.status(500).json({ error: briefErr.message });

    // If approving a keyword or contact, also append to project's arrays
    if (approve && (fact.type === "keyword" || fact.type === "contact")) {
      const col = fact.type === "keyword" ? "keywords" : "key_contacts";
      const { data: proj } = await db
        .from("projects")
        .select(col)
        .eq("id", req.params.id)
        .single();
      const list = (((proj as Record<string, unknown> | null)?.[col] as string[] | null) ?? []);
      if (!list.includes(fact.value)) {
        const { error: arrErr } = await db
          .from("projects")
          .update({ [col]: [...list, fact.value] })
          .eq("id", req.params.id);
        if (arrErr) console.error("[verify-fact] array update error:", arrErr.message);
      }
    }

    res.json({ ok: true, action: approve ? "approved" : "rejected" });
  },
);

export default router;
