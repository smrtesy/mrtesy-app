/**
 * Global-search indexer — turns each searchable surface into search_documents
 * rows with a Voyage embedding, so match_search_documents can find them.
 *
 * Corpora:
 *   • destination   — the curated nav list (DESTINATIONS), global (no org/user).
 *   • task          — tasks, scoped to their owner (user_id).
 *   • info          — raw source_messages, scoped to their owner (user_id).
 *   • claude_thread — Claude console threads, scoped to their org.
 *
 * Cost: embedding is Voyage (paid, but first 200M tokens/account are free —
 * effectively $0). Each corpus is CAPPED per run (DEFAULT_CAP) so a reindex is
 * bounded in time and spend; raise the cap or re-run to cover more. Rows with no
 * embedding (Voyage unavailable) are still upserted — match just skips them.
 */

import { db } from "../../../db";
import { embedText } from "../../../services/voyage";
import { DESTINATIONS } from "./destinations";

const DEFAULT_CAP = 500;

export interface SearchDocInput {
  org_id: string | null;
  user_id: string | null;
  source_type: "destination" | "task" | "suggestion" | "info" | "claude_thread";
  source_id: string;
  title: string;
  snippet: string | null;
  url: string;
  keywords: string | null;
  language: string | null;
}

/** Embed the row's searchable text and upsert on (source_type, source_id). */
async function upsertDoc(input: SearchDocInput, userIdForUsage?: string): Promise<boolean> {
  const text = [input.title, input.snippet ?? "", input.keywords ?? ""].join(" ").trim();
  const embedding = text
    ? await embedText(text, "document", { userId: userIdForUsage, refId: input.source_id })
    : null;

  const { error } = await db.from("search_documents").upsert(
    {
      org_id: input.org_id,
      user_id: input.user_id,
      source_type: input.source_type,
      source_id: input.source_id,
      title: input.title,
      snippet: input.snippet,
      url: input.url,
      keywords: input.keywords,
      language: input.language,
      // pgvector casts the text form '[1,2,…]'; a raw JS array has no vector cast.
      embedding: embedding ? JSON.stringify(embedding) : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source_type,source_id" },
  );

  if (error) {
    console.error("[search/indexer] upsert failed:", input.source_type, input.source_id, error.message);
    return false;
  }
  return true;
}

/** Index the curated navigation destinations (global rows). */
export async function indexDestinations(): Promise<number> {
  let n = 0;
  for (const d of DESTINATIONS) {
    const ok = await upsertDoc({
      org_id: null,
      user_id: null,
      source_type: "destination",
      source_id: d.path,
      title: d.titleHe,
      snippet: d.titleEn,
      url: d.path,
      keywords: `${d.titleHe} ${d.titleEn} ${d.keywords}`,
      language: "he",
    });
    if (ok) n++;
  }
  return n;
}

/** Index the caller's tasks (owner-scoped). */
export async function indexTasksForUser(userId: string, cap = DEFAULT_CAP): Promise<number> {
  const { data, error } = await db
    .from("tasks")
    .select("id, title, title_he, description, serial_display")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(cap);
  if (error) {
    console.error("[search/indexer] load tasks failed:", error.message);
    return 0;
  }

  let n = 0;
  for (const t of data ?? []) {
    const row = t as {
      id: string;
      title: string | null;
      title_he: string | null;
      description: string | null;
      serial_display: string | null;
    };
    const title = (row.title_he || row.title || "משימה").trim();
    const ok = await upsertDoc(
      {
        org_id: null,
        user_id: userId,
        source_type: "task",
        source_id: row.id,
        title,
        snippet: row.description ? row.description.slice(0, 300) : null,
        url: `/tasks?focus=${row.id}`,
        keywords: [row.title, row.title_he, row.serial_display].filter(Boolean).join(" ") || null,
        language: null,
      },
      userId,
    );
    if (ok) n++;
  }
  return n;
}

/** Index the caller's raw source messages as the "info" corpus (owner-scoped). */
export async function indexInfoForUser(userId: string, cap = DEFAULT_CAP): Promise<number> {
  const { data, error } = await db
    .from("source_messages")
    .select("id, subject, body_text, source_url, sender, sender_email, sender_phone")
    .eq("user_id", userId)
    .order("received_at", { ascending: false })
    .limit(cap);
  if (error) {
    console.error("[search/indexer] load source_messages failed:", error.message);
    return 0;
  }

  let n = 0;
  for (const m of data ?? []) {
    const row = m as {
      id: string;
      subject: string | null;
      body_text: string | null;
      source_url: string | null;
      sender: string | null;
      sender_email: string | null;
      sender_phone: string | null;
    };
    const title = (row.subject || row.sender || "הודעה").trim();
    const ok = await upsertDoc(
      {
        org_id: null,
        user_id: userId,
        source_type: "info",
        source_id: row.id,
        title,
        snippet: row.body_text ? row.body_text.slice(0, 300) : null,
        // Fall back to the info center if the message has no deep source URL.
        url: row.source_url || "/info",
        keywords: [row.sender, row.sender_email, row.sender_phone, row.subject]
          .filter(Boolean)
          .join(" ") || null,
        language: null,
      },
      userId,
    );
    if (ok) n++;
  }
  return n;
}

/** Index the org's Claude console threads (org-scoped). */
export async function indexClaudeThreadsForOrg(orgId: string, cap = DEFAULT_CAP): Promise<number> {
  const { data, error } = await db
    .from("claude_threads")
    .select("id, title")
    .eq("org_id", orgId)
    .order("last_message_at", { ascending: false })
    .limit(cap);
  if (error) {
    console.error("[search/indexer] load claude_threads failed:", error.message);
    return 0;
  }

  let n = 0;
  for (const th of data ?? []) {
    const row = th as { id: string; title: string | null };
    const title = (row.title || "שיחת קלוד").trim();
    const ok = await upsertDoc({
      org_id: orgId,
      user_id: null,
      source_type: "claude_thread",
      source_id: row.id,
      title,
      snippet: null,
      url: `/claude?thread=${row.id}`,
      keywords: title,
      language: null,
    });
    if (ok) n++;
  }
  return n;
}

export interface ReindexResult {
  destinations: number;
  tasks: number;
  info: number;
  claudeThreads: number;
}

/**
 * Reindex everything visible to one caller: the global destinations, plus the
 * caller's own tasks/info and their org's Claude threads. Capped per corpus.
 */
export async function reindexForCaller(
  orgId: string,
  userId: string,
  cap = DEFAULT_CAP,
): Promise<ReindexResult> {
  const destinations = await indexDestinations();
  const tasks = await indexTasksForUser(userId, cap);
  const info = await indexInfoForUser(userId, cap);
  const claudeThreads = await indexClaudeThreadsForOrg(orgId, cap);
  return { destinations, tasks, info, claudeThreads };
}
