-- Auto-resume of orphaned Claude console runs.
--
-- Why this column exists: the console runner spawns `claude -p` as an in-process
-- child on the Railway backend, and marks its claude_runs row `running`. Railway
-- containers are ephemeral — a redeploy (every push to main) or a crash kills the
-- child mid-turn. The in-memory child registry and the runner's own try/catch die
-- with the process, so nothing flips the row out of `running`: it sits live forever,
-- the screen polls it forever ("חושב…" that never moves), and the turn never
-- continues on its own even though the conversation is fully reconstructable from
-- our DB (transcript.ts / the resume-miss fallback in runner.ts).
--
-- The recoverer (server/src/modules/claude/recover.ts) closes that gap: it finds
-- runs stuck `running`/`queued` with no live process and RE-EXECUTES them, so the
-- turn picks itself back up after a restart. This counter caps that: a run that
-- keeps dying (e.g. it reliably OOMs the container) must not be resumed forever —
-- past MAX_RESUME_ATTEMPTS the recoverer stops trying and marks it failed with a
-- "resend" message instead of looping.
--
-- Additive and backfilled to 0 (NOT NULL DEFAULT) — no existing row or flow is
-- affected.

ALTER TABLE public.claude_runs
  ADD COLUMN IF NOT EXISTS resume_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.claude_runs.resume_attempts IS
  'How many times the run recoverer has auto-re-executed this run after finding it '
  'orphaned (running/queued with no live process, e.g. a backend restart mid-turn). '
  'Capped in code (recover.ts) so a run that keeps dying is failed, not looped.';
