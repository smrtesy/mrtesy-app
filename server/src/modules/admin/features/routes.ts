/**
 * Admin: feature-channels routes (docs/feature-channels-plan.md, step 4).
 * All gated by requireAuth + requireSuperAdmin.
 *
 *   GET   /admin/features              list every registered feature (STRUCTURE
 *                                      from the registry) crossed with its
 *                                      feature_channels STATE row — schema
 *                                      defaults where no row exists yet.
 *   PATCH /admin/features/:featureId   upsert-by-feature_id on feature_channels;
 *                                      per-field validation; last_changed_at=now().
 *
 * STRUCTURE lives in code (server/src/lib/feature-registry.ts, a twin of the
 * frontend src/lib/feature-registry.ts); STATE lives in the feature_channels
 * table. The GET is the join. Zero AI at read time.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";
import { FEATURE_REGISTRY, FEATURE_BY_ID } from "../../../lib/feature-registry";

const router = Router();
// Path-scoped to "/admin" ON PURPOSE — this router is mounted with
// app.use("/api", adminRouter), so a BARE router.use() gate would run for EVERY
// /api request that falls through (see .claude/rules/server-routing.md).
router.use("/admin", requireAuth, requireSuperAdmin);

/** The columns the feature_channels table carries, mirrored so the merge below
 *  can fall back to the schema defaults for a feature that has no row yet. */
interface FeatureChannelRow {
  feature_id: string;
  screen_key: string;
  title: string;
  title_he: string | null;
  stable_enabled: boolean;
  beta_enabled: boolean;
  stable_version: string;
  beta_version: string;
  intent: "fork" | "migrate";
  promote_by: string | null;
  notes_url: string | null;
  last_changed_at: string | null;
  created_at: string | null;
}

/** GET /admin/features */
router.get("/admin/features", async (_req: Request, res: Response) => {
  const { data: rows, error } = await db
    .from("feature_channels")
    .select("*");
  if (error) return res.status(500).json({ error: error.message });

  const byId = new Map<string, FeatureChannelRow>();
  for (const r of (rows ?? []) as FeatureChannelRow[]) byId.set(r.feature_id, r);

  // Walk the REGISTRY (structure is the spine): every registered feature shows,
  // with its DB state row merged in, or the schema defaults when there is none.
  const features = FEATURE_REGISTRY.map((f) => {
    const row = byId.get(f.featureId);
    return {
      feature_id: f.featureId,
      screen_key: f.screenKey,
      title: f.title,
      title_he: f.titleHe ?? null,
      code_ref: f.codeRef,
      has_versions: Boolean(f.hasVersions),
      // STATE — the row if present, else the feature_channels column defaults.
      stable_enabled: row?.stable_enabled ?? false,
      beta_enabled:   row?.beta_enabled   ?? true,
      stable_version: row?.stable_version ?? "v1",
      beta_version:   row?.beta_version   ?? "v1",
      intent:         row?.intent         ?? f.intent,
      promote_by:     row?.promote_by     ?? null,
      notes_url:      row?.notes_url       ?? null,
      last_changed_at: row?.last_changed_at ?? null,
      created_at:      row?.created_at      ?? null,
      has_row: Boolean(row),
    };
  });

  res.json({ features });
});

/** YYYY-MM-DD, the shape the `date` column round-trips. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PATCH /admin/features/:featureId
 *  body: any subset of { stable_enabled, beta_enabled, stable_version,
 *  beta_version, intent, promote_by, notes_url }. Upsert on feature_id. */
router.patch("/admin/features/:featureId", async (req: Request, res: Response) => {
  const { featureId } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  if ("stable_enabled" in body) {
    if (typeof body.stable_enabled !== "boolean") {
      return res.status(400).json({ error: "stable_enabled must be a boolean" });
    }
    updates.stable_enabled = body.stable_enabled;
  }
  if ("beta_enabled" in body) {
    if (typeof body.beta_enabled !== "boolean") {
      return res.status(400).json({ error: "beta_enabled must be a boolean" });
    }
    updates.beta_enabled = body.beta_enabled;
  }
  if ("stable_version" in body) {
    if (typeof body.stable_version !== "string" || !body.stable_version.trim()) {
      return res.status(400).json({ error: "stable_version must be a non-empty string" });
    }
    updates.stable_version = body.stable_version.trim();
  }
  if ("beta_version" in body) {
    if (typeof body.beta_version !== "string" || !body.beta_version.trim()) {
      return res.status(400).json({ error: "beta_version must be a non-empty string" });
    }
    updates.beta_version = body.beta_version.trim();
  }
  if ("intent" in body) {
    if (body.intent !== "fork" && body.intent !== "migrate") {
      return res.status(400).json({ error: "intent must be 'fork' or 'migrate'" });
    }
    updates.intent = body.intent;
  }
  if ("promote_by" in body) {
    if (body.promote_by === null || body.promote_by === "") {
      updates.promote_by = null;
    } else if (typeof body.promote_by === "string" && DATE_RE.test(body.promote_by)) {
      updates.promote_by = body.promote_by;
    } else {
      return res.status(400).json({ error: "promote_by must be a YYYY-MM-DD date or null" });
    }
  }
  if ("notes_url" in body) {
    if (body.notes_url === null || body.notes_url === "") {
      updates.notes_url = null;
    } else if (typeof body.notes_url === "string") {
      updates.notes_url = body.notes_url.trim() || null;
    } else {
      return res.status(400).json({ error: "notes_url must be a string or null" });
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  updates.last_changed_at = new Date().toISOString();

  // Does the row already exist? FAIL CLOSED — a failed read must not be treated
  // as "no row" and send us down the insert branch (which would reset intent to
  // the schema default and stomp the user's STATE with registry values).
  const { data: existing, error: readErr } = await db
    .from("feature_channels")
    .select("feature_id")
    .eq("feature_id", featureId)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });

  if (existing) {
    // Update ONLY the validated fields — never re-send identity/intent, so an
    // unrelated toggle can't clobber a user-set version/intent.
    const { data, error } = await db
      .from("feature_channels")
      .update(updates)
      .eq("feature_id", featureId)
      .select("*")
      .single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ feature: data });
  }

  // First write: fill the NOT NULL identity columns + intent from an explicit
  // body override, else the code-owned registry (structure lives in code).
  const reg = FEATURE_BY_ID[featureId];
  const screenKey =
    typeof body.screen_key === "string" && body.screen_key.trim()
      ? body.screen_key.trim()
      : reg?.screenKey;
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : reg?.title;
  const titleHe =
    typeof body.title_he === "string"
      ? body.title_he.trim() || null
      : (reg?.titleHe ?? null);

  if (!screenKey || !title) {
    return res.status(400).json({
      error: `feature '${featureId}' is not in the registry; screen_key and title are required to create its row`,
    });
  }

  // Seed intent from the registry on insert unless the caller set it explicitly.
  if (!("intent" in updates) && reg) updates.intent = reg.intent;

  const { data, error } = await db
    .from("feature_channels")
    .insert({
      feature_id: featureId,
      screen_key: screenKey,
      title,
      title_he: titleHe,
      ...updates,
    })
    .select("*")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ feature: data });
});

export default router;
