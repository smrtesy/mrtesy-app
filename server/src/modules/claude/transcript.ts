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
 * SOURCE: `claude_runs.user_prompt` (what the human actually typed) +
 * `result_summary` (the assistant's reply), NOT the composed `prompt` column.
 * The turn-1 `prompt` carries the whole environment preamble + standing
 * instructions, and rebuilding from it duplicated ~10-40 KB of boilerplate
 * inside the history, crowding out real turns. The runner re-attaches the
 * preamble itself (composePrompt around the rebuilt history), so the history
 * here stays purely the conversation. `prompt` remains the fallback for rows
 * that predate user_prompt or an attachment-only message ("" user_prompt).
 */
import { db } from "../../db";

/**
 * Headroom for the rebuilt history, in BYTES — not characters. Hebrew is 2 bytes
 * per character in UTF-8, so the previous 60 000-character budget could reach
 * ~120 KB and, combined with the new message, brush the Linux single-argv limit
 * (MAX_ARG_STRLEN, 131 072 bytes) as an opaque spawn E2BIG. 50 KB of bytes keeps
 * the whole recomposed prompt (preamble + clamped instructions + history + the
 * user's message, see composePrompt's 100 KB budget) clearly inside it.
 */
const MAX_TRANSCRIPT_BYTES = 50_000;
const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

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
    .select("turn_index, user_prompt, prompt, result_summary")
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
    const user = (r.user_prompt ?? "").trim() || (r.prompt ?? "").trim();
    const assistant = (r.result_summary ?? "").trim();
    if (!user && !assistant) continue;
    const parts: string[] = [];
    if (user) parts.push(`## משתמש\n${user}`);
    if (assistant) parts.push(`## קלוד\n${assistant}`);
    blocks.push(parts.join("\n\n"));
  }
  if (blocks.length === 0) return null;

  const joined = blocks.join("\n\n---\n\n");
  if (byteLen(joined) <= MAX_TRANSCRIPT_BYTES) return joined;

  // Over budget: keep the MOST RECENT turns (recency matters most for continuing
  // a conversation) and mark that earlier ones were dropped, rather than silently
  // truncating mid-turn.
  const kept: string[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const next = total + byteLen(blocks[i]) + 9; // +9 = the "\n\n---\n\n" separator in bytes
    if (next > MAX_TRANSCRIPT_BYTES && kept.length > 0) break;
    kept.unshift(blocks[i]);
    total = next;
  }
  let out = `…(תורים מוקדמים הושמטו כדי להתאים למגבלת האורך)…\n\n---\n\n${kept.join("\n\n---\n\n")}`;
  // A SINGLE block can exceed the whole budget (user_prompt and result_summary
  // are each capped at 20K chars ≈ 40 KB of Hebrew, so one block can reach
  // ~80 KB). The loop above always keeps at least one block, so hard-clamp the
  // final string by bytes, keeping the TAIL — the most recent text.
  while (byteLen(out) > MAX_TRANSCRIPT_BYTES) {
    out = out.slice(Math.ceil((byteLen(out) - MAX_TRANSCRIPT_BYTES) / 2) || 1);
  }
  return out;
}
