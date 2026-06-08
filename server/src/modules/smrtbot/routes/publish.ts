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

// ── diff helpers (what a publish changed; and pending test-vs-live) ──────────
const RESOURCE_OF: Record<string, string> = {
  smrtbot_menu_nodes: "menu",
  smrtbot_messages: "messages",
  smrtbot_missions: "missions",
  smrtbot_trivia: "trivia",
  smrtbot_holidays: "holidays",
  smrtbot_knowledge_base: "knowledge",
  smrtbot_auto_messages: "auto-messages",
};
const KEY_OF: Record<string, (r: Row) => string> = {
  smrtbot_menu_nodes: (r) => String(r.node_key),
  smrtbot_messages: (r) => String(r.msg_key),
  smrtbot_missions: (r) => String(r.mission_id),
  smrtbot_trivia: (r) => `${r.video_id}|${r.level}|${String(r.question ?? "").slice(0, 40)}`,
  smrtbot_holidays: (r) => String(r.holiday_name),
  smrtbot_knowledge_base: (r) => String(r.question_pattern),
  smrtbot_auto_messages: (r) => String(r.name),
};
const IGNORE_COLS = new Set(["id", "created_at", "updated_at", "org_id", "bot_id", "env", "version", "legacy_id"]);

function contentHash(r: Row): string {
  const o: Row = {};
  for (const k of Object.keys(r).sort()) if (!IGNORE_COLS.has(k)) o[k] = r[k];
  return JSON.stringify(o);
}

interface TableDiff { added: number; removed: number; updated: number }

function diffTable(table: string, oldRows: Row[], newRows: Row[]): TableDiff {
  const keyFn = KEY_OF[table] ?? contentHash;
  const oldMap = new Map(oldRows.map((r) => [keyFn(r), r]));
  const newMap = new Map(newRows.map((r) => [keyFn(r), r]));
  let added = 0, removed = 0, updated = 0;
  for (const [k, r] of newMap) {
    const prev = oldMap.get(k);
    if (!prev) added++;
    else if (contentHash(r) !== contentHash(prev)) updated++;
  }
  for (const k of oldMap.keys()) if (!newMap.has(k)) removed++;
  return { added, removed, updated };
}

/** Per-resource diff (only resources that actually changed). */
function diffSummary(oldByTable: Record<string, Row[]>, newByTable: Record<string, Row[]>): Record<string, TableDiff> {
  const out: Record<string, TableDiff> = {};
  for (const table of ENV_TABLES) {
    const d = diffTable(table, oldByTable[table] ?? [], newByTable[table] ?? []);
    if (d.added || d.removed || d.updated) out[RESOURCE_OF[table]] = d;
  }
  return out;
}

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

    // Snapshot ALL live tables BEFORE any mutation — this is both the archive
    // (for rollback) and the recovery point if a promote fails mid-way.
    const snap: Record<string, Row[]> = {};
    for (const table of ENV_TABLES) snap[table] = await snapshot(table, orgId, botId, "live");

    // Promote test → live. supabase-js has no multi-statement transaction, so
    // on any failure we restore the full pre-publish live snapshot rather than
    // leave a table deleted-but-not-repopulated.
    const newLive: Record<string, Row[]> = {};
    try {
      for (const table of ENV_TABLES) {
        const testRows = await snapshot(table, orgId, botId, "test");
        newLive[table] = testRows;
        await replaceEnv(table, orgId, botId, "live", testRows);
      }
    } catch (promoteErr) {
      for (const table of ENV_TABLES) {
        try { await replaceEnv(table, orgId, botId, "live", snap[table]); } catch { /* best-effort restore */ }
      }
      throw promoteErr;
    }

    // What this publish actually changed (old live → new live), for the history.
    const summary = diffSummary(snap, newLive);

    const { error: insErr } = await db.from("smrtbot_publish_batches").insert({
      org_id: orgId, bot_id: botId, version, status: "published",
      note: typeof req.body?.note === "string" ? req.body.note : null,
      published_by: req.user!.email ?? req.user!.id,
      tables_json: ENV_TABLES,
      changes_json: snap, // the pre-publish live snapshot, for rollback
      summary_json: summary,
    });
    if (insErr) throw new Error(insErr.message);
    res.json({ ok: true, version });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "publish failed" });
  }
});

// ── publish history ─────────────────────────────────────────
router.get("/bot/:botId/publish", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const botId = req.params.botId;
  const { data, error } = await db
    .from("smrtbot_publish_batches")
    .select("id, version, status, note, published_by, created_at, summary_json")
    .eq("org_id", orgId).eq("bot_id", botId)
    .order("version", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Pending = what's in test but not yet published to live.
  let pending: Record<string, TableDiff> = {};
  try {
    const live: Record<string, Row[]> = {};
    const test: Record<string, Row[]> = {};
    for (const table of ENV_TABLES) {
      live[table] = await snapshot(table, orgId, botId, "live");
      test[table] = await snapshot(table, orgId, botId, "test");
    }
    pending = diffSummary(live, test);
  } catch { /* pending is best-effort */ }

  res.json({ batches: data ?? [], pending });
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
    // Recovery point: capture current live before overwriting it.
    const current: Record<string, Row[]> = {};
    for (const table of ENV_TABLES) current[table] = await snapshot(table, orgId, botId, "live");
    try {
      for (const table of ENV_TABLES) await replaceEnv(table, orgId, botId, "live", snap[table] ?? []);
    } catch (rbErr) {
      for (const table of ENV_TABLES) {
        try { await replaceEnv(table, orgId, botId, "live", current[table]); } catch { /* best-effort restore */ }
      }
      throw rbErr;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "rollback failed" });
  }
});

export default router;
