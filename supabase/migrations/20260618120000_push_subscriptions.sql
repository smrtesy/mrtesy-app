-- Web Push subscriptions — one row per browser/device a user has opted in from.
-- The platform's notify() helper fans every notification out to these via VAPID,
-- so an installed PWA receives OS-level notifications even when it's closed.
--
-- endpoint is the push-service URL (unique per subscription); re-subscribing the
-- same browser upserts on it. p256dh/auth are the client's encryption keys.
-- Subscriptions are per-user (not org-scoped), mirroring the notifications table.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Owner-only access. The Express backend uses the service-role key (which
-- bypasses RLS) for fan-out; this policy guards any direct client access.
DROP POLICY IF EXISTS "push_subscriptions_owner" ON push_subscriptions;
CREATE POLICY "push_subscriptions_owner" ON push_subscriptions
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
