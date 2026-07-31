/**
 * Rebuild a thread's conversation as text from OUR database — the durable source
 * of truth — so a turn whose engine session was lost can resume WITH context
 * instead of starting blank.
 *
 * WHY THIS EXISTS: each turn resumes the engine session with `--resume`, whose
 * transcript lives on the container's local disk. Railway containers are
 * ephemeral, so a restart wipes that transcript; the next turn's `--resume` finds
 * nothing and the runner falls back to a fresh session — which, without this,
 * forgets the entire conversation (the "context lost" complaint). But the
 * conversation itself was never lost: every turn is a `claude_runs` row. This
 * rebuilds the history from those rows and the runner prepends it to the fresh
 * turn, exactly the stateless "re-feed the whole history" pattern the Messages
 * API / claude.ai use — the history simply comes from our DB rather than the
 * wiped on-disk transcript.
 *
 * SOURCE: `claude_runs.prompt` (the user's turn) + `result_summary` (the
 * assistant's reply), NOT `claude_run_events`. Those two columns are always
 * populated for a completed turn (prompt is set on insert; result_summary is
 * written by the runner's finish() on success), so the reconstruction never
 * depends on the event stream being intact and stays compact.
 */
import { db } from "../../db";

/**
 * Headroom for the rebuilt history, kept well under the ~100 KB single-argv
 * budget the prompt is composed against (the whole prompt is one argv entry —
 * Linux MAX_ARG_STRLEN), leaving room for the user's actual new message and the
 * environment preamble that also ride in that argv.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * Rebuild the prior conversation of a thread as a plain-text transcript.
 *
 * Returns null when there is nothing to rebuild (no prior completed turns) or on
 * a DB error — fail closed, so the caller starts a clean fresh session rather
 * than prepending a partial/misleading history. `excludeRunId` is the current
 * (recovering) run, which must not appear in its own context.
 */
export async function buildThreadTranscript(
  threadId: string,
  excludeRunId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("claude_runs")
    .select("turn_index, prompt, result_summary")
    .eq("thread_id", threadId)
    .eq("status", "done")
    .neq("id", excludeRunId)
    .order("turn_index", { ascending: true });
  if (error) {
    console.error("[claude/transcript] load failed:", error.message);
    return null;
  }

  const rows = data ?? [];
  const blocks: string[] = [];
  for (const r of rows) {
    const user = (r.prompt ?? "").trim();
    const assistant = (r.result_summary ?? "").trim();
    if (!user && !assistant) continue;
    const parts: string[] = [];
    if (user) parts.push(`## משתמש\n${user}`);
    if (assistant) parts.push(`## קלוד\n${assistant}`);
    blocks.push(parts.join("\n\n"));
  }
  if (blocks.length === 0) return null;

  const joined = blocks.join("\n\n---\n\n");
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;

  // Over budget: keep the MOST RECENT turns (recency matters most for continuing
  // a conversation) and mark that earlier ones were dropped, rather than silently
  // truncating mid-turn.
  const kept: string[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const next = total + blocks[i].length + 8; // +8 ≈ the "\n\n---\n\n" separator
    if (next > MAX_TRANSCRIPT_CHARS && kept.length > 0) break;
    kept.unshift(blocks[i]);
    total = next;
  }
  return `…(תורים מוקדמים הושמטו כדי להתאים למגבלת האורך)…\n\n---\n\n${kept.join("\n\n---\n\n")}`;
}
