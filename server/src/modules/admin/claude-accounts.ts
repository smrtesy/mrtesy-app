/**
 * Admin: Claude subscription accounts — one place to manage every account the
 * in-app Claude console can run on, instead of hand-editing the scattered
 * CLAUDE_CODE_OAUTH_TOKEN_<ID> / CLAUDE_ACCOUNT_LABEL_<ID> / CLAUDE_ACCOUNTS
 * secrets by their exact names.
 *
 * An "account" is three secrets under the platform app (see runner.ts):
 *   - the OAuth token   → CLAUDE_CODE_OAUTH_TOKEN[_<ID>]   (secret)
 *   - the display label → CLAUDE_ACCOUNT_LABEL[_<ID>]      (config)
 *   - membership        → the id listed in CLAUDE_ACCOUNTS (config; primary and
 *                         automation are always present without being listed)
 *
 * This router turns "add an account" into one form (id + label + token) that
 * writes all three atomically, so the console switcher picks it up. Every route is
 * gated by requireAuth + requireSuperAdmin (mounted in ../index.ts under /api).
 *
 * NOTE on removal: Supabase Vault exposes no delete, so DELETE only drops the id
 * from the registry (the switcher stops offering it and the runner stops routing to
 * it); the encrypted token row lingers, orphaned and harmless, and is overwritten if
 * the same id is ever re-added. This mirrors the app-secrets screen's own no-delete
 * limitation (see admin/apps/routes.ts).
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db, getAppSecret, invalidateAppSecretCache } from "../../db";
import { requireAuth, requireSuperAdmin } from "../../middleware";
import {
  describeAccounts,
  tokenKeyFor,
  labelKeyFor,
  ACCOUNT_ID_RE,
  ACCOUNTS_REGISTRY_KEY,
  ACCOUNTS_APP_SLUG,
  PRIMARY_ACCOUNT,
  AUTOMATION_ACCOUNT,
} from "../claude/runner";
import { writeAppSecret } from "./apps/routes";

const router = Router();
// Path-scoped to "/admin" ON PURPOSE. This router is mounted with
// app.use("/api", adminRouter), so a BARE router.use() here runs for EVERY
// /api request that falls through to it — which 403'd every non-super-admin
// on routers mounted after it (smrtTask, studio, inbox, …).
router.use("/admin", requireAuth, requireSuperAdmin);

/** Reserved ids the operator can rename/re-token but never remove: `primary` is the
 *  default every thread falls back to, `automation` is where background work routes. */
const RESERVED = new Set([PRIMARY_ACCOUNT, AUTOMATION_ACCOUNT]);

async function resolveAppId(): Promise<string | null> {
  const { data } = await db.from("apps").select("id").eq("slug", ACCOUNTS_APP_SLUG).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Read the stored registry as a clean list of extra ids (never primary). */
async function readRegistry(): Promise<string[]> {
  const raw = (await getAppSecret(ACCOUNTS_APP_SLUG, ACCOUNTS_REGISTRY_KEY, ACCOUNTS_REGISTRY_KEY))?.trim();
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => ACCOUNT_ID_RE.test(s) && s !== PRIMARY_ACCOUNT),
    ),
  );
}

async function writeRegistry(appId: string, ids: string[]): Promise<string | null> {
  const failure = await writeAppSecret(appId, ACCOUNTS_APP_SLUG, ACCOUNTS_REGISTRY_KEY, ids.join(","), false);
  if (!failure) invalidateAppSecretCache(ACCOUNTS_APP_SLUG, ACCOUNTS_REGISTRY_KEY);
  return failure;
}

/**
 * GET /api/admin/claude-accounts — every account the console can run on, with its
 * label, whether its token is configured, and whether it may be removed.
 */
router.get("/admin/claude-accounts", async (_req: Request, res: Response) => {
  try {
    const accounts = await describeAccounts();
    return res.json({
      accounts: accounts.map((a) => ({ ...a, removable: !RESERVED.has(a.id) })),
    });
  } catch (e) {
    console.error("[admin/claude-accounts] list failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "could not load accounts" });
  }
});

/**
 * POST /api/admin/claude-accounts  body: { id, label?, token? }
 *
 * Create or update an account. A brand-new account requires a token (an account
 * with no credential is useless); updating an existing one may set just the label
 * or rotate just the token. Writes the token/label secrets and, for a non-reserved
 * id, adds it to the registry — all under the platform app.
 */
router.post("/admin/claude-accounts", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { id?: string; label?: string; token?: string };
  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";

  if (!ACCOUNT_ID_RE.test(id)) {
    return res.status(400).json({ error: "id must be lowercase letters, digits or _ (max 32)" });
  }

  const appId = await resolveAppId();
  if (!appId) return res.status(404).json({ error: "platform app not found" });

  const existing = (await describeAccounts()).find((a) => a.id === id);
  if (!existing?.configured && !token) {
    return res.status(400).json({ error: "a new account needs a token" });
  }

  if (token) {
    const failure = await writeAppSecret(appId, ACCOUNTS_APP_SLUG, tokenKeyFor(id), token, true);
    if (failure) return res.status(500).json({ error: failure });
    invalidateAppSecretCache(ACCOUNTS_APP_SLUG, tokenKeyFor(id));
  }
  if (label) {
    const failure = await writeAppSecret(appId, ACCOUNTS_APP_SLUG, labelKeyFor(id), label, false);
    if (failure) return res.status(500).json({ error: failure });
    invalidateAppSecretCache(ACCOUNTS_APP_SLUG, labelKeyFor(id));
  }

  // Reserved ids are always known without being listed; every other id must be in
  // the registry to appear in the switcher and be routable.
  if (!RESERVED.has(id)) {
    const ids = await readRegistry();
    if (!ids.includes(id)) {
      const failure = await writeRegistry(appId, [...ids, id]);
      if (failure) return res.status(500).json({ error: failure });
    }
  }

  return res.status(201).json({ ok: true, id });
});

/**
 * DELETE /api/admin/claude-accounts/:id — stop offering/routing to an account by
 * dropping it from the registry. Reserved ids (primary, automation) cannot be
 * removed. The token secret lingers (no Vault delete) but is inert once unlisted.
 */
router.delete("/admin/claude-accounts/:id", async (req: Request, res: Response) => {
  const id = req.params.id.trim().toLowerCase();
  if (!ACCOUNT_ID_RE.test(id)) return res.status(400).json({ error: "invalid id" });
  if (RESERVED.has(id)) return res.status(400).json({ error: `${id} is a reserved account and cannot be removed` });

  const appId = await resolveAppId();
  if (!appId) return res.status(404).json({ error: "platform app not found" });

  const ids = await readRegistry();
  if (!ids.includes(id)) return res.json({ ok: true, id, note: "was not registered" });
  const failure = await writeRegistry(appId, ids.filter((x) => x !== id));
  if (failure) return res.status(500).json({ error: failure });
  return res.json({ ok: true, id });
});

export default router;
