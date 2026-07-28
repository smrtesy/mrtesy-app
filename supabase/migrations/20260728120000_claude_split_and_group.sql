-- Claude chat: split a wandering thread, and group threads by topic.
-- Specified in docs/claude-console/threads-split-and-group-plan.md (decisions §8).
--
-- All additive, backend-only (service-role Express), RLS on with no client
-- policy — the exact pattern of claude_threads / claude_runs.
--
--   claude_topics          — a topic: the heading that sits ABOVE a group of chats.
--   claude_thread_topics   — thread ↔ topic, MANY-to-many on purpose (a chat about
--                            "swapping the SMS provider" belongs under both "smrtTask"
--                            and "external providers"; forcing one would lose that).
--   claude_thread_analyses — a proposal produced by an analysis run (split / group /
--                            title). The user approves or dismisses it; nothing acts
--                            on a proposal until then.
--   claude_threads    (+)  — parent_thread_id / split_from_run_id (lineage), and the
--                            analyzed-at bookkeeping the gate reads.
--   claude_runs       (+)  — moved_to_thread_id: a turn shown as "moved" on the
--                            parent and folded away. NON-destructive — the row stays.

-- ── topics ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_topics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title        text NOT NULL,
  -- 'user' freezes the title against the automatic grouping run, same contract as
  -- claude_threads.title_source.
  title_source text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- One topic per (org, title): the grouping run upserts by title instead of
  -- minting a duplicate topic every day.
  UNIQUE (org_id, title)
);

CREATE INDEX IF NOT EXISTS idx_claude_topics_org ON claude_topics (org_id, title);

ALTER TABLE claude_topics ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_topics IS
  'A topic — the heading above a group of Claude chats. Backend-only, RLS on, no client policy.';


-- ── thread ↔ topic (many-to-many) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_thread_topics (
  thread_id   uuid NOT NULL REFERENCES claude_threads(id) ON DELETE CASCADE,
  topic_id    uuid NOT NULL REFERENCES claude_topics(id) ON DELETE CASCADE,
  -- The grouping run's confidence; a user assignment stores 1.
  confidence  real,
  -- 'user' assignments win and are never revoked by the automatic run.
  assigned_by text NOT NULL DEFAULT 'auto' CHECK (assigned_by IN ('auto', 'user')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_claude_thread_topics_topic
  ON claude_thread_topics (topic_id);

ALTER TABLE claude_thread_topics ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_thread_topics IS
  'Thread↔topic, many-to-many: one chat may sit under several topics. Backend-only, RLS on.';


-- ── analysis proposals ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_thread_analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The thread analysed. Nullable for a 'group' run, which is org-wide and not
  -- about one thread.
  thread_id   uuid REFERENCES claude_threads(id) ON DELETE CASCADE,

  kind        text NOT NULL CHECK (kind IN ('split', 'group', 'title')),
  -- The run's result, verbatim: for 'split', the topics + which turns + the exact
  -- handover text; for 'group', the clusters + titles. Kept whole so the UI shows
  -- what the model proposed, not a reconstruction.
  proposal    jsonb NOT NULL,

  -- proposed → the user has not decided; applied → acted on; dismissed → rejected.
  -- superseded → a newer analysis of the same thread replaced it before a decision.
  status      text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'applied', 'dismissed', 'superseded')),

  -- The claude_runs row that produced it — the analysis is itself a subscription
  -- run, so this ties the proposal back to its cost and transcript.
  run_id      uuid REFERENCES claude_runs(id) ON DELETE SET NULL,

  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_claude_analyses_thread
  ON claude_thread_analyses (thread_id, created_at DESC);
-- The open split proposal for a thread is fetched on every thread open; this keeps
-- that to an index probe rather than a scan.
CREATE INDEX IF NOT EXISTS idx_claude_analyses_open
  ON claude_thread_analyses (org_id, kind, status) WHERE status = 'proposed';

ALTER TABLE claude_thread_analyses ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_thread_analyses IS
  'A split/group/title proposal from an analysis run. Nothing acts on it until the '
  'user approves. Backend-only, RLS on with no client policy.';


-- ── thread lineage + analysis bookkeeping ──────────────────────────────────────

-- The chat this one was split OFF from, and the turn the split was requested at.
-- SET NULL, not CASCADE: deleting the parent must not delete a child that now holds
-- its own live conversation.
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS parent_thread_id uuid REFERENCES claude_threads(id) ON DELETE SET NULL;
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS split_from_run_id uuid REFERENCES claude_runs(id) ON DELETE SET NULL;

-- The gate (plan §5) fires an analysis only when the thread has grown enough since
-- the last one. These two remember "how much had we analysed, and when".
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS analyzed_at timestamptz;
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS analyzed_turn_count integer NOT NULL DEFAULT 0;

-- How a split child inherits from its parent — read by the runner on the child's
-- FIRST turn, then never again (once session_id is set the thread resumes normally).
--
--   fork_from_session — method A ("take everything"): the first turn runs
--                       `--resume <parent_session> --fork-session`, so the child
--                       inherits the WHOLE parent conversation and diverges.
--   seed_context      — method B (default, "start clean"): the handover text is
--                       prepended to the child's first prompt, so the child knows
--                       ONLY its topic. This is the text the user reviewed.
--
-- Exactly one is set on a split child; both are null on an ordinary new thread.
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS fork_from_session text;
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS seed_context text;

-- Which thread's working directory this thread's turns run in. Null = its own.
--
-- A method-A fork child sets this to its PARENT's id, because the engine stores
-- sessions per project directory and the forked session lives in the parent's dir.
--
-- Deliberately a plain uuid with NO foreign key: it is a DIRECTORY KEY, not a
-- relational reference. If it were an FK with ON DELETE SET NULL, deleting the
-- parent would null it and the child would fall back to its own dir — where the
-- forked session never existed — silently losing its memory. As a plain key it
-- keeps pointing at the parent's directory path even after the parent row is gone,
-- and the delete path refuses to remove a directory another thread still borrows.
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS workspace_thread_id uuid;

CREATE INDEX IF NOT EXISTS idx_claude_threads_workspace
  ON claude_threads (workspace_thread_id) WHERE workspace_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claude_threads_parent
  ON claude_threads (parent_thread_id) WHERE parent_thread_id IS NOT NULL;


-- ── turns that moved to a split child ──────────────────────────────────────────

-- Non-destructive: the turn stays on the parent, and the parent's screen folds the
-- moved turns into one "N turns moved to <child>" row. Undo is setting this back to
-- NULL — one column, no data recreated.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS moved_to_thread_id uuid REFERENCES claude_threads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_claude_runs_moved
  ON claude_runs (moved_to_thread_id) WHERE moved_to_thread_id IS NOT NULL;
