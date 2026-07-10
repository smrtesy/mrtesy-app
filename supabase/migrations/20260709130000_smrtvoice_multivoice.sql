-- smrtVoice: multi-voice casting. A script speaker can be cast to several
-- characters — the line is then rendered once per voice, and each render is a
-- separate take (marked good and labelled by character).

-- Additional characters a speaker is also recorded by. The primary voice stays
-- in character_id; each extra adds one take per line of that speaker.
alter table public.smrtvoice_script_speakers
  add column if not exists extra_character_ids uuid[] not null default '{}';

-- The character/voice a multi-voice take was rendered with (studio label +
-- download filename). Null for ordinary single-voice takes.
alter table public.smrtvoice_line_takes
  add column if not exists voice_label text;

comment on column public.smrtvoice_script_speakers.extra_character_ids is
  'Additional characters this speaker is also recorded by (multi-voice); primary is character_id, each extra adds one take per line.';
comment on column public.smrtvoice_line_takes.voice_label is
  'Character/voice name for a multi-voice take; null for single-voice takes.';
