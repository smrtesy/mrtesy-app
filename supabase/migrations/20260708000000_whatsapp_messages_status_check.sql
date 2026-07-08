-- Codify the whatsapp_messages.status CHECK constraint.
--
-- The status/sent_at/delivered_at/read_at delivery-receipt columns were added
-- to production out-of-band (see 20260707130000_whatsapp_messages_updated_at.sql,
-- which recreates the columns idempotently for from-scratch runs). The matching
-- CHECK constraint on `status` was ALSO applied out-of-band and never landed in a
-- migration — so a fresh environment gets the columns but not the guard.
--
-- Recreate it idempotently here so a from-scratch migration run matches
-- production. Allowed values mirror the webhook receiver
-- (src/app/api/webhooks/whatsapp/route.ts — applyStatusUpdate): Meta's `played`
-- voice-note receipt is normalized to `read` before write, so the constraint
-- deliberately does NOT list `played`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'whatsapp_messages'::regclass
      AND conname = 'whatsapp_messages_status_check'
  ) THEN
    ALTER TABLE whatsapp_messages
      ADD CONSTRAINT whatsapp_messages_status_check
      CHECK (status IS NULL OR status IN ('sent', 'delivered', 'read', 'failed'));
  END IF;
END $$;
