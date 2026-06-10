-- Add a per-watch secret token to sync_state for Google Calendar push channels.
--
-- Why: calendar-webhook currently derives the userId straight from the
-- X-Goog-Channel-ID header with no authenticity check, so a forged request can
-- trigger calendar processing for any user. Google echoes an opaque `token`
-- (set at watch creation) back on every notification as X-Goog-Channel-Token.
-- We now generate a random token per watch, store it here, and the webhook
-- validates the header against it.
--
-- Backward-compatible rollout: existing watches have watch_token = NULL until
-- calendar-renew-watch next runs (~weekly). The webhook fails OPEN when the
-- stored token is NULL, so live watches keep working through the transition;
-- once a watch is renewed and carries a token, the check is enforced.
alter table public.sync_state
  add column if not exists watch_token text;
