-- ============================================================
-- Web Push collapse tag — fall back to entity_type when entity_id is NULL
-- ============================================================
-- The push bridge (20260619120000_push_on_notification.sql) sends NEW.entity_id
-- as the push `tag`, which the browser/OS uses to COLLAPSE notifications: pushes
-- sharing a tag replace each other instead of stacking. But the inbox digest
-- ("X פריטים חדשים בנכנס") is inserted with entity_type='inbox_digest' and NO
-- entity_id (it points at a set of suggestions, not one uuid). With a NULL tag,
-- every digest push landed as a SEPARATE banner — the "26 / 25 / 14 / 10 ..."
-- pile-up the user reported on their phone.
--
-- Fix: tag := COALESCE(entity_id::text, entity_type). Now digests collapse to a
-- single self-updating banner, while entity-scoped notifications keep collapsing
-- per entity exactly as before. Rows with neither stay tagless (no collapse),
-- which is the correct default for one-off notifications.
--
-- Only the tag expression changes; everything else (Vault lookup, no-op safety,
-- never-raises guarantee) is identical to the original.

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
      -- Collapse tag: prefer the entity uuid; fall back to entity_type so
      -- tagless digests (inbox_digest) still collapse to one banner.
      'tag',      COALESCE(NEW.entity_id::text, NEW.entity_type)
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;
