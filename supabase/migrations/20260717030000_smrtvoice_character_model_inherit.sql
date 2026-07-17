-- smrtVoice: make per-character resemble_model INHERIT the org default.
--
-- The column defaulted to 'resemble-ultra', so every new character was frozen
-- on Ultra at creation. Because generation resolves the model as
-- `character.resemble_model ?? settings.default_resemble_model`, a non-null
-- per-character value silently overrode the system-wide model switch — the
-- one-button ultra <-> chatterbox toggle never reached existing characters.
--
-- Fix: default the column to NULL so a character has no model of its own unless
-- one is set explicitly, and it always follows the current org default. Also
-- clear the historical 'resemble-ultra' snapshots that were only ever the old
-- default (an explicit, user-chosen per-character model is out of scope today —
-- there is no UI to set one — so every existing value is a frozen default).

ALTER TABLE smrtvoice_characters
  ALTER COLUMN resemble_model SET DEFAULT NULL;

UPDATE smrtvoice_characters
   SET resemble_model = NULL
 WHERE resemble_model = 'resemble-ultra';
