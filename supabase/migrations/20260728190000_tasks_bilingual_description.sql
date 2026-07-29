-- Bilingual description + definition-of-done for tasks (smrtPlan display language).
--
-- Tasks already carry a bilingual title via `title` (English/default slot) +
-- `title_he`, and smrtPlan display picks by the SYSTEM locale
-- (`locale === "en" ? title : title_he || title`). Descriptions and the
-- definition-of-done had only a single column, so under an English display the
-- text fell back to whatever language the author typed (Hebrew, for the
-- Claude-authored video pilot) — which read as "task language depends on the
-- worker". These two columns mirror the title pattern so description / DoD
-- follow the system display language too:
--
--   description / definition_of_done      — English / default slot (unchanged).
--   description_he / definition_of_done_he — Hebrew slot; display falls back to
--                                            the base column when null.
--
-- Additive and nullable: every existing task is unaffected (the `_he` columns
-- start null, so Hebrew display keeps showing the base column exactly as before,
-- and English display is unchanged).

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS description_he text,
  ADD COLUMN IF NOT EXISTS definition_of_done_he text;

COMMENT ON COLUMN tasks.description_he IS
  'Hebrew description. Mirrors title/title_he: `description` is the English/default slot, this is the Hebrew one; smrtPlan display picks by system locale.';
COMMENT ON COLUMN tasks.definition_of_done_he IS
  'Hebrew "stranger test" done-criterion. Mirrors definition_of_done (English/default slot); smrtPlan display picks by system locale.';
