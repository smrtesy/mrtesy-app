/**
 * smrtBot — publish test→live + rollback (ported from botsite publishRoutes.js).
 *
 * Publishing snapshots the current live content of the env-scoped tables into a
 * smrtbot_publish_batches row, then replaces live with a copy of the test rows.
 * Rollback restores a batch's snapshot back to live. Gated by requireBotAccess.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireBotAccess } from "../require-bot-access";

const router = Router();

// Env-scoped content tables that publish/rollback operate on.
const ENV_TABLES = [
  "smrtbot_menu_nodes",
  "smrtbot_messages",
  "smrtbot_missions",
  "smrtbot_trivia",
  "smrtbot_holidays",
  "smrtbot_knowledge_base",
  "smrtbot_auto_messages",
] as const;

type Row = Record<string, unknown>;
const STRIP = new Set(["id", "created_at", "updated_at"]);

async function snapshot(table: string, orgId: string, botId: string, env: string): Promise<Row[]> {
  const { data, error } = await db.from(table).select("*").eq("org_id", orgId).eq("bot_id", botId).eq("env", env);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as Row[]) ?? [];
}

/** Replace all rows of `table` for (org,bot,env) with fresh copies of `rows`. */
async function replaceEnv(table: string, orgId: string, botId: string, env: string, rows: Row[]): Promise<void> {
  const { error: delErr } = await db.from(table).delete().eq("org_id", orgId).eq("bot_id", botId).eq("env", env);
  if (delErr) throw new Error(`${table} delete: ${delErr.message}`);
  if (!rows.length) return;
  const insert = rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (!STRIP.has(k)) out[k] = v;
    out.org_id = orgId;
    out.bot_id = botId;
    out.env = env;
    return out;
  });
  for (let i = 0; i < insert.length; i += 200) {
    const { error } = await db.from(table).insert(insert.slice(i, i + 200));
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

// ── publish test → live ─────────────────────────────────────
router.post("/bot/:botId/publish", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const botId = req.params.botId;
  try {
    const { data: last } = await db
      .from("smrtbot_publish_batches")
      .select("version")
      .eq("org_id", orgId).eq("bot_id", botId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    const version = ((last?.version as number) ?? 0) + 1;

    const snap: Record<string, Row[]> = {};
    for (const table of ENV_TABLES) {
      snap[table] = await snapshot(table, orgId, botId, "live"); // archive current live
      const testRows = await snapshot(table, orgId, botId, "test");
      await replaceEnv(table, orgId, botId, "live", testRows); // promote test → live
    }

    const { error: insErr } = await db.from("smrtbot_publish_batches").insert({
      org_id: orgId, bot_id: botId, version, status: "published",
      note: typeof req.body?.note === "string" ? req.body.note : null,
      published_by: req.user!.email ?? req.user!.id,
      tables_json: ENV_TABLES,
      changes_json: snap, // the pre-publish live snapshot, for rollback
    });
    if (insErr) throw new Error(insErr.message);
    res.json({ ok: true, version });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "publish failed" });
  }
});

// ── publish history ─────────────────────────────────────────
router.get("/bot/:botId/publish", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_publish_batches")
    .select("id, version, status, note, published_by, created_at")
    .eq("org_id", req.org!.id).eq("bot_id", req.params.botId)
    .order("version", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ batches: data ?? [] });
});

// ── rollback live to a batch's snapshot ─────────────────────
router.post("/bot/:botId/publish/:id/rollback", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const botId = req.params.botId;
  try {
    const { data: batch, error } = await db
      .from("smrtbot_publish_batches")
      .select("changes_json")
      .eq("org_id", orgId).eq("bot_id", botId).eq("id", req.params.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!batch) return res.status(404).json({ error: "batch not found" });
    const snap = (batch.changes_json as Record<string, Row[]>) ?? {};
    for (const table of ENV_TABLES) {
      await replaceEnv(table, orgId, botId, "live", snap[table] ?? []);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "rollback failed" });
  }
});

export default router;
