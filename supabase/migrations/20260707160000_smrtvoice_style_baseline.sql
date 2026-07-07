-- smrtVoice: per-character "style profile" baseline tags.
--
-- The fix for "every character shares the same melody even with a distinct
-- voice clone". `personality_prompt` (already present) steers the LLM's
-- per-line emotion choice in character; this column adds the acoustic backbone:
-- a list of Resemble WRAP tags applied to EVERY line of the character so its
-- register / pace / volume stays consistent and distinct (e.g. an elderly
-- character = ["lower-pitch","slow"], an excitable child = ["higher-pitch"]).
--
-- Values are validated against the real WRAP_TAGS palette in the voice-engine
-- (baseline_tags() drops anything unknown), so no DB CHECK is imposed here —
-- the column just carries a JSON array of tag-name strings. Default [] means
-- "no baseline" → behaves exactly as before for existing characters.

alter table public.smrtvoice_characters
  add column if not exists style_baseline_tags jsonb not null default '[]'::jsonb;

comment on column public.smrtvoice_characters.style_baseline_tags is
  'Resemble WRAP tag names applied to every line as the character''s register/pace baseline (e.g. ["lower-pitch","slow"]). Empty = no baseline.';
