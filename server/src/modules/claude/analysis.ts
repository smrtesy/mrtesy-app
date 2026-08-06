/**
 * Split and group — the analysis engine behind
 * docs/claude-console/threads-split-and-group-plan.md.
 *
 * Every function here reasons about a conversation by running a SHORT prompt on the
 * subscription (runOneShot) — no paid API tokens, same as the title run. The output
 * is validated as JSON and stored; nothing here acts on a proposal. Applying a split
 * or a grouping is a separate, user-approved step (applySplit / the group run writes
 * assignments the user can override).
 *
 * WHY PROPOSE-THEN-APPLY (plan §4, decision §8.2): a split moves turns and mints new
 * threads. Doing that straight off a model's say-so is exactly the "a model may
 * propose; only code may confirm" trap in CLAUDE.md — so the model only proposes
 * (which turns, what handover text), the user reads and approves, and code does the
 * move. Nothing the user can't cheaply undo happens without their click.
 */

import { db } from "../../db";
import { runAnalysisOneShot, BG_MODEL_STRONG } from "./runner";

/** A single topic the split analysis found inside a wandering thread. */
export interface SplitTopic {
  title: string;
  /** 1-based turn indexes that belong to this topic. */
  turn_indexes: number[];
  /** The exact text handed to the new chat under method B — what the user reviews. */
  handover: string;
  reason: string;
}

/** Parse the first JSON object out of a model reply, tolerating a stray sentence or
 *  a ```json fence around it. Returns null rather than throwing — a malformed
 *  analysis is a no-op, never a crash. */
function parseJsonReply(raw: string | null): unknown {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface TurnRow {
  id: string;
  turn_index: number;
  user_prompt: string | null;
  result_summary: string | null;
}

/** The turns of a thread, oldest first, capped — an analysis reads the shape of the
 *  conversation, not every token of it. */
async function loadTurns(threadId: string, cap = 40): Promise<TurnRow[]> {
  const { data, error } = await db
    .from("claude_runs")
    .select("id, turn_index, user_prompt, result_summary")
    .eq("thread_id", threadId)
    .is("moved_to_thread_id", null) // already-moved turns are not candidates again
    .order("turn_index", { ascending: true })
    .limit(cap);
  if (error) {
    console.error("[claude/analysis] loadTurns failed:", error.message);
    return [];
  }
  return (data ?? []) as TurnRow[];
}

function transcriptOf(turns: TurnRow[]): string {
  return turns
    .map((t) => {
      const q = (t.user_prompt ?? "").slice(0, 800);
      const a = (t.result_summary ?? "").slice(0, 800);
      return `## תור ${t.turn_index}\nמשתמש: ${q}\nקלוד: ${a}`;
    })
    .join("\n\n");
}

/**
 * Analyse a thread for splittable topics and store a proposal.
 *
 * Returns the analysis row (kind='split', status='proposed'), or null when the model
 * found nothing worth splitting — the caller distinguishes "no split needed" from a
 * failure by the null.
 *
 * Supersedes any earlier open split proposal for the thread, so the screen never
 * shows two competing proposals for the same conversation.
 */
export async function runSplitAnalysis(
  threadId: string,
  orgId: string,
  userId: string | null,
): Promise<{ id: string; proposal: unknown } | null> {
  const turns = await loadTurns(threadId);
  // Nothing to split below a handful of turns — cheaper to answer here than to spend
  // a run proving it.
  if (turns.length < 4) return null;

  // The TRUE, uncapped count of non-moved turns — what markAnalyzed must record.
  // loadTurns caps at 40, so turns.length saturates there; using it would freeze
  // analyzed_turn_count at 40 while the gate's own count keeps climbing, and the gate
  // (count - analyzed >= 4) would then fire on EVERY turn past 44. Same saturation
  // trap the title .limit(12) had.
  const { count: trueCount } = await db
    .from("claude_runs")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId)
    .is("moved_to_thread_id", null);
  // Marked on EVERY exit from here on — including a null/unparseable model reply —
  // so a failed analysis (timeout, usage-window exhaustion, prose instead of JSON)
  // advances the gate instead of re-firing a run on every subsequent turn.
  const advanceGate = () => markAnalyzed(threadId, trueCount ?? turns.length);

  const prompt = [
    "להלן תמליל שיחה שהתחילה בנושא אחד ואולי נדדה לכמה נושאים נפרדים.",
    "המשימה: לזהות אם יש בה יותר מנושא אחד שראוי לפצל לצ'אט נפרד.",
    "",
    "החזר JSON בלבד, בדיוק במבנה:",
    '{ "topics": [ { "title": "<כותרת קצרה בעברית>", "turn_indexes": [1,2],',
    '  "handover": "<פסקה שמסבירה לצ\'אט החדש על מה הנושא הזה ומה כבר סוכם>",',
    '  "reason": "<למה זה נושא נפרד>" } ], "confidence": 0.0 }',
    "",
    "חוקים:",
    "- אם השיחה עוסקת בנושא אחד בלבד — החזר topics ריק. אל תמציא פיצול.",
    "- turn_indexes הם מספרי התורים (המספר אחרי 'תור') ששייכים לנושא.",
    "- handover נכתב בגוף שני לצ'אט החדש, בעברית, ומכיל רק את המידע של הנושא הזה.",
    "- כל טקסט חופשי אסור מחוץ ל-JSON.",
    "",
    transcriptOf(turns),
  ].join("\n");

  // The split only PROPOSES — applySplit is a separate, user-approved step (file
  // header) — so it runs on the SAME model the thread is open on (the user's choice,
  // decision 2026-08) rather than a pinned strong model. The human approval gate is
  // what holds the "model proposes, code confirms" line here, not a forced model.
  // thread.model null → runOneShot passes no --model → the engine's default, which is
  // exactly what the thread's own turns run on. Runs on the automation account so it
  // never eats the interactive window — but runAnalysisOneShot fails over to this
  // thread's own account (then primary / any free one) when automation is exhausted or
  // hits its limit mid-call, so an exhausted automation account can't dead-end this
  // user-triggered analysis.
  const { data: splitThread } = await db
    .from("claude_threads")
    .select("model, claude_account")
    .eq("id", threadId)
    .maybeSingle();
  const reply = await runAnalysisOneShot(
    prompt,
    { timeoutMs: 120_000, model: splitThread?.model ?? undefined, label: "split-analysis" },
    splitThread?.claude_account,
  );
  const parsed = parseJsonReply(reply) as { topics?: unknown; confidence?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.topics)) {
    await advanceGate();
    return null;
  }

  // Keep only well-formed topics whose turn indexes actually exist in the thread —
  // a hallucinated turn number must never reach the apply step.
  const validIndexes = new Set(turns.map((t) => t.turn_index));
  const topics: SplitTopic[] = [];
  for (const raw of parsed.topics as Record<string, unknown>[]) {
    const title = typeof raw?.title === "string" ? raw.title.trim().slice(0, 200) : "";
    const handover = typeof raw?.handover === "string" ? raw.handover.trim().slice(0, 8000) : "";
    const reason = typeof raw?.reason === "string" ? raw.reason.trim().slice(0, 1000) : "";
    const idxs = Array.isArray(raw?.turn_indexes)
      ? (raw.turn_indexes as unknown[])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && validIndexes.has(n))
      : [];
    if (title && idxs.length > 0) topics.push({ title, turn_indexes: idxs, handover, reason });
  }

  // Fewer than two topics means there is nothing to separate — record nothing.
  if (topics.length < 2) {
    await advanceGate();
    return null;
  }

  // Supersede the previous open proposal before inserting the new one.
  await db
    .from("claude_thread_analyses")
    .update({ status: "superseded", decided_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("kind", "split")
    .eq("status", "proposed");

  const proposal = { topics, confidence: Number(parsed.confidence) || null };
  const { data, error } = await db
    .from("claude_thread_analyses")
    .insert({
      org_id: orgId,
      thread_id: threadId,
      kind: "split",
      proposal,
      status: "proposed",
      created_by: userId,
    })
    .select("id, proposal")
    .single();

  await advanceGate();

  if (error) {
    console.error("[claude/analysis] split insert failed:", error.message);
    return null;
  }
  return data;
}

/** Record that the thread has been analysed at its current length, so the gate
 *  (plan §5) doesn't re-run until it has grown enough again. */
async function markAnalyzed(threadId: string, turnCount: number): Promise<void> {
  const { error } = await db
    .from("claude_threads")
    .update({ analyzed_at: new Date().toISOString(), analyzed_turn_count: turnCount })
    .eq("id", threadId);
  if (error) console.error("[claude/analysis] markAnalyzed failed:", error.message);
}

/**
 * Apply a user-approved split: for each selected topic, create a child thread and
 * mark its turns as moved on the parent.
 *
 * `method` is per the locked decision (§8.1): 'summary' (default) seeds the child
 * with the handover text only; 'fork' resumes the parent's engine session so the
 * child inherits the whole conversation. Method 'fork' is only possible once the
 * parent actually has a session id.
 *
 * NON-DESTRUCTIVE: the parent's turns are not deleted, only stamped
 * moved_to_thread_id. Undo is clearing that column.
 */
export async function applySplit(params: {
  parentThreadId: string;
  orgId: string;
  userId: string | null;
  analysisId: string | null;
  selections: { title: string; turn_indexes: number[]; handover: string; method: "summary" | "fork" }[];
}): Promise<{ children: { id: string; title: string }[] }> {
  const { parentThreadId, orgId, userId, analysisId, selections } = params;

  const { data: parent, error: pErr } = await db
    .from("claude_threads")
    .select("id, session_id, model, effort, repo, git_branch, playbook_id")
    .eq("id", parentThreadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (pErr || !parent) throw new Error("parent thread not found");

  const children: { id: string; title: string }[] = [];

  for (const sel of selections) {
    if (!sel.title?.trim() || !Array.isArray(sel.turn_indexes) || sel.turn_indexes.length === 0) {
      continue;
    }
    // 'fork' needs a parent session to fork from; fall back to a clean summary child
    // rather than silently producing a context-less fork.
    const useFork = sel.method === "fork" && Boolean(parent.session_id);

    const { data: child, error: cErr } = await db
      .from("claude_threads")
      .insert({
        org_id: orgId,
        created_by: userId,
        title: sel.title.trim().slice(0, 200),
        // The child's title came from the analysis, not the user — leave it 'auto'
        // so the user can still rename and freeze it.
        title_source: "auto",
        model: parent.model,
        effort: parent.effort,
        repo: parent.repo,
        git_branch: parent.git_branch,
        playbook_id: parent.playbook_id,
        parent_thread_id: parentThreadId,
        // Exactly one inheritance mechanism is set (migration comment).
        fork_from_session: useFork ? parent.session_id : null,
        seed_context: useFork ? null : sel.handover?.trim()?.slice(0, 8000) || null,
        // A fork child's turns run in the PARENT's directory (its forked session
        // lives there). A summary child is self-contained and uses its own dir.
        workspace_thread_id: useFork ? parentThreadId : null,
      })
      .select("id, title")
      .single();
    if (cErr || !child) {
      console.error("[claude/analysis] child insert failed:", cErr?.message);
      continue;
    }

    // Mark the parent's turns as moved to this child. Scoped to the parent thread and
    // to turns not already moved, so a re-applied split can't re-home someone else's
    // turns.
    const { error: mErr } = await db
      .from("claude_runs")
      .update({ moved_to_thread_id: child.id })
      .eq("thread_id", parentThreadId)
      .in("turn_index", sel.turn_indexes)
      .is("moved_to_thread_id", null);
    if (mErr) console.error("[claude/analysis] mark moved failed:", mErr.message);

    children.push(child);
  }

  if (analysisId && children.length > 0) {
    await db
      .from("claude_thread_analyses")
      .update({ status: "applied", decided_at: new Date().toISOString() })
      .eq("id", analysisId)
      .eq("org_id", orgId);
  }

  return { children };
}

/**
 * Group active threads under topics — the once-a-day (or on-demand) pass, plan §6.
 *
 * Unlike split, grouping applies directly: it writes thread↔topic assignments with
 * assigned_by='auto'. A user assignment (assigned_by='user') is never touched, so
 * the automatic pass can add topics but never override a decision you made.
 *
 * Returns how many assignments it wrote. Safe to run repeatedly.
 */
export async function runGroupAnalysis(orgId: string, userId: string | null): Promise<{ assigned: number; topics: number }> {
  const { data: threads, error } = await db
    .from("claude_threads")
    .select("id, title")
    .eq("org_id", orgId)
    .is("archived_at", null)
    .not("title", "eq", "")
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[claude/analysis] group: thread list failed:", error.message);
    return { assigned: 0, topics: 0 };
  }
  const named = (threads ?? []).filter((t) => t.title?.trim());
  // Below a few titled chats there is no grouping to do.
  if (named.length < 3) return { assigned: 0, topics: 0 };

  const list = named.map((t, i) => `${i + 1}. [${t.id}] ${t.title}`).join("\n");
  const prompt = [
    "להלן רשימת צ'אטים, כל אחד עם מזהה וכותרת.",
    "קבץ אותם לנושאים-על. צ'אט יכול להשתייך לכמה נושאים אם באמת מתאים.",
    "",
    "החזר JSON בלבד:",
    '{ "topics": [ { "title": "<שם הנושא בעברית>", "thread_ids": ["<id>", "<id>"] } ] }',
    "",
    "חוקים:",
    "- נושא צריך לפחות שני צ'אטים. צ'אט בודד נשאר בלי נושא — אל תמציא נושא בשבילו.",
    "- השתמש במזהים כפי שהם, בדיוק.",
    "- בלי טקסט חופשי מחוץ ל-JSON.",
    "",
    list,
  ].join("\n");

  // Group analysis APPLIES directly (assigned_by='auto'), unlike split/decompose which
  // only propose — so a weak model's mistake here is NOT caught by a human gate. And
  // there is no single "session" to inherit a model from (this is an org-wide pass over
  // many threads). Both reasons keep it pinned to the strong model. Runs on the
  // automation account so it never eats the interactive window; org-wide, so there is
  // no single thread account to prefer — runAnalysisOneShot fails over to primary /
  // any free account when automation is exhausted.
  const reply = await runAnalysisOneShot(prompt, {
    timeoutMs: 120_000,
    model: BG_MODEL_STRONG,
    label: "group-analysis",
  });
  const parsed = parseJsonReply(reply) as { topics?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.topics)) return { assigned: 0, topics: 0 };

  const validThreadIds = new Set(named.map((t) => t.id));
  let assigned = 0;
  let topicCount = 0;

  for (const raw of parsed.topics as Record<string, unknown>[]) {
    const title = typeof raw?.title === "string" ? raw.title.trim().slice(0, 200) : "";
    const threadIds = Array.isArray(raw?.thread_ids)
      ? (raw.thread_ids as unknown[])
          .map((v) => String(v))
          .filter((id) => validThreadIds.has(id))
      : [];
    if (!title || threadIds.length < 2) continue;

    // Reuse an existing topic of this name; only create when absent. Crucially this
    // does NOT rewrite title_source — a topic the user created (title_source='user',
    // which the migration says freezes it) must not be flipped back to 'auto' by the
    // automatic pass. An upsert that wrote title_source would do exactly that.
    const { data: existingTopic } = await db
      .from("claude_topics")
      .select("id")
      .eq("org_id", orgId)
      .eq("title", title)
      .maybeSingle();
    let topic = existingTopic;
    if (!topic) {
      const { data: created, error: tErr } = await db
        .from("claude_topics")
        .insert({ org_id: orgId, title, title_source: "auto" })
        .select("id")
        .single();
      if (tErr || !created) {
        console.error("[claude/analysis] topic insert failed:", tErr?.message);
        continue;
      }
      topic = created;
    }
    topicCount += 1;

    for (const threadId of threadIds) {
      // ignoreDuplicates so an existing assignment — crucially a user's — is left
      // exactly as it was. The auto pass adds; it never rewrites.
      const { error: aErr } = await db
        .from("claude_thread_topics")
        .upsert(
          { thread_id: threadId, topic_id: topic.id, confidence: 0.8, assigned_by: "auto" },
          { onConflict: "thread_id,topic_id", ignoreDuplicates: true },
        );
      if (!aErr) assigned += 1;
    }
  }

  void userId; // reserved for an audit column later; grouping is not per-user today
  return { assigned, topics: topicCount };
}

/**
 * The gate (plan §5): should this thread be auto-analysed for a split now?
 *
 * Layer 1 only (the cheap SQL check): at least 6 turns, and grown by at least 4
 * since the last analysis. The model run itself is layer 3 and happens in
 * runSplitAnalysis. Deliberately conservative — a thread you are not growing is
 * never reconsidered.
 */
export function shouldAnalyzeSplit(turnCount: number, analyzedTurnCount: number): boolean {
  return turnCount >= 6 && turnCount - analyzedTurnCount >= 4;
}

// ── decompose (forward): plan → parts, each part a briefed child ────────────────

/** A part the decompose analysis proposes to spin out of a plan chat. */
export interface DecomposePart {
  title: string;
  /** The briefing the new child chat starts with — its scope + what the plan already
   *  settled that it needs. This becomes the child's seed_context. */
  scope: string;
}

/**
 * Analyse a "general plan" thread and propose how to break it into parts, each of
 * which becomes its own child chat.
 *
 * Unlike runSplitAnalysis this does NOT look at which turns belong where — nothing is
 * moved. It reads the plan and proposes forward-looking work streams. Runs on the
 * subscription (runOneShot) — no paid API tokens.
 *
 * Returns the stored proposal (kind='decompose'), or null when the plan is too thin
 * to break up. Supersedes an earlier open decompose proposal for the same thread.
 */
export async function runDecomposeAnalysis(
  threadId: string,
  orgId: string,
  userId: string | null,
): Promise<{ id: string; proposal: unknown } | null> {
  const turns = await loadTurns(threadId);
  if (turns.length < 1) return null;

  const prompt = [
    "להלן תמליל של שיחה שבה מתגבשת תוכנית כללית לעבודה כלשהי.",
    "המשימה: להציע איך לפרק את העבודה הזו לכמה חלקים (work streams) שכל אחד ינוהל",
    "בצ'אט נפרד משלו. זה פירוק קדימה — לא מזיזים כלום מהשיחה הקיימת.",
    "",
    "החזר JSON בלבד, בדיוק במבנה:",
    '{ "parts": [ { "title": "<שם החלק בעברית, קצר>",',
    '  "scope": "<תדריך פתיחה לצ\'אט של החלק הזה: מה התחום שלו, מה כבר סוכם בתוכנית',
    '  הכללית שרלוונטי אליו, ומה המטרה. גוף שני, עברית.>" } ] }',
    "",
    "חוקים:",
    "- הצע בין 2 ל-6 חלקים. אם באמת אין מה לפרק — החזר parts ריק.",
    "- כל חלק עצמאי מספיק כדי שמישהו יעבוד עליו בנפרד.",
    "- scope הוא מה שהצ'אט החדש יקבל כדי לדעת מה ולמה — כתוב אותו כתדריך, לא כתקציר.",
    "- שמור על קישורים (URL) כלשונם אם הם מופיעים — אל תקצר לדומיין.",
    "- בלי טקסט חופשי מחוץ ל-JSON.",
    "",
    transcriptOf(turns),
  ].join("\n");

  // Decompose only PROPOSES — applyDecompose is a separate, user-approved step — so
  // like split it runs on the model the thread is open on (the user's choice) rather
  // than a pinned strong model; the approval gate is the real guard. thread.model null
  // → engine default (what the thread's own turns use). Runs on the automation account
  // so it never eats the interactive window — but runAnalysisOneShot fails over to
  // this thread's own account (then primary / any free one) when automation is
  // exhausted, so an exhausted automation account can't dead-end this analysis.
  const { data: decomposeThread } = await db
    .from("claude_threads")
    .select("model, claude_account")
    .eq("id", threadId)
    .maybeSingle();
  const reply = await runAnalysisOneShot(
    prompt,
    { timeoutMs: 120_000, model: decomposeThread?.model ?? undefined, label: "decompose-analysis" },
    decomposeThread?.claude_account,
  );
  const parsed = parseJsonReply(reply) as { parts?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.parts)) return null;

  const parts: DecomposePart[] = [];
  for (const raw of parsed.parts as Record<string, unknown>[]) {
    const title = typeof raw?.title === "string" ? raw.title.trim().slice(0, 200) : "";
    const scope = typeof raw?.scope === "string" ? raw.scope.trim().slice(0, 8000) : "";
    if (title) parts.push({ title, scope });
  }
  // One part is not a decomposition — nothing to break up.
  if (parts.length < 2) return null;

  await db
    .from("claude_thread_analyses")
    .update({ status: "superseded", decided_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("kind", "decompose")
    .eq("status", "proposed");

  const proposal = { parts };
  const { data, error } = await db
    .from("claude_thread_analyses")
    .insert({
      org_id: orgId,
      thread_id: threadId,
      kind: "decompose",
      proposal,
      status: "proposed",
      created_by: userId,
    })
    .select("id, proposal")
    .single();
  if (error) {
    console.error("[claude/analysis] decompose insert failed:", error.message);
    return null;
  }
  return data;
}

/** The line every decomposed/manual child's briefing ends with, so the child knows
 *  the shared board exists and how it is read (on demand, never automatically). */
const BOARD_NOTE =
  "יש לפרויקט הזה לוח משותף שבו כל חלק רושם החלטות והתקדמות. " +
  "לוח זה נטען אליך רק כשהמשתמש מבקש במפורש — אל תניח שאתה רואה אותו כברירת מחדל.";

/**
 * Apply an approved decomposition: create one briefed child chat per selected part.
 *
 * Children get seed_context (the briefing) — method B / "start clean" — so each begins
 * knowing only its part plus the board note. The parent keeps ALL its turns (nothing
 * is moved); it simply becomes the project root now that it has children.
 *
 * Board SEEDING is deliberately NOT here — it happens in the route, which resolves the
 * project ROOT (the top ancestor) and seeds the board there. Seeding on this immediate
 * parent would be wrong when the parent is itself a child (two-level decomposition):
 * board GET/inject resolve to the top ancestor, so a board written on a middle node
 * would be invisible to everyone.
 */
export async function applyDecompose(params: {
  parentThreadId: string;
  orgId: string;
  userId: string | null;
  analysisId: string | null;
  parts: DecomposePart[];
}): Promise<{ children: { id: string; title: string }[] }> {
  const { parentThreadId, orgId, userId, analysisId, parts } = params;

  const { data: parent, error: pErr } = await db
    .from("claude_threads")
    .select("id, model, effort, repo, git_branch, playbook_id")
    .eq("id", parentThreadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (pErr || !parent) throw new Error("parent thread not found");

  const children: { id: string; title: string }[] = [];

  for (const part of parts) {
    if (!part.title?.trim()) continue;
    const briefing = [part.scope?.trim(), "", BOARD_NOTE].filter(Boolean).join("\n").slice(0, 8000);
    const { data: child, error: cErr } = await db
      .from("claude_threads")
      .insert({
        org_id: orgId,
        created_by: userId,
        title: part.title.trim().slice(0, 200),
        title_source: "auto",
        model: parent.model,
        effort: parent.effort,
        repo: parent.repo,
        git_branch: parent.git_branch,
        playbook_id: parent.playbook_id,
        parent_thread_id: parentThreadId,
        // Forward decomposition is always a clean, briefed start — never a fork. The
        // child gets its own workspace (workspace_thread_id null).
        seed_context: briefing,
        fork_from_session: null,
        workspace_thread_id: null,
      })
      .select("id, title")
      .single();
    if (cErr || !child) {
      console.error("[claude/analysis] decompose child insert failed:", cErr?.message);
      continue;
    }
    children.push(child);
  }

  if (analysisId && children.length > 0) {
    await db
      .from("claude_thread_analyses")
      .update({ status: "applied", decided_at: new Date().toISOString() })
      .eq("id", analysisId)
      .eq("org_id", orgId);
  }

  return { children };
}
