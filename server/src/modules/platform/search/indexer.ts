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
import { embedText, embedTexts } from "../../../services/voyage";
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

// "upserted"    — row written with its embedding (or none was needed).
// "embed_failed" — Voyage is configured but the call came back null (transient):
//                  the row IS written (text search still works) but the caller
//                  should RETRY later so it gets a real embedding, rather than
//                  being left unsearchable-by-meaning forever.
// "error"        — the DB upsert itself failed.
export type UpsertResult = "upserted" | "embed_failed" | "error";

/** Embed the row's searchable text and upsert on (source_type, source_id). */
async function upsertDoc(input: SearchDocInput, userIdForUsage?: string): Promise<UpsertResult> {
  const voyageConfigured = !!process.env.VOYAGE_API_KEY;
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
    return "error";
  }
  // Voyage configured + real text to embed + null back = transient failure → retry.
  // (Voyage NOT configured → embedding is expected-null and permanent; don't retry
  //  or the incremental queue would grow unbounded while the feature is off.)
  if (voyageConfigured && text && !embedding) return "embed_failed";
  return "upserted";
}

// ── Row → SearchDocInput builders (shared by single-row + batch indexers) ─────
// One place per source type maps a fetched DB row to its search document, so the
// single-row and batched paths can never drift.

interface TaskRow {
  id: string;
  user_id: string | null;
  title: string | null;
  title_he: string | null;
  description: string | null;
  serial_display: string | null;
}
interface MsgRow {
  id: string;
  user_id: string | null;
  source_type: string | null;
  subject: string | null;
  body_text: string | null;
  source_url: string | null;
  sender: string | null;
  sender_email: string | null;
  sender_phone: string | null;
}

// WhatsApp/SMS have no useful external URL — route them to their in-app screen
// so a result opens inside smrtesy, not out to a dead link. Email/Drive/Calendar
// keep their deep external source_url.
function msgUrl(m: MsgRow): string {
  const st = m.source_type ?? "";
  if (st === "whatsapp" || st === "whatsapp_echo") return "/whatsapp";
  if (st === "sms" || st === "sms_echo") return "/sms";
  return m.source_url || "/info";
}
interface ThreadRow {
  id: string;
  org_id: string | null;
  title: string | null;
}

function taskInput(t: TaskRow): SearchDocInput {
  return {
    org_id: null,
    user_id: t.user_id,
    source_type: "task",
    source_id: t.id,
    title: t.title_he?.trim() || t.title?.trim() || "משימה",
    snippet: t.description ? t.description.slice(0, 300) : null,
    url: `/tasks?focus=${t.id}`,
    keywords: [t.title, t.title_he, t.serial_display].filter(Boolean).join(" ") || null,
    language: null,
  };
}
function msgInput(m: MsgRow): SearchDocInput {
  return {
    org_id: null,
    user_id: m.user_id,
    source_type: "info",
    source_id: m.id,
    title: m.subject?.trim() || m.sender?.trim() || "הודעה",
    snippet: m.body_text ? m.body_text.slice(0, 300) : null,
    url: msgUrl(m),
    keywords:
      [m.sender, m.sender_email, m.sender_phone, m.subject].filter(Boolean).join(" ") || null,
    language: null,
  };
}
function threadInput(th: ThreadRow): SearchDocInput {
  const title = th.title?.trim() || "שיחת קלוד";
  return {
    org_id: th.org_id,
    user_id: null,
    source_type: "claude_thread",
    source_id: th.id,
    title,
    snippet: null,
    url: `/claude?thread=${th.id}`,
    keywords: title,
    language: null,
  };
}

/** The text a document is embedded on. */
function docText(i: SearchDocInput): string {
  return [i.title, i.snippet ?? "", i.keywords ?? ""].join(" ").trim();
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
    if (ok !== "error") n++;
  }
  return n;
}

/** Index the caller's tasks (owner-scoped). */
export async function indexTasksForUser(userId: string, cap = DEFAULT_CAP): Promise<number> {
  const { data, error } = await db
    .from("tasks")
    .select("id, user_id, title, title_he, description, serial_display")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(cap);
  if (error) {
    console.error("[search/indexer] load tasks failed:", error.message);
    return 0;
  }

  let n = 0;
  for (const t of (data ?? []) as unknown as TaskRow[]) {
    const ok = await upsertDoc(taskInput(t), userId);
    if (ok !== "error") n++;
  }
  return n;
}

/** Index the caller's raw source messages as the "info" corpus (owner-scoped). */
export async function indexInfoForUser(userId: string, cap = DEFAULT_CAP): Promise<number> {
  const { data, error } = await db
    .from("source_messages")
    .select("id, user_id, source_type, subject, body_text, source_url, sender, sender_email, sender_phone")
    .eq("user_id", userId)
    .order("received_at", { ascending: false })
    .limit(cap);
  if (error) {
    console.error("[search/indexer] load source_messages failed:", error.message);
    return 0;
  }

  let n = 0;
  for (const m of (data ?? []) as unknown as MsgRow[]) {
    const ok = await upsertDoc(msgInput(m), userId);
    if (ok !== "error") n++;
  }
  return n;
}

/** Index the org's Claude console threads (org-scoped). */
export async function indexClaudeThreadsForOrg(orgId: string, cap = DEFAULT_CAP): Promise<number> {
  const { data, error } = await db
    .from("claude_threads")
    .select("id, org_id, title")
    .eq("org_id", orgId)
    .order("last_message_at", { ascending: false })
    .limit(cap);
  if (error) {
    console.error("[search/indexer] load claude_threads failed:", error.message);
    return 0;
  }

  let n = 0;
  for (const th of (data ?? []) as unknown as ThreadRow[]) {
    const ok = await upsertDoc(threadInput(th));
    if (ok !== "error") n++;
  }
  return n;
}

// ── Batch indexer (used by the incremental drain worker) ─────────────────────
// Indexes a batch of queued items in ONE Voyage request (embedTexts), so a bulk
// pass costs ~1 request per batch instead of one per item — minutes vs days when
// Voyage is rate-limited. Per item it returns:
//   "upserted"     — indexed with (or legitimately without) an embedding
//   "embed_failed" — Voyage configured but returned null for this one → retry
//   "missing"      — source row gone → clear from the queue
//   "error"        — the fetch/upsert failed → retry

export type IndexOneResult = "upserted" | "embed_failed" | "missing" | "error";

interface BatchItem {
  source_type: string;
  source_id: string;
}

const SOURCE_TABLE: Record<string, string> = {
  task: "tasks",
  info: "source_messages",
  claude_thread: "claude_threads",
};
const SOURCE_SELECT: Record<string, string> = {
  task: "id, user_id, title, title_he, description, serial_display",
  info: "id, user_id, source_type, subject, body_text, source_url, sender, sender_email, sender_phone",
  claude_thread: "id, org_id, title",
};

function inputForRow(sourceType: string, row: Record<string, unknown>): SearchDocInput | null {
  if (sourceType === "task") return taskInput(row as unknown as TaskRow);
  if (sourceType === "info") return msgInput(row as unknown as MsgRow);
  if (sourceType === "claude_thread") return threadInput(row as unknown as ThreadRow);
  return null;
}

/** Index a batch of (source_type, source_id) items. Returns a per-item result
 *  keyed by `${source_type}:${source_id}`. */
export async function indexBatch(items: BatchItem[]): Promise<Map<string, IndexOneResult>> {
  const out = new Map<string, IndexOneResult>();
  const key = (t: string, i: string) => `${t}:${i}`;
  if (items.length === 0) return out;

  // Group ids by source type.
  const idsByType: Record<string, string[]> = {};
  for (const it of items) (idsByType[it.source_type] ??= []).push(it.source_id);

  // Fetch rows per type, build the inputs to embed.
  const inputs: SearchDocInput[] = [];
  const inputKeys: string[] = [];
  for (const [type, ids] of Object.entries(idsByType)) {
    const table = SOURCE_TABLE[type];
    if (!table) {
      for (const id of ids) out.set(key(type, id), "missing"); // unknown type → drop
      continue;
    }
    const { data, error } = await db.from(table).select(SOURCE_SELECT[type]).in("id", ids);
    if (error) {
      console.error("[search/indexer] batch load failed:", type, error.message);
      for (const id of ids) out.set(key(type, id), "error"); // retry next drain
      continue;
    }
    const found = new Map<string, Record<string, unknown>>();
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) found.set(String(r.id), r);
    for (const id of ids) {
      const row = found.get(id);
      if (!row) {
        out.set(key(type, id), "missing");
        continue;
      }
      const input = inputForRow(type, row);
      if (!input) {
        out.set(key(type, id), "missing");
        continue;
      }
      inputs.push(input);
      inputKeys.push(key(type, id));
    }
  }
  if (inputs.length === 0) return out;

  // ONE Voyage request for the whole batch.
  const voyageConfigured = !!process.env.VOYAGE_API_KEY;
  const embeddings = await embedTexts(inputs.map(docText), "document");

  // ONE upsert for the whole batch.
  const now = new Date().toISOString();
  const rows = inputs.map((inp, k) => ({
    ...inp,
    embedding: embeddings[k] ? JSON.stringify(embeddings[k]) : null,
    updated_at: now,
  }));
  const classify = (k: number): IndexOneResult => {
    const embedded = !!embeddings[k];
    const hasText = docText(inputs[k]).length > 0;
    return voyageConfigured && hasText && !embedded ? "embed_failed" : "upserted";
  };

  const { error: upErr } = await db
    .from("search_documents")
    .upsert(rows, { onConflict: "source_type,source_id" });
  if (!upErr) {
    inputs.forEach((_, k) => out.set(inputKeys[k], classify(k)));
    return out;
  }

  // Batch upsert failed — fall back to per-row so ONE bad row can't block the
  // whole chunk (and, drained oldest-first, the entire backlog behind it).
  console.error("[search/indexer] batch upsert failed, retrying per-row:", upErr.message);
  for (let k = 0; k < rows.length; k++) {
    const { error: rowErr } = await db
      .from("search_documents")
      .upsert(rows[k], { onConflict: "source_type,source_id" });
    out.set(inputKeys[k], rowErr ? "error" : classify(k));
  }
  return out;
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

/**
 * Seed the navigation destinations at boot, so settings/pages search works
 * immediately after a deploy without a manual reindex. Idempotent and cheap
 * (~30 rows); skipped when already seeded (row count >= DESTINATIONS.length) so
 * a normal restart re-embeds nothing. Fire-and-forget — never blocks startup.
 */
export async function ensureDestinationsIndexed(): Promise<void> {
  const { count, error } = await db
    .from("search_documents")
    .select("id", { count: "exact", head: true })
    .eq("source_type", "destination");
  if (error) {
    console.error("[search/indexer] destination count failed:", error.message);
    return;
  }
  if ((count ?? 0) >= DESTINATIONS.length) return; // already seeded
  const n = await indexDestinations();
  console.log(`[search/indexer] seeded ${n} navigation destinations.`);
}

export interface BackfillResult {
  destinations: number;
  users: number;
  orgs: number;
  tasks: number;
  info: number;
  claudeThreads: number;
}

/**
 * One-time history seed for the WHOLE instance (machine-triggered, cron-secret):
 * destinations + every user's tasks/info + every org's Claude threads. Bounded
 * per corpus by `cap`. After this, the DB triggers keep everything fresh, so
 * this only needs running once (or after raising the cap).
 */
export async function backfillAll(cap = DEFAULT_CAP): Promise<BackfillResult> {
  const result: BackfillResult = {
    destinations: 0,
    users: 0,
    orgs: 0,
    tasks: 0,
    info: 0,
    claudeThreads: 0,
  };

  result.destinations = await indexDestinations();

  // Users → their tasks/info. listUsers is the repo's proven enumeration.
  try {
    const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
    if (error) {
      console.error("[search/indexer] backfill listUsers failed:", error.message);
    } else {
      for (const u of data.users) {
        result.users++;
        result.tasks += await indexTasksForUser(u.id, cap);
        result.info += await indexInfoForUser(u.id, cap);
      }
    }
  } catch (e) {
    console.error("[search/indexer] backfill users failed:", (e as Error).message);
  }

  // Orgs → their Claude threads.
  const { data: orgs, error: orgErr } = await db.from("organizations").select("id");
  if (orgErr) {
    console.error("[search/indexer] backfill load orgs failed:", orgErr.message);
  } else {
    for (const o of (orgs ?? []) as { id: string }[]) {
      result.orgs++;
      result.claudeThreads += await indexClaudeThreadsForOrg(o.id, cap);
    }
  }

  return result;
}
