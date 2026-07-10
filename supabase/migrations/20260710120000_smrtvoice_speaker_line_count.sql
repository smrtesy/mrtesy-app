-- Per-speaker parsed line count, populated on each script parse.
--
-- The casting screen shows how many lines each speaker has. That count used to
-- be derived from smrtvoice_lines, which only exist AFTER generation and are
-- removed by the bulk-delete tool — so deleting generated audio (or viewing a
-- freshly parsed script) wrongly showed 0 lines for real speakers. This column
-- stores the count from the parser (the script's true line distribution),
-- refreshed on every "Parse", independent of generation.
ALTER TABLE smrtvoice_script_speakers
  ADD COLUMN IF NOT EXISTS line_count integer NOT NULL DEFAULT 0;
