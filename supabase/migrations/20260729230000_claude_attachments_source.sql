-- Run-produced attachments ("Claude uses the app in a real browser").
--
-- Until now every claude_attachments row was a file the USER sent with a turn.
-- The browser helper lets the run itself capture screenshots of the live app and
-- post them back into the chat, so the UI needs to tell the two apart: user
-- uploads render as chips on the user's message; run screenshots render as
-- inline images under the assistant's reply.
--
-- 'user' is the default so every existing row (all user uploads) is classified
-- correctly without a backfill.

ALTER TABLE public.claude_attachments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user'
  CHECK (source IN ('user', 'run'));

COMMENT ON COLUMN public.claude_attachments.source IS
  'user = uploaded by the user with a message; run = produced by the run itself (e.g. a browser screenshot posted back into the chat).';
