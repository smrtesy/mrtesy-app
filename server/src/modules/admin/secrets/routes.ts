/**
 * Managed secrets — super-admin routes (phase 1: Railway loop).
 * Design: docs/managed-secrets-plan.md.
 *
 * The whole router is gated by requireAuth + requireSuperAdmin (mounted in
 * modules/admin/index.ts). Values live in Supabase Vault; only names + presence +
 * a fingerprint ever leave this process — never a secret value. Every write goes
 * through the confirm-gated /sync endpoint and lands an append-only audit row.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";
import { vaultRead, vaultWrite } from "./vault";
import { fingerprint } from "./fingerprint";
import {
  railwayReadVariables,
  railwayUpsertVariable,
  railwayInventory,
  type RailwayReadResult,
  type RailwayTargetSpec,
} from "./railway";
import {
  vercelInventory,
  vercelProjectEnvNames,
  vercelUpsertEnv,
  type VercelReadResult,
} from "./vercel";
import {
  supabaseInventory,
  supabaseUpsertSecret,
  supabaseSecretFingerprints,
  type SupabaseReadResult,
} from "./supabase";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// Providers whose read+write connectors are wired up. All three are live now
// (Railway phase 1, Vercel + Supabase phase 2/3).
const LIVE_PROVIDERS = new Set(["railway", "vercel", "supabase"]);

// Logical key names follow the same shape as the app_secrets custom keys — but the
// managed registry keys on a human label, so we allow spaces and mixed case. Keep it
// non-empty and bounded.
const KEY_NAME_RE = /^[\w .:\-/]{2,80}$/;
// The variable name written on a provider must be a real env-var identifier.
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

interface SecretRow {
  id: string;
  key_name: string;
  description: string | null;
  vault_secret_id: string | null;
  value_fingerprint: string | null;
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TargetRow {
  id: string;
  secret_id: string;
  provider: string;
  target_ref: string | null;
  env_var_name: string;
  environment: string;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
}

function actorOf(req: Request): string {
  const u = req.user as { id?: string; email?: string } | undefined;
  return u?.email || u?.id || "unknown";
}

async function audit(entry: {
  secretId?: string | null;
  targetId?: string | null;
  action: string;
  provider?: string | null;
  envVarName?: string | null;
  result: "ok" | "error";
  message?: string | null;
  actor: string;
}): Promise<void> {
  // Best-effort — an audit write must never fail the operation it records, but we
  // surface nothing sensitive so there is nothing to leak on failure.
  const { error } = await db.from("secret_sync_log").insert({
    secret_id: entry.secretId ?? null,
    target_id: entry.targetId ?? null,
    action: entry.action,
    provider: entry.provider ?? null,
    env_var_name: entry.envVarName ?? null,
    result: entry.result,
    message: entry.message ?? null,
    actor: entry.actor,
  });
  if (error) console.error("[managed-secrets] audit write failed:", error.message);
}

const specOf = (t: TargetRow): RailwayTargetSpec => ({
  serviceRef: t.target_ref,
  environment: t.environment,
});
const ctxKey = (t: TargetRow): string => `${t.target_ref ?? ""}::${t.environment}`;

// ── GET /admin/secrets/inventory — every variable NAME in each service ──────────
// The "what exists in each service" panel. Reads all three providers in parallel
// and returns NAMES + metadata only — never a value. Each provider degrades to
// { configured:false, hint } when its token is unset, so the panel is always safe.
router.get("/admin/secrets/inventory", async (_req: Request, res: Response) => {
  // allSettled so one provider throwing can never hang the request or drop the
  // others — a rejected connector degrades to an error result for that provider.
  const [railway, vercel, supabase] = await Promise.allSettled([
    railwayInventory(),
    vercelInventory(),
    supabaseInventory(),
  ]);
  const pick = (
    r: PromiseSettledResult<Awaited<ReturnType<typeof railwayInventory>>>,
    provider: "railway" | "vercel" | "supabase",
  ) =>
    r.status === "fulfilled"
      ? r.value
      : {
          provider,
          configured: true,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          vars: [],
        };
  res.json({
    railway: pick(railway, "railway"),
    vercel: pick(vercel, "vercel"),
    supabase: pick(supabase, "supabase"),
  });
});

// ── GET /admin/secrets — the live mirror ────────────────────────────────────────
router.get("/admin/secrets", async (_req: Request, res: Response) => {
  const { data: secrets, error: sErr } = await db
    .from("managed_secrets")
    .select("*")
    .order("created_at", { ascending: true });
  if (sErr) return res.status(500).json({ error: sErr.message });

  const secretRows = (secrets ?? []) as SecretRow[];
  const ids = secretRows.map((s) => s.id);

  let targetRows: TargetRow[] = [];
  if (ids.length) {
    const { data: targets, error: tErr } = await db
      .from("managed_secret_targets")
      .select("*")
      .in("secret_id", ids);
    if (tErr) return res.status(500).json({ error: tErr.message });
    targetRows = (targets ?? []) as TargetRow[];
  }

  // Read each distinct provider context at most once (mirror is presence + drift).
  const railwayCache = new Map<string, RailwayReadResult>();
  const vercelCache = new Map<string, VercelReadResult>();
  let supabaseRead: SupabaseReadResult | null = null;
  for (const t of targetRows) {
    if (t.provider === "railway") {
      const key = ctxKey(t);
      if (!railwayCache.has(key)) railwayCache.set(key, await railwayReadVariables(specOf(t)));
    } else if (t.provider === "vercel") {
      const key = t.target_ref ?? "";
      if (t.target_ref && !vercelCache.has(key)) {
        vercelCache.set(key, await vercelProjectEnvNames(t.target_ref));
      }
    } else if (t.provider === "supabase") {
      if (!supabaseRead) supabaseRead = await supabaseSecretFingerprints();
    }
  }

  const bySecret = new Map<string, TargetRow[]>();
  for (const t of targetRows) {
    const arr = bySecret.get(t.secret_id) ?? [];
    arr.push(t);
    bySecret.set(t.secret_id, arr);
  }

  const persistUpdates: Array<Promise<unknown>> = [];

  const out = secretRows.map((s) => {
    const targets = (bySecret.get(s.id) ?? []).map((t) => {
      let present: boolean | null = null;
      let matches: boolean | null = null;
      let configured = LIVE_PROVIDERS.has(t.provider);
      let hint: string | undefined;
      let providerError: string | undefined;

      // present = does env_var_name exist on the provider; matches = does its value
      // fingerprint the same as our intended value (only where the provider returns a
      // value we can fingerprint: Railway + Supabase; Vercel values are encrypted, so
      // Vercel is presence-only with matches=null). fpOnProvider is persisted for drift.
      let fpOnProvider: string | null = null;

      if (t.provider === "railway") {
        const read = railwayCache.get(ctxKey(t));
        if (read) {
          configured = read.configured;
          hint = read.hint;
          providerError = read.error;
          if (read.fingerprints) {
            const fp = read.fingerprints[t.env_var_name];
            present = fp !== undefined;
            fpOnProvider = present ? fp : null;
            matches = s.value_fingerprint ? (present ? fp === s.value_fingerprint : false) : null;
          }
        }
      } else if (t.provider === "vercel") {
        if (!t.target_ref) {
          configured = false;
          hint = "This Vercel target needs the project id (set it as the target's service id).";
        } else {
          const read = vercelCache.get(t.target_ref);
          if (read) {
            configured = read.configured;
            hint = read.hint;
            providerError = read.error;
            if (read.names) {
              present = read.names.includes(t.env_var_name);
              matches = null; // Vercel values are encrypted — presence only.
            }
          }
        }
      } else if (t.provider === "supabase") {
        const read = supabaseRead;
        if (read) {
          configured = read.configured;
          hint = read.hint;
          providerError = read.error;
          if (read.fingerprints) {
            const fp = read.fingerprints[t.env_var_name];
            present = fp !== undefined;
            fpOnProvider = present ? fp : null;
            matches = s.value_fingerprint ? (present ? fp === s.value_fingerprint : false) : null;
          }
        }
      }

      // Persist the live read onto the target (fire-and-forget). Only when we got a
      // definitive presence read (present !== null), so a provider error doesn't wipe
      // the last-known state.
      if (present !== null) {
        const present_ = present;
        const fp_ = fpOnProvider;
        persistUpdates.push(
          (async () => {
            await db
              .from("managed_secret_targets")
              .update({
                last_seen_present: present_,
                value_fingerprint: fp_,
                updated_at: new Date().toISOString(),
              })
              .eq("id", t.id);
          })(),
        );
      }

      return {
        id: t.id,
        provider: t.provider,
        target_ref: t.target_ref,
        env_var_name: t.env_var_name,
        environment: t.environment,
        configured,
        present,
        matches,
        hint,
        provider_error: providerError,
        last_synced_at: t.last_synced_at,
        last_sync_status: t.last_sync_status,
        last_sync_error: t.last_sync_error,
      };
    });

    // Drift: among targets we can actually read and where an intended value exists,
    // any that is missing or whose value differs.
    const drift =
      !!s.value_fingerprint &&
      targets.some((t) => t.configured && !t.provider_error && (t.present === false || t.matches === false));

    return {
      id: s.id,
      key_name: s.key_name,
      description: s.description,
      has_value: !!s.vault_secret_id,
      fingerprint: s.value_fingerprint,
      rotated_at: s.rotated_at,
      created_at: s.created_at,
      updated_at: s.updated_at,
      drift,
      targets,
    };
  });

  await Promise.allSettled(persistUpdates);
  res.json({ secrets: out });
});

// ── POST /admin/secrets — create a managed secret ───────────────────────────────
router.post("/admin/secrets", async (req: Request, res: Response) => {
  const { key_name, description, value } = (req.body ?? {}) as {
    key_name?: string;
    description?: string;
    value?: string;
  };
  const name = typeof key_name === "string" ? key_name.trim() : "";
  if (!KEY_NAME_RE.test(name)) {
    return res.status(400).json({ error: "key_name must be 2-80 chars (letters, digits, space . : - / _)" });
  }

  let vaultId: string | null = null;
  let fp: string | null = null;
  if (typeof value === "string" && value !== "") {
    try {
      vaultId = await vaultWrite(null, value, `managed_secret:${name}`, `Managed secret: ${name}`);
      fp = fingerprint(value);
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("managed_secrets")
    .insert({
      key_name: name,
      description: description ?? null,
      vault_secret_id: vaultId,
      value_fingerprint: fp,
      rotated_at: vaultId ? nowIso : null,
      updated_at: nowIso,
    })
    .select("id")
    .single();
  if (error) {
    // Unique violation on key_name → 409 so the UI can say "already exists".
    const status = /duplicate|unique/i.test(error.message) ? 409 : 500;
    return res.status(status).json({ error: error.message });
  }

  await audit({
    secretId: data.id,
    action: "create",
    result: "ok",
    message: vaultId ? "created with value" : "created without value",
    actor: actorOf(req),
  });
  res.status(201).json({ id: data.id });
});

// ── PUT /admin/secrets/:id — set / rotate the value ─────────────────────────────
router.put("/admin/secrets/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { value } = (req.body ?? {}) as { value?: string };
  if (typeof value !== "string" || value === "") {
    return res.status(400).json({ error: "value is required" });
  }

  const { data: row, error: readErr } = await db
    .from("managed_secrets")
    .select("id, key_name, vault_secret_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!row) return res.status(404).json({ error: "not found" });

  try {
    const vaultId = await vaultWrite(
      (row.vault_secret_id as string | null) ?? null,
      value,
      `managed_secret:${row.key_name}`,
      `Managed secret: ${row.key_name}`,
    );
    const nowIso = new Date().toISOString();
    const { error: upErr } = await db
      .from("managed_secrets")
      .update({
        vault_secret_id: vaultId,
        value_fingerprint: fingerprint(value),
        rotated_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", id);
    if (upErr) return res.status(500).json({ error: upErr.message });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  await audit({ secretId: id, action: "rotate", result: "ok", message: "value set", actor: actorOf(req) });
  res.json({ ok: true });
});

// ── DELETE /admin/secrets/:id — stop managing this key ──────────────────────────
// Removes the registry row and its targets (cascade). Does NOT touch the provider
// env vars (that would be a destructive write) and cannot remove the Vault value
// (Supabase exposes no vault_delete) — the value is simply orphaned.
router.delete("/admin/secrets/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await db.from("managed_secrets").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  await audit({ secretId: id, action: "remove", result: "ok", message: "unmanaged", actor: actorOf(req) });
  res.json({ ok: true });
});

// ── POST /admin/secrets/:id/targets — add a destination ─────────────────────────
router.post("/admin/secrets/:id/targets", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { provider, target_ref, env_var_name, environment } = (req.body ?? {}) as {
    provider?: string;
    target_ref?: string;
    env_var_name?: string;
    environment?: string;
  };
  if (provider !== "railway" && provider !== "vercel" && provider !== "supabase") {
    return res.status(400).json({ error: "provider must be railway, vercel, or supabase" });
  }
  const varName = typeof env_var_name === "string" ? env_var_name.trim().toUpperCase() : "";
  if (!ENV_VAR_RE.test(varName)) {
    return res.status(400).json({ error: "env_var_name must be UPPER_SNAKE_CASE (A-Z, 0-9, _)" });
  }

  const { data: secret, error: sErr } = await db
    .from("managed_secrets")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!secret) return res.status(404).json({ error: "not found" });

  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("managed_secret_targets")
    .insert({
      secret_id: id,
      provider,
      target_ref: (typeof target_ref === "string" && target_ref.trim()) || null,
      env_var_name: varName,
      environment: (typeof environment === "string" && environment.trim()) || "production",
      updated_at: nowIso,
    })
    .select("id")
    .single();
  if (error) {
    const status = /duplicate|unique/i.test(error.message) ? 409 : 500;
    return res.status(status).json({ error: error.message });
  }

  await audit({
    secretId: id,
    targetId: data.id,
    action: "add_target",
    provider,
    envVarName: varName,
    result: "ok",
    actor: actorOf(req),
  });
  res.status(201).json({ id: data.id });
});

// ── DELETE /admin/secrets/:id/targets/:targetId — remove a destination ──────────
router.delete("/admin/secrets/:id/targets/:targetId", async (req: Request, res: Response) => {
  const { id, targetId } = req.params;
  const { error } = await db
    .from("managed_secret_targets")
    .delete()
    .eq("id", targetId)
    .eq("secret_id", id);
  if (error) return res.status(500).json({ error: error.message });
  await audit({ secretId: id, targetId, action: "remove_target", result: "ok", actor: actorOf(req) });
  res.json({ ok: true });
});

// ── POST /admin/secrets/:id/sync — the confirm-gated write engine ───────────────
// body: { confirm: true, target_ids?: string[] }
// Reads the value from Vault and writes it to each target through the provider
// connector, records per-target status, and lands an audit row per write. Every
// call MUST pass confirm:true (the UI's approval step) — otherwise nothing is
// written and the intended plan is returned for the operator to confirm.
router.post("/admin/secrets/:id/sync", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { confirm, target_ids } = (req.body ?? {}) as { confirm?: boolean; target_ids?: string[] };

  const { data: secret, error: sErr } = await db
    .from("managed_secrets")
    .select("id, key_name, vault_secret_id, value_fingerprint")
    .eq("id", id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!secret) return res.status(404).json({ error: "not found" });
  if (!secret.vault_secret_id) {
    return res.status(400).json({ error: "set a value for this secret before syncing" });
  }

  let query = db.from("managed_secret_targets").select("*").eq("secret_id", id);
  if (Array.isArray(target_ids) && target_ids.length) query = query.in("id", target_ids);
  const { data: targets, error: tErr } = await query;
  if (tErr) return res.status(500).json({ error: tErr.message });
  const targetRows = (targets ?? []) as TargetRow[];
  if (!targetRows.length) return res.status(400).json({ error: "no targets to sync" });

  // Approval gate: without an explicit confirm we write nothing and return the plan.
  if (confirm !== true) {
    return res.status(400).json({
      error: "confirmation required",
      preview: targetRows.map((t) => ({
        target_id: t.id,
        provider: t.provider,
        env_var_name: t.env_var_name,
        environment: t.environment,
        target_ref: t.target_ref,
      })),
    });
  }

  let value: string | null;
  try {
    value = await vaultRead(secret.vault_secret_id as string);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
  if (value === null) return res.status(500).json({ error: "could not read the value from Vault" });

  const actor = actorOf(req);
  const intendedFp = fingerprint(value);
  const results: Array<{
    target_id: string;
    provider: string;
    env_var_name: string;
    ok: boolean;
    error?: string;
    note?: string;
  }> = [];

  for (const t of targetRows) {
    let ok = false;
    let errMsg: string | undefined;
    let note: string | undefined;

    if (t.provider === "railway") {
      const w = await railwayUpsertVariable(specOf(t), t.env_var_name, value);
      ok = w.ok;
      errMsg = w.ok ? undefined : w.error || w.hint || "railway write failed";
      note = w.ok ? "written; Railway auto-redeploys the service" : undefined;
    } else if (t.provider === "vercel") {
      const w = await vercelUpsertEnv(t.target_ref, t.env_var_name, value, t.environment);
      ok = w.ok;
      errMsg = w.ok ? undefined : w.error || w.hint || "vercel write failed";
      note = w.ok ? w.note ?? "written; production redeploy triggered" : undefined;
    } else if (t.provider === "supabase") {
      const w = await supabaseUpsertSecret(t.env_var_name, value);
      ok = w.ok;
      errMsg = w.ok ? undefined : w.error || w.hint || "supabase write failed";
      note = w.ok ? "written; edge functions pick it up on next invocation" : undefined;
    } else {
      errMsg = `unknown provider ${t.provider}`;
    }

    const nowIso = new Date().toISOString();
    // undefined keys are dropped by postgrest-js, so on error we don't clobber the
    // last-known presence/fingerprint. Surface (not swallow) a bookkeeping failure —
    // the provider write already happened, but a stale status column shouldn't hide.
    const { error: bookkeepErr } = await db
      .from("managed_secret_targets")
      .update({
        last_synced_at: nowIso,
        last_sync_status: ok ? "ok" : "error",
        last_sync_error: ok ? null : (errMsg ?? "error"),
        last_seen_present: ok ? true : undefined,
        value_fingerprint: ok ? intendedFp : undefined,
        updated_at: nowIso,
      })
      .eq("id", t.id);
    if (bookkeepErr)
      console.error("[managed-secrets] target status update failed:", bookkeepErr.message);

    await audit({
      secretId: id,
      targetId: t.id,
      action: "sync",
      provider: t.provider,
      envVarName: t.env_var_name,
      result: ok ? "ok" : "error",
      message: ok ? note ?? "value written" : errMsg,
      actor,
    });

    results.push({ target_id: t.id, provider: t.provider, env_var_name: t.env_var_name, ok, error: errMsg, note });
  }

  res.json({ results });
});

// ── GET /admin/secrets/:id/log — the audit trail ────────────────────────────────
router.get("/admin/secrets/:id/log", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { data, error } = await db
    .from("secret_sync_log")
    .select("id, action, provider, env_var_name, result, message, actor, created_at")
    .eq("secret_id", id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ log: data ?? [] });
});

export default router;
