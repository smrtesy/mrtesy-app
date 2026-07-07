-- Incremental-polling cursor for the WhatsApp reader.
--
-- whatsapp_messages rows MUTATE after insert:
--   * Meta `statuses` webhook events flip `status` and stamp
--     sent_at / delivered_at / read_at on outgoing rows
--     (src/app/api/webhooks/whatsapp/route.ts — applyStatusEvent).
--   * Sending a new reaction soft-clears prior outgoing reactions on the
--     same target (reaction_emoji = '') via UPDATE.
--   * History-chunk redelivery re-upserts existing rows (onConflict
--     user_id,wamid), and late transcript/OCR fills rewrite content.
-- So received_at alone cannot drive an incremental "what changed since my
-- last poll" query — it never moves after insert. Add a real modified-time
-- column, bumped by trigger on every UPDATE, so
-- GET /whatsapp/messages?chat_id=…&after=<ts> returns only changed rows.

-- The delivery-receipt columns were applied to production out-of-band (no
-- migration in the repo defines them, but the server selects them). Recreate
-- them idempotently — a no-op in production — so the backfill below (and any
-- from-scratch migration run) always has the columns it references.
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS status        text,
  ADD COLUMN IF NOT EXISTS status_error  text,
  ADD COLUMN IF NOT EXISTS sent_at       timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at  timestamptz,
  ADD COLUMN IF NOT EXISTS read_at       timestamptz;

-- Staged add (nullable → backfill → default + NOT NULL) so we never rely on
-- a volatile-default column rewrite.
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Backfill: best-known last-modified moment per row — the latest lifecycle
-- timestamp we recorded, falling back to receipt/insert time.
UPDATE whatsapp_messages
SET updated_at = COALESCE(read_at, delivered_at, sent_at, received_at, created_at)
WHERE updated_at IS NULL;

ALTER TABLE whatsapp_messages
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

-- Bump on every UPDATE. Writers never have to remember to set it — status
-- flips, reaction clears, transcript/OCR fills and redelivery upserts all
-- surface to the incremental cursor automatically.
CREATE OR REPLACE FUNCTION whatsapp_messages_bump_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_messages_set_updated_at ON whatsapp_messages;
CREATE TRIGGER whatsapp_messages_set_updated_at
  BEFORE UPDATE ON whatsapp_messages
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_messages_bump_updated_at();

-- Serves the incremental query's exact shape:
--   WHERE user_id = ? AND chat_id = ? AND updated_at > ? ORDER BY …
CREATE INDEX IF NOT EXISTS whatsapp_messages_user_chat_updated_idx
  ON whatsapp_messages(user_id, chat_id, updated_at DESC);
