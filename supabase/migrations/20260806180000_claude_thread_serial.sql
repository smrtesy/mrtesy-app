-- Human-readable serial for claude_threads — a short "K7"-style id the user can
-- hand to another session so it can identify a specific thread, without copying a
-- UUID. Global counter (NOT per-org), mirroring the tasks serial in
-- 20260518000005_serial_numbers.sql.
--
-- Prefix is 'K' deliberately: 'C' is already taken by google_calendar
-- source_messages (C1..C97 live), so a thread 'C7' would be ambiguous with a
-- calendar message 'C7'. 'K' (≈ the C sound, "Claude") keeps thread ids in their
-- own namespace — every prefix in use is G/S/W/E/D/C/X (source_messages) + T
-- (tasks); K is free.
--
-- UI contract: the rail shows the BARE number (7); clicking it copies the
-- canonical "K7". GET /claude/threads/by-code/:code maps "K7"/"k7"/"7" back to the
-- thread (org-scoped), and the runner injects CLAUDE_THREAD_CODE so a session can
-- state its own id when asked.
--
-- Additive: new sequence, two new nullable columns, a BEFORE INSERT trigger, and a
-- backfill that only fills the freshly-added (NULL) columns. No existing data is
-- modified or removed.

-- ─── 1. Sequence ───────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS claude_thread_seq;

-- ─── 2. Columns ────────────────────────────────────────────────────────────
ALTER TABLE public.claude_threads
  ADD COLUMN IF NOT EXISTS serial         bigint,
  ADD COLUMN IF NOT EXISTS serial_display text;

COMMENT ON COLUMN public.claude_threads.serial IS
  'Global running counter for the thread (1-based). Backing number for serial_display.';
COMMENT ON COLUMN public.claude_threads.serial_display IS
  'Short human id, e.g. "K7". Rail shows the bare number; a click copies this. '
  'Resolvable via GET /claude/threads/by-code/:code. Prefix K (not C — C is taken '
  'by google_calendar source_messages).';

-- ─── 3. Trigger — assign on insert ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION assign_claude_thread_serial()
RETURNS trigger AS $$
BEGIN
  IF NEW.serial IS NULL THEN  -- preserve explicit values (e.g. backfill)
    NEW.serial         := nextval('claude_thread_seq');
    NEW.serial_display := 'K' || NEW.serial::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claude_threads_serial ON public.claude_threads;
CREATE TRIGGER trg_claude_threads_serial
  BEFORE INSERT ON public.claude_threads
  FOR EACH ROW EXECUTE FUNCTION assign_claude_thread_serial();

-- ─── 4. Backfill existing rows (K1 = the oldest thread) ────────────────────
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM public.claude_threads
  WHERE serial IS NULL
)
UPDATE public.claude_threads ct
SET serial = o.rn,
    serial_display = 'K' || o.rn
FROM ordered o
WHERE ct.id = o.id;

-- Advance the sequence past the backfilled max so the next insert continues cleanly.
-- GREATEST(..,1) + is_called=EXISTS(rows): on a non-empty table this sets the seq to
-- max(serial) is_called → nextval = max+1; on an EMPTY table (fresh/staging DB) it
-- would otherwise error ("0 is out of bounds", MINVALUE 1) — instead we set 1 not-yet-
-- called so the first nextval returns 1.
SELECT setval(
  'claude_thread_seq',
  GREATEST(COALESCE((SELECT max(serial) FROM public.claude_threads), 0), 1),
  EXISTS (SELECT 1 FROM public.claude_threads)
);

-- ─── 5. Constraints + lookup index ─────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_claude_threads_serial_display ON public.claude_threads(serial_display);
CREATE INDEX IF NOT EXISTS idx_claude_threads_serial ON public.claude_threads(serial);
