-- Per-bot Meta App Secret for smrtBot webhook signature verification.
--
-- Each bot is its own Meta app (its own App Secret), and Meta signs every
-- webhook POST with X-Hub-Signature-256 = HMAC-SHA256(body, app_secret). The
-- smrtbot webhook now verifies that signature, resolving the secret per bot.
--
-- Stored plaintext to match this table's existing credential columns
-- (wa_access_token, verify_token); a future pass can move all of them to Vault.
-- Nullable + backward-compatible: until a bot's app_secret is set, the webhook
-- falls back to the META_APP_SECRET env and otherwise no-ops, so nothing breaks.
alter table public.smrtbot_bots
  add column if not exists app_secret text;
