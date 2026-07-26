-- Model/effort selection and captured usage for Claude runs.
-- Follows 20260726120000_claude_runs.sql (docs/claude-console/plan.md).
--
-- Two additions, both driven by what the engine already tells us:
--
-- 1. model + effort — the run's requested model alias and effort level, passed
--    through to --model / --effort. NULL means "whatever the CLI defaults to",
--    which is the right default: it tracks Anthropic's current default instead of
--    pinning us to a model that will age.
--
-- 2. usage columns — the stream's `result` event carries total_cost_usd, a
--    per-model breakdown, token counts (including cache), turns and duration. We
--    were discarding all of it into the generic payload column. Promoting it to
--    real columns is what makes a usage view possible, and it is OUR data: no
--    external usage API is involved (and none exists for a Team subscription —
--    the Analytics API is Enterprise-only; see docs/claude-console/feasibility.md).
--
-- IMPORTANT about cost_usd: on a subscription these runs are NOT billed per token.
-- The figure is the engine's own estimate of equivalent API cost, useful as a
-- consumption measure and explicitly NOT an amount owed. The UI must say so.
--
-- Additive: every column is nullable, so existing rows stay valid.

ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS model                 text,
  ADD COLUMN IF NOT EXISTS effort                text,
  ADD COLUMN IF NOT EXISTS total_cost_usd        numeric(12, 6),
  ADD COLUMN IF NOT EXISTS input_tokens          integer,
  ADD COLUMN IF NOT EXISTS output_tokens         integer,
  ADD COLUMN IF NOT EXISTS cache_read_tokens     integer,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens integer,
  ADD COLUMN IF NOT EXISTS num_turns             integer,
  ADD COLUMN IF NOT EXISTS duration_ms           integer,
  -- Per-model breakdown exactly as the engine reported it. Kept as jsonb because
  -- a run can span several models (a Sonnet main turn plus a Haiku side task, for
  -- instance) and the set of models is not ours to enumerate.
  ADD COLUMN IF NOT EXISTS model_usage           jsonb;

-- Effort is a closed set in the CLI (--effort low|medium|high|xhigh|max), so a
-- CHECK is safe here. Model deliberately has none: aliases like opus/sonnet/fable
-- change over time and a constraint would turn a new alias into a failed insert.
ALTER TABLE claude_runs
  DROP CONSTRAINT IF EXISTS claude_runs_effort_check;
ALTER TABLE claude_runs
  ADD CONSTRAINT claude_runs_effort_check
  CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max'));

-- Usage views filter by org and group by day, so index the pair we actually scan.
CREATE INDEX IF NOT EXISTS idx_claude_runs_org_ended
  ON claude_runs (org_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

COMMENT ON COLUMN claude_runs.total_cost_usd IS
  'Engine-reported equivalent API cost. Runs on a subscription are NOT billed per '
  'token — this is a consumption measure, not an amount owed.';
COMMENT ON COLUMN claude_runs.model IS
  'Requested model alias (opus/sonnet/fable) or full id. NULL = the CLI default.';
