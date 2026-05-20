-- Router decisions — AI-classified intents triggered by user free-text input
-- (the sidebar "עדכון" button) or by self-WhatsApp messages.
--
-- Each row captures one decision: input text + classification + preview
-- payload. The user reviews/edits, then applies. Applying flips status to
-- 'applied' and records the resulting task_id.
--
-- The chat-level handler in whatsapp-webhook.ts inserts a row when an
-- incoming message arrives whose from_phone matches the user's own
-- whatsapp_connections.display_phone_number — that's how we detect a
-- "note to self" send.

-- ─── 1. Sequence + serial display ─────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS router_decision_seq;

CREATE TABLE IF NOT EXISTS router_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- Human-readable id (U1, U2, ...) — surfaced in chat replies and UI badges
  serial            bigint,
  serial_display    text,

  -- Origin of the request
  source            text NOT NULL CHECK (source IN ('sidebar','whatsapp_self')),
  source_message_id uuid REFERENCES source_messages(id) ON DELETE SET NULL,
  -- For whatsapp_self origin: wamid of the originating WhatsApp message,
  -- so the webhook can dedupe re-deliveries from Meta.
  source_wamid      text,

  -- Raw user input (free text)
  input_text        text NOT NULL,

  -- AI classification
  intent            text NOT NULL CHECK (intent IN (
    'create_task',
    'update_task',
    'add_subtask',
    'add_update',
    'complete_task',
    'dismiss_task',
    'unknown'
  )),
  target_task_id    uuid REFERENCES tasks(id) ON DELETE SET NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasoning         text,
  model_used        text,
  cost_usd          numeric(10,6),

  -- Lifecycle
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','applied','dismissed','expired'
  )),
  applied_task_id   uuid REFERENCES tasks(id) ON DELETE SET NULL,
  applied_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Assign serial on insert
CREATE OR REPLACE FUNCTION assign_router_decision_serial()
RETURNS trigger AS $$
BEGIN
  IF NEW.serial IS NULL THEN
    NEW.serial         := nextval('router_decision_seq');
    NEW.serial_display := 'U' || NEW.serial::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_router_decisions_serial ON router_decisions;
CREATE TRIGGER trg_router_decisions_serial
  BEFORE INSERT ON router_decisions
  FOR EACH ROW EXECUTE FUNCTION assign_router_decision_serial();

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION touch_router_decisions_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_router_decisions_touch ON router_decisions;
CREATE TRIGGER trg_router_decisions_touch
  BEFORE UPDATE ON router_decisions
  FOR EACH ROW EXECUTE FUNCTION touch_router_decisions_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS uq_router_decisions_serial_display
  ON router_decisions(serial_display);
CREATE INDEX IF NOT EXISTS idx_router_decisions_user_created
  ON router_decisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_router_decisions_status
  ON router_decisions(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_router_decisions_user_wamid
  ON router_decisions(user_id, source_wamid)
  WHERE source_wamid IS NOT NULL;

-- RLS — users see their own decisions only
ALTER TABLE router_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS router_decisions_self_select ON router_decisions;
CREATE POLICY router_decisions_self_select
  ON router_decisions FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS router_decisions_self_insert ON router_decisions;
CREATE POLICY router_decisions_self_insert
  ON router_decisions FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS router_decisions_self_update ON router_decisions;
CREATE POLICY router_decisions_self_update
  ON router_decisions FOR UPDATE
  USING (user_id = auth.uid());
