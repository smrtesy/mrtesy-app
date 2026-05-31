/**
 * Knowledge-base lookup & save.
 *
 * lookupKnowledge embeds an incoming question and returns the closest
 * previously-approved answer (if similar enough) so the draft model can reuse
 * it. saveKnowledge stores an approved question→answer pair with its embedding.
 *
 * Both no-op gracefully when VOYAGE_API_KEY is unset (embedText returns null).
 */

import { db } from "../db";
import { embedText } from "../services/voyage";

// Max cosine DISTANCE for a stored answer to count as "the same question".
// distance = 1 - similarity, so 0.18 ≈ 0.82 similarity. Deliberately strict:
// we only want to reuse an answer when the questions really match.
const MATCH_THRESHOLD = 0.18;

export interface KnowledgeMatch {
  id: string;
  question: string;
  answer: string;
  language: string | null;
  similarity: number;
}

/** Find the single best previously-approved answer for an incoming question. */
export async function lookupKnowledge(
  userId: string,
  questionText: string,
  refId?: string,
): Promise<KnowledgeMatch | null> {
  const embedding = await embedText(questionText, "query", { userId, refId });
  if (!embedding) return null;

  const { data, error } = await db.rpc("match_knowledge_base", {
    // pgvector casts the text form '[1,2,…]' to vector; a raw JS array binds as
    // a JSON array which has no cast to vector and would error.
    query_embedding: JSON.stringify(embedding),
    p_user_id: userId,
    match_threshold: MATCH_THRESHOLD,
    match_count: 1,
  });

  if (error || !data || data.length === 0) return null;
  return data[0] as KnowledgeMatch;
}

/**
 * Org-wide variant: find the best APPROVED answer across the whole organization.
 * This is what the draft pipeline uses now — a fact one teammate approved is
 * reusable by everyone in the org. Pending/rejected suggestions are excluded by
 * match_knowledge_base_org. No-ops (null) when Voyage is unconfigured.
 */
export async function lookupKnowledgeForOrg(
  orgId: string,
  questionText: string,
  meta?: { userId?: string; refId?: string },
): Promise<KnowledgeMatch | null> {
  const embedding = await embedText(questionText, "query", meta);
  if (!embedding) return null;

  const { data, error } = await db.rpc("match_knowledge_base_org", {
    query_embedding: JSON.stringify(embedding),
    p_org_id: orgId,
    match_threshold: MATCH_THRESHOLD,
    match_count: 1,
  });

  // A real RPC error (e.g. the match_knowledge_base_org migration not yet
  // applied) is otherwise invisible — drafts just silently stop reusing
  // knowledge. Log it so the cause is findable; still degrade to null.
  if (error) {
    console.error("[knowledge] match_knowledge_base_org failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return data[0] as KnowledgeMatch;
}

/**
 * Store a question→answer pair with its question embedding.
 *
 * Org-aware: the entry belongs to `organizationId` and starts in `status`
 * ('pending' for a member suggestion, 'approved' when a manager adds/approves
 * it directly). `createdBy` records the author; `approvedBy`/`approvedAt` are
 * set only when it lands approved.
 */
export async function saveKnowledge(opts: {
  userId: string;
  organizationId: string;
  question: string;
  answer: string;
  status: "pending" | "approved";
  createdBy: string;
  approvedBy?: string | null;
  sourceType?: string | null;
  language?: string | null;
  taskId?: string | null;
}): Promise<{ id: string } | { error: string }> {
  const question = opts.question.trim();
  const answer = opts.answer.trim();
  if (!question || !answer) return { error: "question and answer required" };

  const embedding = await embedText(question, "document", {
    userId: opts.userId,
    refId: opts.taskId ?? undefined,
  });
  if (!embedding) {
    return { error: "embedding_unavailable" };
  }

  const { data, error } = await db
    .from("knowledge_base")
    .insert({
      user_id: opts.userId,
      organization_id: opts.organizationId,
      question,
      answer,
      embedding: JSON.stringify(embedding),
      source_type: opts.sourceType ?? null,
      language: opts.language ?? null,
      task_id: opts.taskId ?? null,
      status: opts.status,
      created_by: opts.createdBy,
      approved_by: opts.status === "approved" ? (opts.approvedBy ?? opts.createdBy) : null,
      approved_at: opts.status === "approved" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };
  return { id: data.id };
}
