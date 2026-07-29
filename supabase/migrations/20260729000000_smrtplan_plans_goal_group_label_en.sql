-- Bilingual goal + group_label for smrtPlan plans (English display slot).
--
-- smrtplan_plans already carries a bilingual title via title_he + title_en, and
-- the board/table pick by locale (`locale === "en" ? title_en || title_he : title_he`).
-- The plan `goal` (shown on cards / overview) and `group_label` (the board/table
-- SECTION header) had only a single column, authored in Hebrew — so under an
-- English display they rendered Hebrew. These two columns add the English slot,
-- mirroring the title pattern:
--
--   goal / group_label          — Hebrew / default slot (unchanged).
--   goal_en / group_label_en     — English slot; display falls back to the base
--                                  column when null.
--
-- group_label stays the language-independent GROUPING KEY (the board groups by
-- it); only the displayed section header is localized via group_label_en.
--
-- Additive and nullable: existing plans are unaffected (the `_en` columns start
-- null, so Hebrew display keeps showing the base column and English display
-- falls back to it exactly as before).

ALTER TABLE smrtplan_plans
  ADD COLUMN IF NOT EXISTS goal_en text,
  ADD COLUMN IF NOT EXISTS group_label_en text;

COMMENT ON COLUMN smrtplan_plans.goal_en IS
  'English goal. Mirrors title_he/title_en: `goal` is the Hebrew/default slot, this is the English one; board/overview display picks by locale.';
COMMENT ON COLUMN smrtplan_plans.group_label_en IS
  'English section-header label. `group_label` stays the grouping key; this only localizes the displayed header (display falls back to group_label when null).';
