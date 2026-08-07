/**
 * Admin: feature-channels routes (docs/feature-channels-plan.md, step 4).
 * All gated by requireAuth + requireSuperAdmin.
 *
 *   GET   /admin/features              list every registered feature (STRUCTURE
 *                                      from the registry — incl. its version
 *                                      list) crossed with its feature_channels
 *                                      STATE row — schema defaults where no row
 *                                      exists yet.
 *   PATCH /admin/features/:featureId   upsert-by-feature_id on feature_channels;
 *                                      per-field validation; last_changed_at=now().
 *
 * STRUCTURE lives in code (server/src/lib/feature-registry.ts, a twin of the
 * frontend src/lib/feature-registry.ts) — including the VERSION list that feeds
 * the picker and the history drawer. STATE lives in the feature_channels table:
 * per-channel enabled + which version + the human note. The GET is the join.
 * Zero AI at read time.
 *
 * Managed entirely by version (Chanoch, 2026-08-07): no intent/promote_by/
 * notes_url — those columns still exist in the table but are unused here.
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

/** The feature_channels columns this endpoint reads/writes. The legacy
 *  intent/promote_by/notes_url columns still exist in the table but are no
 *  longer surfaced — the card is managed by version alone. */
interface FeatureChannelRow {
  feature_id: string;
  screen_key: string;
  title: string;
  title_he: string | null;
  stable_enabled: boolean;
  beta_enabled: boolean;
  stable_version: string;
  beta_version: string;
  note: string | null;
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
    const versions = f.versions ?? [];
    return {
      feature_id: f.featureId,
      screen_key: f.screenKey,
      title: f.title,
      title_he: f.titleHe ?? null,
      code_ref: f.codeRef,
      // STRUCTURE — version list (picker options + history drawer).
      versions,
      // STATE — the row if present, else the feature_channels column defaults.
      stable_enabled: row?.stable_enabled ?? false,
      beta_enabled:   row?.beta_enabled   ?? true,
      stable_version: row?.stable_version ?? (versions[0]?.version ?? "v1"),
      beta_version:   row?.beta_version   ?? (versions[versions.length - 1]?.version ?? "v1"),
      note:           row?.note           ?? null,
      last_changed_at: row?.last_changed_at ?? null,
      created_at:      row?.created_at      ?? null,
      has_row: Boolean(row),
    };
  });

  res.json({ features });
});

/** PATCH /admin/features/:featureId
 *  body: any subset of { stable_enabled, beta_enabled, stable_version,
 *  beta_version, note }. Upsert on feature_id. */
router.patch("/admin/features/:featureId", async (req: Request, res: Response) => {
  const { featureId } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  // A version write must name a version the feature actually offers — guard
  // against a stale client sending a version the registry no longer lists.
  const reg = FEATURE_BY_ID[featureId];
  const allowedVersions = (reg?.versions ?? []).map((v) => v.version);

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
    const v = body.stable_version.trim();
    if (allowedVersions.length && !allowedVersions.includes(v)) {
      return res.status(400).json({ error: `stable_version '${v}' is not a registered version of '${featureId}'` });
    }
    updates.stable_version = v;
  }
  if ("beta_version" in body) {
    if (typeof body.beta_version !== "string" || !body.beta_version.trim()) {
      return res.status(400).json({ error: "beta_version must be a non-empty string" });
    }
    const v = body.beta_version.trim();
    if (allowedVersions.length && !allowedVersions.includes(v)) {
      return res.status(400).json({ error: `beta_version '${v}' is not a registered version of '${featureId}'` });
    }
    updates.beta_version = v;
  }
  if ("note" in body) {
    if (body.note === null || body.note === "") {
      updates.note = null;
    } else if (typeof body.note === "string") {
      updates.note = body.note.trim() || null;
    } else {
      return res.status(400).json({ error: "note must be a string or null" });
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  updates.last_changed_at = new Date().toISOString();

  // Does the row already exist? FAIL CLOSED — a failed read must not be treated
  // as "no row" and send us down the insert branch (which would stomp the
  // user's STATE with registry defaults).
  const { data: existing, error: readErr } = await db
    .from("feature_channels")
    .select("feature_id")
    .eq("feature_id", featureId)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });

  if (existing) {
    // Update ONLY the validated fields — never re-send identity, so an
    // unrelated toggle can't clobber a user-set version.
    const { data, error } = await db
      .from("feature_channels")
      .update(updates)
      .eq("feature_id", featureId)
      .select("*")
      .single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ feature: data });
  }

  // First write: fill the NOT NULL identity columns from an explicit body
  // override, else the code-owned registry (structure lives in code).
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

  // Seed the versions from the registry the SAME WAY the GET defaults them
  // (stable=oldest, beta=newest) when this first write doesn't set them — else
  // a plain enable-toggle insert would fall back to the schema default 'v1' for
  // BOTH channels, silently dropping the newest version the screen just showed
  // for a multi-version feature.
  if (allowedVersions.length) {
    if (!("stable_version" in updates)) updates.stable_version = allowedVersions[0];
    if (!("beta_version" in updates)) updates.beta_version = allowedVersions[allowedVersions.length - 1];
  }

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
