-- ============================================================
-- smrtVoice — Pronunciation editing, take history, approvals
-- ============================================================
-- Companion to the voice-engine notation-agnostic pronunciation rework:
--   * lexicon entries gain a `language` (Hebrew respelling vs Latin
--     transliteration) and the uniqueness key becomes per-language.
--   * `pronounced_as` now means a PHONETIC RESPELLING sent to Resemble
--     verbatim — NOT niqqud. The old niqqud seed values were wrong.
--   * lines can be marked as a "good recording" (approved).
--   * every render is kept as a take (smrtvoice_line_takes) instead of
--     overwriting the previous clip.
-- All additive; existing rows keep working.

-- ─── LEXICON: per-language phonetic respellings ──────────────
ALTER TABLE smrtvoice_pronunciation_lexicon
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'he'
    CHECK (language IN ('he','en'));

-- The same word can now carry both a Hebrew respelling and a Latin
-- transliteration, chosen per-word. Move the uniqueness key to include
-- language. Drop the old (org_id, original_word) unique constraint by
-- discovering it (the auto-generated name can vary), then add the new one.
-- Leaving the old constraint in place would block a second entry for the
-- same word in another language, defeating the feature.
DO $$
DECLARE
  con record;
  want int[] := ARRAY(
    SELECT attnum FROM pg_attribute
     WHERE attrelid = 'smrtvoice_pronunciation_lexicon'::regclass
       AND attname IN ('org_id','original_word')
  );
BEGIN
  FOR con IN
    SELECT conname, conkey
      FROM pg_constraint
     WHERE conrelid = 'smrtvoice_pronunciation_lexicon'::regclass
       AND contype = 'u'
  LOOP
    -- Match the constraint whose columns are exactly {org_id, original_word}.
    -- Cast conkey (smallint[]) to int[] so the array comparison is well-typed.
    IF (SELECT array_agg(k::int ORDER BY k) FROM unnest(con.conkey) AS k)
       = (SELECT array_agg(k ORDER BY k) FROM unnest(want) AS k) THEN
      EXECUTE format(
        'ALTER TABLE smrtvoice_pronunciation_lexicon DROP CONSTRAINT %I',
        con.conname
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'smrtvoice_pronunciation_lexicon_org_lang_word_key'
  ) THEN
    ALTER TABLE smrtvoice_pronunciation_lexicon
      ADD CONSTRAINT smrtvoice_pronunciation_lexicon_org_lang_word_key
      UNIQUE (org_id, language, original_word);
  END IF;
END $$;

-- Clean the auto-seeded niqqud rows: they only ever came from
-- smrtvoice_seed_default_dictionaries (below), and niqqud in `pronounced_as`
-- is exactly the bug. Scope tightly — only rows whose original_word is one of
-- the seeded words AND whose replacement still contains niqqud
-- (Hebrew points/accents U+0591–U+05C7). A user's own phonetic entry (plain
-- Hebrew or Latin, no niqqud) never matches, so hand-authored data is safe.
DELETE FROM smrtvoice_pronunciation_lexicon
 WHERE pronounced_as ~ '[֑-ׇ]'
   AND original_word IN (
     'שרהלה','חוהלה','מנדלה','דובילה',
     'שרהל''ה','חוה''לה','מנדל''ה','דובי''לה',
     'התקשרות','ביטול','מסירות נפש','אהבת ישראל','בעל תשובה',
     'אחדות','התבוננות','מבצעים','מצוות','תניא','שיחה','שיחות'
   );

-- Rewrite the seed helper: no more niqqud dictionaries. Orgs build their
-- lexicon through the UI with correct phonetic respellings (Hebrew or Latin);
-- the only thing seeding still guarantees is the settings row.
CREATE OR REPLACE FUNCTION smrtvoice_seed_default_dictionaries(
  target_org_id  uuid,
  target_user_id uuid
)
RETURNS void AS $$
BEGIN
  -- Pronunciation entries are intentionally NOT seeded anymore. The previous
  -- seed shipped niqqud values (e.g. שרהלה→שָׂרָלֶה) which resemble-ultra
  -- mispronounces; `pronounced_as` now holds a phonetic respelling authored
  -- per-org via the lexicon UI. target_user_id is kept for signature stability.
  PERFORM target_user_id;

  INSERT INTO smrtvoice_settings (org_id)
  VALUES (target_org_id)
  ON CONFLICT (org_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── LINES: approvals ────────────────────────────────────────
ALTER TABLE smrtvoice_lines
  -- "This take is good" — a manual quality mark, independent of status.
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false;

-- ─── LINE TAKES: full render history (never overwrite) ───────
CREATE TABLE IF NOT EXISTS smrtvoice_line_takes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  line_id           uuid NOT NULL REFERENCES smrtvoice_lines(id) ON DELETE CASCADE,
  script_id         uuid REFERENCES smrtvoice_scripts(id) ON DELETE CASCADE,

  -- What was actually sent to Resemble for this take (text + embedded tags).
  text_used         text,
  -- The model that produced it and where the audio lives (unique per take).
  model             text,
  output_audio_path text NOT NULL,
  duration_seconds  numeric,
  cost_usd          numeric,

  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_line_takes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtvoice_line_takes_org_members" ON smrtvoice_line_takes;
CREATE POLICY "smrtvoice_line_takes_org_members" ON smrtvoice_line_takes
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_line_takes_line_idx
  ON smrtvoice_line_takes(line_id, created_at DESC);

-- Live-update the takes list as each render lands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='smrtvoice_line_takes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE smrtvoice_line_takes';
  END IF;
END $$;
