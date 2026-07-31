-- Per-org default model + effort for the Claude console.
--
-- New chats inherit these instead of a hardcoded default, so the operator can
-- pick "every new chat opens on Sonnet / high effort" once in settings rather
-- than per-thread. Both nullable: a null falls back to the app's built-in
-- default (claude-opus-5 / engine-chosen effort), so an org that never sets
-- them behaves exactly as before. Additive and idempotent.
ALTER TABLE claude_instructions
  ADD COLUMN IF NOT EXISTS default_model  text,
  ADD COLUMN IF NOT EXISTS default_effort text;

COMMENT ON COLUMN claude_instructions.default_model IS
  'Default engine model id new threads in this org open with (null → app default).';
COMMENT ON COLUMN claude_instructions.default_effort IS
  'Default effort level new threads open with: low|medium|high|xhigh|max (null → engine-chosen).';
