-- Human-readable serial numbers for source_messages and tasks.
-- source_messages: per-source-type prefix + counter — G1, S1, W1, E1, D1, C1
-- tasks:           single counter — T1, T2, T3, ...
-- These serials let the user reference a specific row in conversation
-- (e.g. "what happened to G42?") without copy-pasting UUIDs.

-- ─── 1. Sequences ──────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS source_msg_gmail_seq;
CREATE SEQUENCE IF NOT EXISTS source_msg_gmail_sent_seq;
CREATE SEQUENCE IF NOT EXISTS source_msg_whatsapp_seq;
CREATE SEQUENCE IF NOT EXISTS source_msg_whatsapp_echo_seq;
CREATE SEQUENCE IF NOT EXISTS source_msg_drive_seq;
CREATE SEQUENCE IF NOT EXISTS source_msg_calendar_seq;
CREATE SEQUENCE IF NOT EXISTS source_msg_unknown_seq;   -- fallback for future types
CREATE SEQUENCE IF NOT EXISTS task_serial_seq;

-- ─── 2. Columns ────────────────────────────────────────────────────────────

ALTER TABLE source_messages
  ADD COLUMN IF NOT EXISTS serial         bigint,
  ADD COLUMN IF NOT EXISTS serial_display text;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS serial         bigint,
  ADD COLUMN IF NOT EXISTS serial_display text;

-- ─── 3. Trigger functions ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION assign_source_message_serial()
RETURNS trigger AS $$
DECLARE
  v_prefix text;
  v_seq    text;
  v_next   bigint;
BEGIN
  IF NEW.serial IS NOT NULL THEN  -- preserve explicit values (e.g. backfill)
    RETURN NEW;
  END IF;
  CASE NEW.source_type
    WHEN 'gmail'           THEN v_prefix := 'G'; v_seq := 'source_msg_gmail_seq';
    WHEN 'gmail_sent'      THEN v_prefix := 'S'; v_seq := 'source_msg_gmail_sent_seq';
    WHEN 'whatsapp'        THEN v_prefix := 'W'; v_seq := 'source_msg_whatsapp_seq';
    WHEN 'whatsapp_echo'   THEN v_prefix := 'E'; v_seq := 'source_msg_whatsapp_echo_seq';
    WHEN 'google_drive'    THEN v_prefix := 'D'; v_seq := 'source_msg_drive_seq';
    WHEN 'google_calendar' THEN v_prefix := 'C'; v_seq := 'source_msg_calendar_seq';
    ELSE                        v_prefix := 'X'; v_seq := 'source_msg_unknown_seq';
  END CASE;
  v_next := nextval(v_seq);
  NEW.serial         := v_next;
  NEW.serial_display := v_prefix || v_next::text;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assign_task_serial()
RETURNS trigger AS $$
BEGIN
  IF NEW.serial IS NULL THEN
    NEW.serial         := nextval('task_serial_seq');
    NEW.serial_display := 'T' || NEW.serial::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 4. Triggers ───────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_source_messages_serial ON source_messages;
CREATE TRIGGER trg_source_messages_serial
  BEFORE INSERT ON source_messages
  FOR EACH ROW EXECUTE FUNCTION assign_source_message_serial();

DROP TRIGGER IF EXISTS trg_tasks_serial ON tasks;
CREATE TRIGGER trg_tasks_serial
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION assign_task_serial();

-- ─── 5. Backfill existing rows ─────────────────────────────────────────────

-- source_messages: rank chronologically within each source_type, assign accordingly
WITH ordered AS (
  SELECT id, source_type,
         ROW_NUMBER() OVER (PARTITION BY source_type ORDER BY created_at, id) AS rn
  FROM source_messages
  WHERE serial IS NULL
)
UPDATE source_messages sm
SET serial = o.rn,
    serial_display =
      CASE o.source_type
        WHEN 'gmail'           THEN 'G' || o.rn
        WHEN 'gmail_sent'      THEN 'S' || o.rn
        WHEN 'whatsapp'        THEN 'W' || o.rn
        WHEN 'whatsapp_echo'   THEN 'E' || o.rn
        WHEN 'google_drive'    THEN 'D' || o.rn
        WHEN 'google_calendar' THEN 'C' || o.rn
        ELSE                        'X' || o.rn
      END
FROM ordered o
WHERE sm.id = o.id;

-- Advance each sequence past the backfilled max
SELECT setval('source_msg_gmail_seq',         COALESCE((SELECT max(serial) FROM source_messages WHERE source_type='gmail'),         0), true);
SELECT setval('source_msg_gmail_sent_seq',    COALESCE((SELECT max(serial) FROM source_messages WHERE source_type='gmail_sent'),    0), true);
SELECT setval('source_msg_whatsapp_seq',      COALESCE((SELECT max(serial) FROM source_messages WHERE source_type='whatsapp'),      0), true);
SELECT setval('source_msg_whatsapp_echo_seq', COALESCE((SELECT max(serial) FROM source_messages WHERE source_type='whatsapp_echo'), 0), true);
SELECT setval('source_msg_drive_seq',         COALESCE((SELECT max(serial) FROM source_messages WHERE source_type='google_drive'),  0), true);
SELECT setval('source_msg_calendar_seq',      COALESCE((SELECT max(serial) FROM source_messages WHERE source_type='google_calendar'), 0), true);

-- tasks: single sequence
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM tasks
  WHERE serial IS NULL
)
UPDATE tasks t
SET serial = o.rn,
    serial_display = 'T' || o.rn
FROM ordered o
WHERE t.id = o.id;

SELECT setval('task_serial_seq', (SELECT COALESCE(max(serial), 0) FROM tasks), true);

-- ─── 6. Constraints + indexes ──────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_messages_serial_display ON source_messages(serial_display);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_serial_display            ON tasks(serial_display);

-- Lookup-by-serial path
CREATE INDEX IF NOT EXISTS idx_source_messages_serial ON source_messages(serial);
CREATE INDEX IF NOT EXISTS idx_tasks_serial            ON tasks(serial);
