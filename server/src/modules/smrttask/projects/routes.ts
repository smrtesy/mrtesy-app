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
 *
 *   GET    /projects/:id/info-items       list info items (?include_children=true)
 *   POST   /projects/:id/info-items       create info item
 *   PATCH  /projects/:id/info-items/:itemId  update info item
 *   DELETE /projects/:id/info-items/:itemId  delete info item
 *   POST   /projects/:id/info-items/:itemId/attachments  upload + attach file
 *   POST   /projects/:id/info-summary     build/refresh the AI board summary
 *   PATCH  /projects/:id/info-summary     manual summary edit
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireFullTask } from "../lib/access";
import { simpleCall } from "../../../anthropic";

const router = Router();

// Every project route requires auth + active org + smrtTask enabled for that org.
router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

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

// ── /projects/:id/info-items ─────────────────────────────────────────────────
// Manual notes/info saved against a project (the project Information Center).
// Rows carry source='manual' to distinguish them from router-captured info.

const INFO_ITEM_FIELDS =
  "id, project_id, title, body, attachments, source, created_at, updated_at";

interface ProjectRef {
  id: string;
  name: string;
  name_he: string | null;
  color: string | null;
}

/** GET /projects/:id/info-items?include_children=true
 *  Items newest-first; with include_children also items of direct sub-projects.
 *  Returns { items, projects } where projects maps project_id → {name, …} so the
 *  UI can render a sub-project chip on child items. */
router.get("/projects/:id/info-items", async (req: Request, res: Response) => {
  const { data: project, error: pErr } = await db
    .from("projects")
    .select("id, name, name_he, color")
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!project) return res.status(404).json({ error: "project not found in this org" });

  const projectsById: Record<string, ProjectRef> = { [project.id]: project as ProjectRef };
  const projectIds = [project.id as string];

  if (req.query.include_children === "true") {
    const { data: children, error: cErr } = await db
      .from("projects")
      .select("id, name, name_he, color")
      .eq("organization_id", req.org!.id)
      .eq("parent_id", req.params.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true });
    if (cErr) return res.status(500).json({ error: cErr.message });
    for (const child of (children ?? []) as ProjectRef[]) {
      projectsById[child.id] = child;
      projectIds.push(child.id);
    }
  }

  const { data: items, error } = await db
    .from("project_information_items")
    .select(INFO_ITEM_FIELDS)
    .eq("organization_id", req.org!.id)
    .in("project_id", projectIds)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ items: items ?? [], projects: projectsById });
});

/** POST /projects/:id/info-items  body: { title?, body? } — at least one required.
 *  Title is optional in the board UI; when omitted we derive it from the first
 *  line of the body (the column is NOT NULL). */
router.post("/projects/:id/info-items", async (req: Request, res: Response) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!title && !body) {
    return res.status(400).json({ error: "title or body is required" });
  }

  if (!await verifyProjectInOrg(req.params.id, req.org!.id)) {
    return res.status(404).json({ error: "project not found in this org" });
  }

  const finalTitle = title || body.split("\n")[0].trim();

  const { data, error } = await db
    .from("project_information_items")
    .insert({
      user_id: req.user!.id,
      organization_id: req.org!.id,
      project_id: req.params.id,
      title: finalTitle.slice(0, 200),
      body,
      source: "manual",
    })
    .select(INFO_ITEM_FIELDS)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ item: data });
});

/** PATCH /projects/:id/info-items/:itemId  body: { title?, body? } */
router.patch("/projects/:id/info-items/:itemId", async (req: Request, res: Response) => {
  if (!await verifyProjectInOrg(req.params.id, req.org!.id)) {
    return res.status(404).json({ error: "project not found in this org" });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof req.body?.title === "string" && req.body.title.trim()) {
    updates.title = req.body.title.trim().slice(0, 200);
  }
  if (typeof req.body?.body === "string") updates.body = req.body.body.trim();
  if (!("title" in updates) && !("body" in updates)) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("project_information_items")
    .update(updates)
    .eq("id", req.params.itemId)
    .eq("project_id", req.params.id)
    .eq("organization_id", req.org!.id)
    .select(INFO_ITEM_FIELDS)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "info item not found" });
  res.json({ item: data });
});

/** DELETE /projects/:id/info-items/:itemId */
router.delete("/projects/:id/info-items/:itemId", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("project_information_items")
    .delete({ count: "exact" })
    .eq("id", req.params.itemId)
    .eq("project_id", req.params.id)
    .eq("organization_id", req.org!.id);

  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "info item not found" });
  res.json({ ok: true });
});

interface InfoAttachment {
  id: string;
  filename: string;
  url: string;
  file_path: string;
  file_mime: string;
  file_size: number;
}

/** POST /projects/:id/info-items/:itemId/attachments
 *  Body: { filename: string, mime?: string, data: <base64-string> }
 *  Uploads to the task-materials bucket (same pattern as the task materials
 *  upload: ASCII-safe key, 7MB cap, 1-year signed URL), appends the attachment
 *  object to the item's attachments array, and returns { item }. */
router.post("/projects/:id/info-items/:itemId/attachments", async (req: Request, res: Response) => {
  const { filename, mime, data } = req.body ?? {};
  if (!filename || typeof filename !== "string") {
    return res.status(400).json({ error: "filename is required" });
  }
  if (!data || typeof data !== "string") {
    return res.status(400).json({ error: "data (base64) is required" });
  }

  // Confirm the item is in this org + project before we burn storage.
  const { data: item, error: iErr } = await db
    .from("project_information_items")
    .select("id, attachments")
    .eq("id", req.params.itemId)
    .eq("project_id", req.params.id)
    .eq("organization_id", req.org!.id)
    .maybeSingle();
  if (iErr)  return res.status(500).json({ error: iErr.message });
  if (!item) return res.status(404).json({ error: "info item not found" });

  const buf = Buffer.from(data, "base64");
  if (buf.length > 7 * 1024 * 1024) {
    return res.status(413).json({ error: "file too large (max 7MB)" });
  }

  // Supabase Storage keys must be ASCII — Hebrew filenames, spaces, and other
  // non-ASCII / unsafe characters trigger "Invalid key" and the upload fails.
  // Keep the original name for the user-facing filename, but build an
  // ASCII-safe slug for the storage path so the key is always valid.
  const displayName = filename.trim().slice(0, 200);
  const dot  = displayName.lastIndexOf(".");
  const ext  = dot > 0 ? displayName.slice(dot).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 20) : "";
  const stem = (dot > 0 ? displayName.slice(0, dot) : displayName)
    .replace(/[^\x20-\x7E]/g, "")        // drop non-ASCII (Hebrew, emoji, …)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")   // collapse remaining unsafe chars + spaces
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100);
  const safeName = (stem || "file") + ext;
  const path = `${req.org!.id}/info-items/${item.id}/${randomUUID()}-${safeName}`;
  const contentType = (typeof mime === "string" && mime) || "application/octet-stream";

  const { error: uploadErr } = await db.storage
    .from("task-materials")
    .upload(path, buf, { contentType, upsert: false });
  if (uploadErr) return res.status(500).json({ error: `storage upload: ${uploadErr.message}` });

  // 1-year signed URL — long enough that the UI doesn't refresh links on
  // every view, short enough that revocation is meaningful.
  const { data: signed, error: signErr } = await db.storage
    .from("task-materials")
    .createSignedUrl(path, 60 * 60 * 24 * 365);
  if (signErr) return res.status(500).json({ error: `sign url: ${signErr.message}` });

  const attachment: InfoAttachment = {
    id:        randomUUID(),
    filename:  displayName,
    url:       signed?.signedUrl ?? "",
    file_path: path,
    file_mime: contentType,
    file_size: buf.length,
  };
  const next = [...((item.attachments as InfoAttachment[] | null) ?? []), attachment];

  const { data: updated, error: uErr } = await db
    .from("project_information_items")
    .update({ attachments: next, updated_at: new Date().toISOString() })
    .eq("id", item.id)
    .eq("organization_id", req.org!.id)
    .select(INFO_ITEM_FIELDS)
    .single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  res.status(201).json({ item: updated });
});

// ── /projects/:id/info-summary ───────────────────────────────────────────────
// One pinned AI summary per project, overwritten on each rebuild/manual edit;
// the previous version is kept in info_summary_prev as a safety copy.

const INFO_SUMMARY_SYSTEM = `אתה מסכם "מרכז מידע" של פרויקט במערכת smrtTask.
תקבל את כל פריטי המידע של הפרויקט (ושל תתי-הפרויקטים שלו, אם יש) בסדר כרונולוגי.

כתוב סיכום קומפקטי ופרקטי בעברית של כל הלוח:
- עובדות מרכזיות, החלטות שהתקבלו, אנשי קשר, סכומים ותאריכים — בקצרה ולעניין.
- ארגן לפי נושאים, לא לפי פריטים. אל תחזור על אותו מידע פעמיים.
- אם פריט שייך לתת-פרויקט, ציין זאת רק כשזה מוסיף הקשר.

כללי קישורים — קריטי:
- שמור כל URL כלשונו, תו-בתו (VERBATIM) — כולל פרמטרים, query strings ו-fragments.
- לעולם אל תקצר קישור לדומיין שלו ואל תנסח אותו מחדש. אם בפריט מופיע
  https://site.com/products/foo?ref=bar — כך בדיוק הוא חייב להופיע בסיכום.
- אל תמציא קישורים שלא הופיעו בפריטים.

פלט: טקסט פשוט עם מרקדאון קל בלבד (**מודגש**, *נטוי*, [טקסט](קישור), שורות חדשות).
בלי כותרת פתיחה כללית, בלי הקדמות — ישר הסיכום.`;

/** Load a project + the info items of it and its direct sub-projects. */
async function loadProjectWithInfoItems(projectId: string, orgId: string) {
  const { data: project, error: pErr } = await db
    .from("projects")
    .select("id, name, name_he, info_summary")
    .eq("id", projectId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pErr) return { error: pErr.message, status: 500 as const };
  if (!project) return { error: "project not found in this org", status: 404 as const };

  const { data: children, error: cErr } = await db
    .from("projects")
    .select("id, name, name_he")
    .eq("organization_id", orgId)
    .eq("parent_id", projectId)
    .eq("is_active", true);
  if (cErr) return { error: cErr.message, status: 500 as const };

  const names: Record<string, string> = {};
  const ids = [project.id as string];
  for (const c of children ?? []) {
    names[c.id as string] = (c.name_he as string | null) || (c.name as string);
    ids.push(c.id as string);
  }

  const { data: items, error } = await db
    .from("project_information_items")
    .select("id, project_id, title, body, attachments, created_at")
    .eq("organization_id", orgId)
    .in("project_id", ids)
    .order("created_at", { ascending: true });
  if (error) return { error: error.message, status: 500 as const };

  return { project, items: items ?? [], childNames: names };
}

/** POST /projects/:id/info-summary — generate/refresh the AI summary. */
router.post("/projects/:id/info-summary", async (req: Request, res: Response) => {
  const loaded = await loadProjectWithInfoItems(req.params.id, req.org!.id);
  if ("error" in loaded) return res.status(loaded.status ?? 500).json({ error: loaded.error });
  const { project, items, childNames } = loaded;

  if (items.length === 0) {
    return res.status(400).json({ error: "no info items to summarize" });
  }

  const blocks = items.map((it) => {
    const sub = it.project_id && childNames[it.project_id as string]
      ? `\nתת-פרויקט: ${childNames[it.project_id as string]}`
      : "";
    const files = ((it.attachments as InfoAttachment[] | null) ?? [])
      .map((a) => `\nקובץ מצורף: ${a.filename}`)
      .join("");
    return `[${it.created_at}]${sub}\nכותרת: ${it.title}\n${(it.body as string) || ""}${files}`;
  });
  const projectName = (project.name_he as string | null) || (project.name as string);
  const userMessage =
    `פרויקט: ${projectName}\n\nפריטי המידע (מהישן לחדש):\n\n${blocks.join("\n\n---\n\n")}`;

  let summary: string;
  try {
    const { content } = await simpleCall(
      "sonnet",
      INFO_SUMMARY_SYSTEM,
      userMessage,
      2048,
      { component: "smrttask.infoSummary", userId: req.user!.id },
    );
    summary = content.trim();
  } catch (e) {
    return res.status(502).json({ error: `AI summary failed: ${(e as Error).message}` });
  }
  if (!summary) return res.status(502).json({ error: "AI returned an empty summary" });

  const now = new Date().toISOString();
  const { error: uErr } = await db
    .from("projects")
    .update({
      info_summary_prev: (project.info_summary as string | null) ?? null,
      info_summary: summary,
      info_summary_updated_at: now,
    })
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id);
  if (uErr) return res.status(500).json({ error: uErr.message });

  res.json({ summary, updated_at: now });
});

/** PATCH /projects/:id/info-summary  body: { summary } — manual edit. */
router.patch("/projects/:id/info-summary", async (req: Request, res: Response) => {
  const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
  if (!summary) return res.status(400).json({ error: "summary is required" });

  const { data: project, error: pErr } = await db
    .from("projects")
    .select("id, info_summary")
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!project) return res.status(404).json({ error: "project not found in this org" });

  const now = new Date().toISOString();
  const { error: uErr } = await db
    .from("projects")
    .update({
      info_summary_prev: (project.info_summary as string | null) ?? null,
      info_summary: summary,
      info_summary_updated_at: now,
    })
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id);
  if (uErr) return res.status(500).json({ error: uErr.message });

  res.json({ summary, updated_at: now });
});

export default router;
