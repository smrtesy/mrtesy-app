/**
 * Admin: apps registry routes. All require requireSuperAdmin.
 *
 *   GET    /admin/apps                    list all apps + #orgs + stage from app_status
 *   POST   /admin/apps                    register a new app  body: { slug, name, description? }
 *   GET    /admin/apps/:slug              single app + list of orgs that have it enabled
 *   PATCH  /admin/apps/:slug             update name/description  body: { name?, description? }
 *   DELETE /admin/apps/:slug             unregister (CASCADE drops all app_memberships rows)
 *   GET    /admin/apps/:slug/status       get dev status
 *   PATCH  /admin/apps/:slug/status       update dev status  body: { stage?, summary?, next_steps?, blockers? }
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db, invalidateAppSecretCache } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";
import { metaErrorSummary } from "../../../lib/meta-errors";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

/** Strict slug shape: lowercase letters, numbers, dashes. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

// ── routes ─────────────────────────────────────────────────────────────────

/** GET /admin/apps */
router.get("/admin/apps", async (_req: Request, res: Response) => {
  const [{ data: apps, error }, { data: mems }, { data: statuses }] = await Promise.all([
    db.from("apps").select("*").order("created_at", { ascending: true }),
    db.from("app_memberships").select("app_id"),
    db.from("app_status").select("app_slug, stage"),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const orgCount  = new Map<string, number>();
  for (const m of mems ?? []) orgCount.set(m.app_id, (orgCount.get(m.app_id) ?? 0) + 1);

  const stageMap = new Map<string, string>();
  for (const s of statuses ?? []) stageMap.set(s.app_slug, s.stage);

  const result = (apps ?? []).map((a) => ({
    ...a,
    org_count: orgCount.get(a.id) ?? 0,
    stage:     stageMap.get(a.slug)  ?? null,
  }));
  res.json({ apps: result });
});

/** POST /admin/apps  body: { slug, name, description? } */
router.post("/admin/apps", async (req: Request, res: Response) => {
  const { slug, name, description } = req.body ?? {};
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return res.status(400).json({
      error: "slug must be lowercase letters, numbers and dashes; 2–40 chars; must start with a letter",
    });
  }
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const { data, error } = await db
    .from("apps")
    .insert({
      slug,
      name: name.trim(),
      description: typeof description === "string" ? description.trim() || null : null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "slug already taken" });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ app: data });
});

/** GET /admin/apps/:slug — single app + which orgs have it enabled */
router.get("/admin/apps/:slug", async (req: Request, res: Response) => {
  const { data: app } = await db.from("apps").select("*").eq("slug", req.params.slug).maybeSingle();
  if (!app) return res.status(404).json({ error: "app not found" });

  const { data: mems } = await db
    .from("app_memberships")
    .select("org_id, enabled_at, enabled_by, organizations(id, slug, name)")
    .eq("app_id", app.id);

  const enabledFor = (mems ?? []).map((m) => {
    const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
    return {
      enabled_at: m.enabled_at,
      enabled_by: m.enabled_by,
      org: org ?? { id: m.org_id, slug: null, name: null },
    };
  });

  res.json({ app, enabled_for: enabledFor });
});

/** PATCH /admin/apps/:slug  body: { name?, description? } */
router.patch("/admin/apps/:slug", async (req: Request, res: Response) => {
  const { name, description } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof description === "string")           updates.description = description.trim() || null;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("apps")
    .update(updates)
    .eq("slug", req.params.slug)
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "app not found" });
  res.json({ app: data });
});

/** DELETE /admin/apps/:slug — full unregister (CASCADE drops all app_memberships) */
router.delete("/admin/apps/:slug", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("apps")
    .delete({ count: "exact" })
    .eq("slug", req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "app not found" });
  res.json({ ok: true });
});

const VALID_STAGES = ["רעיון", "בניה", "טסט", "מאור", "לקוחות"] as const;

/** GET /admin/apps/:slug/status */
router.get("/admin/apps/:slug/status", async (req: Request, res: Response) => {
  const { data } = await db
    .from("app_status")
    .select("*")
    .eq("app_slug", req.params.slug)
    .maybeSingle();
  res.json({ status: data ?? { app_slug: req.params.slug, stage: "רעיון", summary: null, next_steps: [], blockers: [], updated_at: null } });
});

/** PATCH /admin/apps/:slug/status  body: { stage?, summary?, next_steps?, blockers? } */
router.patch("/admin/apps/:slug/status", async (req: Request, res: Response) => {
  const { stage, summary, next_steps, blockers } = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (stage !== undefined) {
    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(", ")}` });
    }
    updates.stage = stage;
  }
  if (summary !== undefined)     updates.summary     = typeof summary === "string" ? summary.trim() || null : null;
  if (next_steps !== undefined)  updates.next_steps  = Array.isArray(next_steps)  ? next_steps.map(String).filter(Boolean)  : [];
  if (blockers   !== undefined)  updates.blockers    = Array.isArray(blockers)    ? blockers.map(String).filter(Boolean)    : [];

  const { data, error } = await db
    .from("app_status")
    .upsert({ app_slug: req.params.slug, ...updates }, { onConflict: "app_slug" })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: data });
});

// ─────────────────────────────────────────────────────────────────────────
// Secrets management
// ─────────────────────────────────────────────────────────────────────────
//
// Two surfaces in one page:
//   1. Platform-wide secrets/config (app_secrets table) — Gemini key, model
//      choice, Meta API version. Shared across all tenants of this app.
//   2. Per-WABA secrets stored on whatsapp_connections — Access Token,
//      App Secret, Verify Token. Listed so a super-admin can rotate any
//      of them without bothering the tenant.
//
// We never return decrypted secret values in the GET; the UI only sees a
// boolean "is_set" indicator and the non-secret config plaintext.

/** Catalog of platform-wide keys we know about for the smrttask app.
 *  Drives the GET response when the row doesn't exist yet (so the UI can
 *  render the field) and constrains what PUT accepts. These are consumed
 *  only by our Node backend (via getAppSecret), so they're safe to edit
 *  from the admin UI and are stored in app_secrets / Supabase Vault.
 */
const SMRTTASK_PLATFORM_KEYS = [
  { key: "GEMINI_API_KEY",        is_secret: true,  default_value: null },
  { key: "GEMINI_MODEL",          is_secret: false, default_value: "gemini-3-flash-preview" },
  { key: "GEMINI_THINKING_LEVEL", is_secret: false, default_value: "low" },
  { key: "META_API_VERSION",      is_secret: false, default_value: "v21.0" },
] as const;

/** Apps whose platform secrets live in app_secrets / Vault and are editable
 *  from the admin UI. Maps slug → its editable key catalog. */
const EDITABLE_PLATFORM_KEYS: Record<string, ReadonlyArray<{ key: string; is_secret: boolean; default_value: string | null }>> = {
  smrttask: SMRTTASK_PLATFORM_KEYS,
};

/** Apps whose "secrets" are environment variables — surfaced read-only.
 *  These keys are shared with an external service (e.g. the Python
 *  voice-engine), so editing them from here would desync the two services.
 *  We only report set/missing; the operator changes them in the hosting env. */
const ENV_PLATFORM_KEYS: Record<string, ReadonlyArray<{ key: string; is_secret: boolean }>> = {
  smrtvoice: [
    { key: "VOICE_ENGINE_URL",            is_secret: false },
    { key: "VOICE_ENGINE_API_KEY",        is_secret: true },
    { key: "VOICE_ENGINE_WEBHOOK_SECRET", is_secret: true },
  ],
};

/** Apps that own per-WABA WhatsApp connections (the connections + webhook
 *  section). Only smrtTask integrates WhatsApp today. */
const WHATSAPP_APPS = new Set<string>(["smrttask"]);

interface PlatformSecretRow {
  key: string;
  is_secret: boolean;
  value_text: string | null;
  value_secret_id: string | null;
}

/** GET /admin/apps/:slug/secrets */
router.get("/admin/apps/:slug/secrets", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { data: app, error: appErr } = await db
    .from("apps")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (appErr) return res.status(500).json({ error: appErr.message });
  if (!app) return res.status(404).json({ error: "app not found" });

  // Env-based apps (e.g. smrtvoice): report set/missing only, never editable.
  const envCatalog = ENV_PLATFORM_KEYS[slug];
  if (envCatalog) {
    const platform = envCatalog.map((spec) => {
      const envVal = process.env[spec.key] ?? null;
      return {
        key: spec.key,
        is_secret: spec.is_secret,
        value_text: spec.is_secret ? null : envVal,
        is_set: Boolean(envVal),
      };
    });
    return res.json({ editable: false, whatsapp: false, platform, connections: [] });
  }

  const catalog = EDITABLE_PLATFORM_KEYS[slug] ?? [];

  const { data: rows, error: rowsErr } = await db
    .from("app_secrets")
    .select("key, is_secret, value_text, value_secret_id")
    .eq("app_id", app.id);
  if (rowsErr) return res.status(500).json({ error: rowsErr.message });

  // Merge catalog with stored rows so the UI always sees every expected key,
  // even before the operator has saved anything for it.
  const stored = new Map((rows as PlatformSecretRow[] ?? []).map((r) => [r.key, r]));
  const platform = catalog.map((spec) => {
    const row = stored.get(spec.key);
    return {
      key: spec.key,
      is_secret: spec.is_secret,
      value_text: spec.is_secret ? null : (row?.value_text ?? spec.default_value),
      is_set: spec.is_secret
        ? Boolean(row?.value_secret_id)
        : Boolean(row?.value_text || spec.default_value),
    };
  });

  const whatsapp = WHATSAPP_APPS.has(slug);
  if (!whatsapp) {
    return res.json({ editable: true, whatsapp: false, platform, connections: [] });
  }

  // Per-WABA secrets — masked indicators only.
  const { data: conns, error: connsErr } = await db
    .from("whatsapp_connections")
    .select(
      "id, user_id, phone_number_id, waba_id, business_id, display_phone_number, access_token_secret_id, app_secret_id, verify_token_id, connected_at, disconnected_at",
    )
    .order("connected_at", { ascending: false });
  if (connsErr) return res.status(500).json({ error: connsErr.message });

  const connections = (conns ?? []).map((c) => ({
    id: c.id,
    user_id: c.user_id,
    phone_number_id: c.phone_number_id,
    waba_id: c.waba_id,
    business_id: c.business_id,
    display_phone_number: c.display_phone_number,
    connected_at: c.connected_at,
    disconnected_at: c.disconnected_at,
    access_token_set: Boolean(c.access_token_secret_id),
    app_secret_set: Boolean(c.app_secret_id),
    verify_token_set: Boolean(c.verify_token_id),
  }));

  res.json({ editable: true, whatsapp: true, platform, connections });
});

/** PUT /admin/apps/:slug/secrets/:key  body: { value: string } */
router.put("/admin/apps/:slug/secrets/:key", async (req: Request, res: Response) => {
  const { slug, key } = req.params;
  const { value } = (req.body ?? {}) as { value?: string };
  if (typeof value !== "string") {
    return res.status(400).json({ error: "value must be a string" });
  }

  // Env-based apps are read-only here — their keys are shared with an external
  // service and must be changed in the hosting environment, not the DB.
  if (ENV_PLATFORM_KEYS[slug]) {
    return res.status(400).json({ error: "secrets for this app are read-only (managed via environment variables)" });
  }

  const catalog = EDITABLE_PLATFORM_KEYS[slug] ?? [];
  const spec = catalog.find((s) => s.key === key);
  if (!spec) return res.status(400).json({ error: `unknown key: ${key}` });

  const { data: app, error: appErr } = await db
    .from("apps")
    .select("id")
    .eq("slug", req.params.slug)
    .maybeSingle();
  if (appErr) return res.status(500).json({ error: appErr.message });
  if (!app) return res.status(404).json({ error: "app not found" });

  if (spec.is_secret) {
    // Find existing row first to decide between vault_create_secret and
    // vault_update_secret (rotate-in-place is friendlier on the audit log).
    const { data: existing } = await db
      .from("app_secrets")
      .select("value_secret_id")
      .eq("app_id", app.id)
      .eq("key", key)
      .maybeSingle();

    const existingId = (existing?.value_secret_id as string | null | undefined) ?? null;
    let secretId: string | null = existingId;

    if (existingId) {
      const { error } = await db.rpc("vault_update_secret", {
        secret_id: existingId,
        new_secret: value,
      });
      if (error) return res.status(500).json({ error: `vault update: ${error.message}` });
    } else {
      const { data: created, error } = await db.rpc("vault_create_secret", {
        new_secret: value,
        new_name: `app_secret:${req.params.slug}:${key}`,
        new_description: `Platform-wide ${key} for ${req.params.slug}`,
      });
      if (error) return res.status(500).json({ error: `vault create: ${error.message}` });
      secretId = (created as string | null) ?? null;
    }

    const { error: upsertErr } = await db
      .from("app_secrets")
      .upsert(
        { app_id: app.id, key, is_secret: true, value_secret_id: secretId, value_text: null },
        { onConflict: "app_id,key" },
      );
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });
  } else {
    const { error: upsertErr } = await db
      .from("app_secrets")
      .upsert(
        { app_id: app.id, key, is_secret: false, value_text: value, value_secret_id: null },
        { onConflict: "app_id,key" },
      );
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });
  }

  // The webhook's getAppSecret cache holds a 10s TTL on each value; if we
  // didn't invalidate, an operator's save would only take effect after that
  // window. Clearing here makes the rotation feel immediate.
  invalidateAppSecretCache(req.params.slug, key);

  res.json({ ok: true });
});

/** PUT /admin/apps/:slug/connections/:phone_number_id/secrets
 *  body: { access_token?, app_secret?, verify_token? }
 *  Any field present is rotated in Vault; missing fields are left alone.
 */
router.put(
  "/admin/apps/:slug/connections/:phone_number_id/secrets",
  async (req: Request, res: Response) => {
    const { phone_number_id } = req.params;
    const { access_token, app_secret, verify_token } = (req.body ?? {}) as {
      access_token?: string;
      app_secret?: string;
      verify_token?: string;
    };

    const { data: row } = await db
      .from("whatsapp_connections")
      .select("id, access_token_secret_id, app_secret_id, verify_token_id")
      .eq("phone_number_id", phone_number_id)
      .maybeSingle();
    if (!row) return res.status(404).json({ error: "connection not found" });

    const update: Record<string, unknown> = {};

    const rotateOrCreate = async (
      value: string,
      existing: string | null,
      name: string,
      description: string,
    ): Promise<{ id: string | null; error: string | null }> => {
      if (existing) {
        const { error } = await db.rpc("vault_update_secret", {
          secret_id: existing,
          new_secret: value,
        });
        return { id: existing, error: error?.message ?? null };
      }
      const { data, error } = await db.rpc("vault_create_secret", {
        new_secret: value,
        new_name: name,
        new_description: description,
      });
      return { id: (data as string | null) ?? null, error: error?.message ?? null };
    };

    if (typeof access_token === "string" && access_token.trim()) {
      const r = await rotateOrCreate(
        access_token.trim(),
        (row.access_token_secret_id as string | null) ?? null,
        `whatsapp_access_token:${phone_number_id}`,
        "Meta Cloud API Bearer for WhatsApp media fetch",
      );
      if (r.error) return res.status(500).json({ error: `access_token: ${r.error}` });
      update.access_token_secret_id = r.id;
    }
    if (typeof app_secret === "string" && app_secret.trim()) {
      const r = await rotateOrCreate(
        app_secret.trim(),
        (row.app_secret_id as string | null) ?? null,
        `whatsapp_app_secret:${phone_number_id}`,
        "Meta App Secret used to verify X-Hub-Signature-256",
      );
      if (r.error) return res.status(500).json({ error: `app_secret: ${r.error}` });
      update.app_secret_id = r.id;
    }
    if (typeof verify_token === "string" && verify_token.trim()) {
      const r = await rotateOrCreate(
        verify_token.trim(),
        (row.verify_token_id as string | null) ?? null,
        `whatsapp_verify_token:${phone_number_id}`,
        "Verify token Meta echoes during webhook GET handshake",
      );
      if (r.error) return res.status(500).json({ error: `verify_token: ${r.error}` });
      update.verify_token_id = r.id;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "nothing to update" });
    }

    const { error: updErr } = await db
      .from("whatsapp_connections")
      .update(update)
      .eq("id", row.id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    res.json({ ok: true });
  },
);

/**
 * GET /admin/apps/:slug/connections/:phone_number_id/meta-subscription
 *
 * Diagnostic: asks Meta directly which fields the WABA's subscribed_apps
 * are configured to receive. If `messages` is missing from the list,
 * DualHook (or some upstream config) hasn't subscribed us to it — which
 * is why incoming customer replies don't reach our webhook even though
 * outgoing echoes do.
 *
 * Meta endpoint: GET /v21.0/{WABA_ID}/subscribed_apps
 * Auth: needs a System User Access Token for the WABA (we use the
 * connection's stored access_token from Vault).
 */
router.get(
  "/admin/apps/:slug/connections/:phone_number_id/meta-subscription",
  async (req: Request, res: Response) => {
    const { phone_number_id } = req.params;

    const { data: conn } = await db
      .from("whatsapp_connections")
      .select("waba_id, access_token_secret_id")
      .eq("phone_number_id", phone_number_id)
      .maybeSingle();
    if (!conn) return res.status(404).json({ error: "connection not found" });
    if (!conn.waba_id) {
      return res.status(400).json({ error: "waba_id missing on this connection" });
    }
    if (!conn.access_token_secret_id) {
      return res.status(400).json({ error: "access_token missing on this connection" });
    }

    const { data: tokenPlain, error: tokenErr } = await db.rpc("vault_read_secret", {
      secret_id: conn.access_token_secret_id as string,
    });
    if (tokenErr) return res.status(500).json({ error: `vault: ${tokenErr.message}` });
    const token = typeof tokenPlain === "string" ? tokenPlain : null;
    if (!token) return res.status(500).json({ error: "access_token unreadable" });

    const apiVersion = process.env.META_API_VERSION ?? "v21.0";
    const url = `https://graph.facebook.com/${apiVersion}/${conn.waba_id}/subscribed_apps`;

    const metaRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const metaJson = (await metaRes.json().catch(() => ({}))) as unknown;

    if (!metaRes.ok) {
      return res.status(502).json({
        error: "meta_query_failed",
        reason: metaErrorSummary(metaRes.status, metaJson),
        status: metaRes.status,
        meta_response: metaJson,
      });
    }

    return res.json({
      ok: true,
      waba_id: conn.waba_id,
      meta_response: metaJson,
    });
  },
);

/**
 * System params for an app. Currently only `smrttask` has a backing row
 * (smrttask_system_params), so other slugs return 404. Super-admin only.
 *
 * GET   /admin/apps/:slug/parameters    → row
 * PATCH /admin/apps/:slug/parameters    body: any subset of editable fields
 */
const SMRTTASK_PARAM_FIELDS = [
  "classification_model",
  "summary_model",
  "batch_size",
  "processing_lock_minutes",
  "calendar_past_days",
  "calendar_future_days",
  "body_truncate_classify",
  "body_truncate_project",
  "body_truncate_task",
] as const;

router.get("/admin/apps/:slug/parameters", async (req: Request, res: Response) => {
  if (req.params.slug !== "smrttask") {
    return res.status(404).json({ error: "no system params for this app" });
  }
  const { data, error } = await db
    .from("smrttask_system_params")
    .select("*")
    .eq("id", "smrttask")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "params row missing" });
  return res.json(data);
});

router.patch("/admin/apps/:slug/parameters", async (req: Request, res: Response) => {
  if (req.params.slug !== "smrttask") {
    return res.status(404).json({ error: "no system params for this app" });
  }
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? null;
  const update: Record<string, unknown> = {};
  for (const key of SMRTTASK_PARAM_FIELDS) {
    if (!(key in req.body)) continue;
    const val = (req.body as Record<string, unknown>)[key];
    if (key === "classification_model" || key === "summary_model") {
      if (typeof val !== "string" || !val.trim()) {
        return res.status(400).json({ error: `${key} must be non-empty string` });
      }
      update[key] = val.trim();
    } else {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: `${key} must be positive number` });
      }
      update[key] = Math.floor(n);
    }
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }
  update.updated_at = new Date().toISOString();
  update.updated_by = userId;

  const { data, error } = await db
    .from("smrttask_system_params")
    .update(update)
    .eq("id", "smrttask")
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

export default router;
