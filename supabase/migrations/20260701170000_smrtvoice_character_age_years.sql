-- smrtVoice: store a character's age as an exact number.
--
-- The form used an age_group enum (child/teen/adult/elderly); the user wants
-- to type the actual age (e.g. 7). Add a nullable integer alongside the enum
-- (enum kept for back-compat; new UI writes age_years).

ALTER TABLE smrtvoice_characters
  ADD COLUMN IF NOT EXISTS age_years smallint
  CHECK (age_years IS NULL OR (age_years >= 0 AND age_years <= 120));
