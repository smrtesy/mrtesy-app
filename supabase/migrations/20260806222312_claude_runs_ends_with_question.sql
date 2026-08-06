-- The Claude console rail's "ממתין לך" (awaiting-reply) dot previously lit ONLY when a
-- turn ended on an interactive block (`ends_with_block`). Measured over 30 days, ~2× as
-- many turns end on a plain-text question, so those threads sat on a wrong grey dot and
-- the user never knew a chat was waiting on them.
--
-- `ends_with_question` is the free-text twin of `ends_with_block`: true when a COMPLETED
-- (`status='done'`) turn that has NO interactive block ends on a question mark. A STORED
-- GENERATED column (not a runner-written boolean like ends_with_block) so it is computed
-- once at write time AND backfills every existing row in this same additive ALTER — the
-- 22 threads already waiting on a plain-text question light up immediately, with no
-- separate data-mutating UPDATE. claude_runs is tiny (≈560 rows), so the table rewrite is
-- instant.
--
-- The tail regex mirrors the deleted TS `endsWithQuestion`: a "?" as the last meaningful
-- char, tolerating trailing whitespace and markdown/emphasis/closing chars (** _ ` " ' ) ] > ~ -).
-- Trailing fenced code blocks are stripped first so a "?" inside a code sample isn't
-- mistaken for a question to the user. The `ends_with_block` guard means an interactive
-- block never also registers here (it is already caught by its own column).
ALTER TABLE claude_runs
  ADD COLUMN ends_with_question boolean
  GENERATED ALWAYS AS (
    status = 'done'
    AND NOT COALESCE(ends_with_block, false)
    AND regexp_replace(COALESCE(result_summary, ''), '```[^`]*```', '', 'g')
        ~ '\?[[:space:]"''*_`)\]>~-]*$'
  ) STORED;

COMMENT ON COLUMN claude_runs.ends_with_question IS
  'Generated: newest done turn ends on a plain-text question mark (no interactive block). Drives the rail''s awaiting-reply dot alongside ends_with_block.';
