-- ============================================================
-- Web Push bridge — fan EVERY notification out to the user's devices
-- ============================================================
-- Problem this fixes: sendPush (VAPID web-push) only ran inside the Express
-- server's notify() helper. But almost every real notification — Gmail
-- disconnect, sync errors, and the new "X items in your inbox" digest — is
-- inserted DIRECTLY into `notifications` by Supabase edge functions
-- (gmail-sync, ai-process, drive-sync), which never call sendPush. So those
-- notifications appeared in-app but never reached the phone.
--
-- The fix: a single AFTER INSERT trigger on `notifications` that POSTs the row
-- to the Express endpoint /api/internal/push/notify (which runs sendPush),
-- using the exact pg_net → Railway + x-cron-secret pattern the crons already
-- use. Now push fires once per notification, no matter who inserted it.
--
-- Operator setup (once) — same shape as the smrtreach/smrtbot crons:
--   1. Enable the pg_net extension (Dashboard → Database → Extensions).
--   2. Store two values in Vault (Dashboard → Project Settings → Vault):
--        push_notify_url    = https://<your-railway-host>/api/internal/push/notify
--        push_notify_secret = <the same value as the server's CRON_SECRET env>
--   No re-run needed: the trigger reads Vault at fire time, so it starts
--   working the moment both secrets exist. Until then it is a safe no-op.
--
-- Safety: the trigger function NEVER raises — a missing extension, missing
-- Vault secret, or a network hiccup must never block a notification insert.

CREATE OR REPLACE FUNCTION public.push_on_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER          -- needs to read vault.decrypted_secrets
SET search_path = public, vault, net
AS $$
DECLARE
  v_url    text;
  v_secret text;
BEGIN
  -- Read the Railway endpoint + shared secret from Vault. If either is absent
  -- (operator hasn't configured push yet) this is a clean no-op.
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'push_notify_url'    LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'push_notify_secret' LIMIT 1;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', v_secret
    ),
    body    := jsonb_build_object(
      'user_id',  NEW.user_id,
      'title',    NEW.title,
      'body',     NEW.body,
      'link',     NEW.link,
      'type',     NEW.type,
      'app_slug', NEW.app_slug,
      'tag',      NEW.entity_id   -- uuid or null; doubles as the push collapse tag
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- pg_net not installed, Vault unavailable, transient failure — never break
  -- the insert. The notification still lands in-app; only the push is skipped.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_push_on_notification ON public.notifications;
CREATE TRIGGER trg_push_on_notification
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.push_on_notification();
