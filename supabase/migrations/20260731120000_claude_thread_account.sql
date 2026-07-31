-- Per-thread Claude account.
--
-- Which subscription account a conversation runs on. Two accounts exist (the
-- primary CLAUDE_CODE_OAUTH_TOKEN and the second CLAUDE_CODE_OAUTH_TOKEN_AUTOMATION
-- — see server/src/modules/claude/runner.ts loadAccountToken). Until now only the
-- background automation work opted into the second account; interactive console
-- threads always used the primary. This column lets the operator switch a specific
-- conversation between accounts from the console (the account switcher), so a thread
-- that hit one account's rolling usage limit can continue on the other.
--
-- NULL means "use the primary account" — the same default every existing thread had
-- implicitly, so this is a backwards-compatible add. The value, when set, is one of
-- the account ids the runner understands ('primary' | 'automation'); an unknown or
-- unconfigured value falls back to the primary token in loadAccountToken, so a stale
-- value can never dead-end a thread.
ALTER TABLE claude_threads ADD COLUMN IF NOT EXISTS claude_account text;

COMMENT ON COLUMN claude_threads.claude_account IS
  'Which Claude subscription account this thread runs on: ''primary'' (default, '
  'NULL) or ''automation'' (the second account). Threaded onto each turn''s '
  'claude_runs row and resolved to a token by runner.ts loadAccountToken.';
