-- Third execution context: 'outside' (בחוץ), alongside 'home' (בית).
--
-- Background: the desk-model migration (20260610190000) constrained
-- tasks.context to ('home','work') and the UI only ever persisted 'home' or
-- NULL — "work"/office was the *implied default* for any unmarked task, never
-- an actually-stored value. We now surface three user-facing categories:
--   בית    → context = 'home'
--   משרד   → context IS NULL (or legacy 'work') — the quiet default
--   בחוץ   → context = 'outside'   (new)
--
-- This widens the CHECK to admit 'outside'. 'work' is kept in the allowed set
-- so any pre-existing rows (there should be none, but be safe) stay valid; the
-- office default remains NULL, so no data backfill is required.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_context_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_context_check
  CHECK (context IN ('home', 'work', 'outside'));

COMMENT ON COLUMN tasks.context IS
  'home|work|outside — dedicated execution-context filter. NULL (or legacy ''work'') = משרד/office, the default. Manual-only.';
