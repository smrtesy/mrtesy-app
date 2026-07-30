/**
 * Global search routes (platform, cross-app).
 *
 *   GET  /search?q=...        hybrid search across destinations / content / Claude,
 *                             grouped, with an answer for the content group.
 *   POST /search/reindex      (super-admin) rebuild the search index for the caller.
 *
 * Retrieval is hybrid: the query is embedded (Voyage) and matched by meaning,
 * while match_search_documents also scores trgm text similarity so an exact
 * entity ("שפרה") pins the right rows. The content group additionally gets an
 * answer synthesized on the subscription (answerFromSources) — free, and always
 * alongside the source rows for verification.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, isSuperAdmin } from "../../../middleware";
import { embedText } from "../../../services/voyage";
import { DESTINATIONS } from "./destinations";
import { reindexForCaller } from "./indexer";
import { answerFromSources, type AnswerSource } from "./answer";

const router = Router();

const ADMIN_ONLY_PATHS = new Set(DESTINATIONS.filter((d) => d.adminOnly).map((d) => d.path));

interface MatchRow {
  id: string;
  source_type: "destination" | "task" | "suggestion" | "info" | "claude_thread";
  source_id: string;
  title: string;
  snippet: string | null;
  url: string;
  language: string | null;
  vec_sim: number;
  txt_sim: number;
  score: number;
}

interface ResultItem {
  title: string;
  snippet: string | null;
  url: string;
  source_type: string;
  score: number;
}

function toItem(r: MatchRow): ResultItem {
  return { title: r.title, snippet: r.snippet, url: r.url, source_type: r.source_type, score: r.score };
}

// ── GET /search ──────────────────────────────────────────────────────────────
const EMPTY_SEARCH = { query: "", answer: null, groups: { settings: [], content: [], claude: [] } };

router.get("/search", requireAuth, requireOrg, async (req: Request, res: Response) => {
 try {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    return res.json({ query: "", answer: null, groups: { settings: [], content: [], claude: [] } });
  }

  const orgId = req.org!.id;
  const userId = req.user!.id;

  const embedding = await embedText(q, "query", { userId });
  if (!embedding) {
    // Voyage unavailable → degrade to a text-only lookup so search still works.
    const { data, error } = await db
      .from("search_documents")
      .select("id, source_type, source_id, title, snippet, url, language, org_id, user_id")
      // Mirror match_search_documents' scoping EXACTLY: a global row needs BOTH
      // org_id AND user_id null (destinations) — `org_id.is.null` alone would
      // match every user's personal task/info rows (indexed with org_id null,
      // user_id = owner) and leak them across users.
      .or(
        `and(org_id.is.null,user_id.is.null),user_id.eq.${userId},and(org_id.eq.${orgId},user_id.is.null)`,
      )
      .ilike("keywords", `%${q}%`)
      .limit(24);
    if (error) {
      console.error("[search] text-only fallback failed:", error.message);
      return res.status(500).json({ error: "search failed" });
    }
    const rows: MatchRow[] = ((data ?? []) as Omit<MatchRow, "vec_sim" | "txt_sim" | "score">[]).map(
      (r) => ({ ...r, vec_sim: 0, txt_sim: 1, score: 1 }),
    );
    return res.json(groupAndAnswer(q, rows, await isSuperAdmin(req.user!), false));
  }

  const { data, error } = await db.rpc("match_search_documents", {
    query_embedding: JSON.stringify(embedding),
    query_text: q,
    p_org_id: orgId,
    p_user_id: userId,
  });
  if (error) {
    console.error("[search] match_search_documents failed:", error.message);
    return res.status(500).json({ error: "search failed" });
  }

  const payload = await groupAndAnswer(q, (data ?? []) as MatchRow[], await isSuperAdmin(req.user!), true);
  return res.json(payload);
 } catch (e) {
  // Never let the search crash into a 500 the frontend renders as "no results" —
  // degrade to an empty result set instead.
  console.error("[search] handler error:", (e as Error).message);
  return res.status(200).json(EMPTY_SEARCH);
 }
});

/** Group rows into the three display buckets, drop admin-only destinations for
 *  non-admins, and synthesize an answer for the content group. */
async function groupAndAnswer(
  query: string,
  rows: MatchRow[],
  admin: boolean,
  withAnswer: boolean,
) {
  const visible = rows.filter(
    (r) => !(r.source_type === "destination" && ADMIN_ONLY_PATHS.has(r.source_id) && !admin),
  );

  const settings = visible.filter((r) => r.source_type === "destination").map(toItem);
  const contentRows = visible.filter(
    (r) => r.source_type === "task" || r.source_type === "suggestion" || r.source_type === "info",
  );
  const content = contentRows.map(toItem);
  const claude = visible.filter((r) => r.source_type === "claude_thread").map(toItem);

  // The answer layer (runOneShot) spawns a subscription process and can take many
  // seconds — it must NEVER block or break the search response. Bound it hard and
  // swallow any failure: results always come back fast; the answer is a bonus that
  // appears only when it's quick.
  let answer: string | null = null;
  if (withAnswer && contentRows.length > 0) {
    const sources: AnswerSource[] = contentRows
      .slice(0, 5)
      .map((r, i) => ({ n: i + 1, title: r.title, snippet: r.snippet }));
    answer = await Promise.race([
      answerFromSources(query, sources).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
  }

  return { query, answer, groups: { settings, content, claude } };
}

// ── POST /search/reindex (super-admin) ───────────────────────────────────────
router.post("/search/reindex", requireAuth, requireOrg, async (req: Request, res: Response) => {
  if (!(await isSuperAdmin(req.user!))) {
    return res.status(403).json({ error: "super admin only" });
  }
  const capRaw = (req.body ?? {}).cap;
  const cap = typeof capRaw === "number" && capRaw > 0 && capRaw <= 5000 ? capRaw : undefined;

  const result = await reindexForCaller(req.org!.id, req.user!.id, cap);
  return res.json({ ok: true, indexed: result });
});

export default router;
