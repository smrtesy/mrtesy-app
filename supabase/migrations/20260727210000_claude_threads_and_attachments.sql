-- Claude as a real chat — multi-turn threads, attachments, cancellable turns.
-- Specified in docs/claude-console/app-integration-plan.md §8.
--
-- The gap this closes: a claude_runs row was a ONE-SHOT. You wrote a prompt, it
-- ran, you read the stream — and a follow-up question started from nothing. A
-- chat is a conversation, so the engine's own session has to be carried across
-- turns (`claude --resume <session_id>`), and that session id belongs to the
-- THREAD, not to any single turn.
--
--   claude_threads      — one conversation. Owns the engine session id and the
--                         settings the whole conversation runs under (model,
--                         effort, repo/branch, working method).
--   claude_runs.thread_id — each run becomes one TURN inside a thread.
--   claude_attachments  — files sent with a turn. Stored in Supabase Storage;
--                         the runner downloads them into the run's working
--                         directory so the engine can actually read them.
--
-- Backend-only, exactly like claude_runs: RLS on, no permissive client policy.

-- ── threads ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Shown in the thread list. NOT the first line of the first message: a short
  -- analysis run on the subscription writes a title that describes what the
  -- conversation is about (threads.ts maybeTitle).
  title        text NOT NULL DEFAULT '',

  -- The engine's own session id, captured from the first turn's stream and then
  -- passed as `--resume` on every later turn. THIS is what makes the thread a
  -- conversation instead of a list of unrelated runs. Null until the first turn
  -- reports it (a turn that fails before that leaves the thread resumable-from-
  -- scratch rather than pointing at a session that does not exist).
  session_id   text,

  -- Conversation-level settings. Held here rather than per-turn so the chat keeps
  -- its context (same repo, same method) without re-picking on every message.
  model        text,
  effort       text,
  repo         text,
  git_branch   text,
  playbook_id  uuid REFERENCES claude_playbooks(id) ON DELETE SET NULL,

  archived_at     timestamptz,
  -- Denormalised for ordering the list: ordering by a subquery over every turn
  -- would scan the runs table on every list render.
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Separate ALTER, deliberately: an earlier version of this file shipped without
-- title_source, and CREATE TABLE IF NOT EXISTS is a NO-OP once the table exists —
-- so a column declared only inside it would silently never appear, and every
-- thread insert would then fail on an unknown column.
--
-- 'user' freezes the title: a name the user typed is never overwritten by the
-- automatic titling. Without this the machine would quietly undo their edit.
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'auto';
ALTER TABLE claude_threads
  DROP CONSTRAINT IF EXISTS claude_threads_title_source_check;
ALTER TABLE claude_threads
  ADD CONSTRAINT claude_threads_title_source_check
  CHECK (title_source IN ('auto', 'user'));

-- Where a thread's working directory lives. Reused across turns, because engine
-- sessions are stored PER PROJECT DIRECTORY: a fresh temp dir per turn would make
-- `--resume` unable to find the session it was given, and the conversation would
-- silently lose its memory.
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS workspace_dir text;

CREATE INDEX IF NOT EXISTS idx_claude_threads_org_recent
  ON claude_threads (org_id, last_message_at DESC);

ALTER TABLE claude_threads ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_threads IS
  'One Claude conversation. Owns the engine session id used for --resume, so turns '
  'share context. Backend-only, RLS on with no client policy.';

COMMENT ON COLUMN claude_threads.session_id IS
  'Engine session id from the first turn; passed as --resume on later turns.';


-- ── runs become turns ────────────────────────────────────────────────────────

-- CASCADE, unlike playbook_id's SET NULL: a turn has no meaning outside its
-- conversation, so deleting a thread should take its turns (and their events,
-- which already cascade from claude_runs) with it.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES claude_threads(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_claude_runs_thread
  ON claude_runs (thread_id, created_at);

-- Which turn this is, 1-based. Kept explicitly rather than derived from
-- created_at: two turns can share a timestamp to the millisecond, and the order
-- of a conversation must never be ambiguous.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS turn_index integer;

-- The real guard against two concurrent turns. The application also checks for a
-- live run first, but that is a check-then-insert race: two requests milliseconds
-- apart both see none, both compute the same turn_index, and two engine processes
-- then resume the SAME session — two writers on one transcript. This index makes
-- the second insert fail instead.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_claude_runs_thread_turn
  ON claude_runs (thread_id, turn_index) WHERE thread_id IS NOT NULL;

-- True when the run was resumed into an existing session rather than starting
-- one. Makes "why does this turn know things the prompt never said" answerable
-- from the row itself.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS resumed_session text;


-- ── attachments ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES claude_threads(id) ON DELETE CASCADE,
  -- The turn it was sent with. Nullable because the file is uploaded BEFORE the
  -- turn exists (the user attaches, then sends), and is linked on send.
  run_id       uuid REFERENCES claude_runs(id) ON DELETE SET NULL,

  filename     text NOT NULL,
  mime_type    text,
  size_bytes   bigint,
  -- Path inside the 'claude-attachments' bucket. The bytes never live in this
  -- table — a base64 column would bloat every query that touches a thread.
  storage_path text NOT NULL,

  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claude_attachments_thread
  ON claude_attachments (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claude_attachments_run
  ON claude_attachments (run_id);

ALTER TABLE claude_attachments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_attachments IS
  'Files sent with a Claude turn. Bytes live in the claude-attachments bucket; the '
  'runner downloads them into the run working directory. Backend-only, RLS on.';


-- ── storage bucket ───────────────────────────────────────────────────────────
--
-- PRIVATE, unlike smrtbot-web-icons: these are the user's own files (screenshots,
-- documents, recordings) and nothing outside the backend should be able to fetch
-- one by guessing a URL. Every read goes through a signed URL minted by the
-- service role, so no client policy is granted at all.
--
-- The bucket's own cap is 25 MB, but the API path is limited to ~7 MB: uploads
-- arrive as base64 in a JSON body and express.json is capped at 10mb globally. The
-- headroom is left here deliberately for a future direct-to-storage upload, which
-- would not pass through the body parser.
--
-- If bucket creation via SQL fails (permissions), create it manually:
--   Storage → New bucket → name: claude-attachments → Public: NO
--   → File size limit: 25 MB

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('claude-attachments', 'claude-attachments', false, 26214400)
ON CONFLICT (id) DO NOTHING;
