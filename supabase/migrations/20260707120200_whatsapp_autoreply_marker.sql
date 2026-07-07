-- Precise auto-reply idempotency: inferring "already replied" from row
-- existence swallows the first reply when an invocation dies between storing
-- the message and sending the reply (Meta then redelivers, the wamid already
-- exists, and the reply is skipped forever). Persist an explicit marker set
-- only after a successful send instead.
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS autoreply_sent_at timestamptz;
