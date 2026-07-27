-- smrtStudio — catalog indexer fields.
--
-- Two things this adds, both driven by what the program actually needs:
--
-- 1. AUDIO-DRIVEN VIDEO AS ITS OWN CATEGORY. "Video" is not one thing for us.
--    A model that only animates a still is a different tool from one that takes
--    OUR recording and drives the clip from it — the second is what the series
--    needs, because it can collapse the motion and lip-sync stages into one
--    call. fal's `category` cannot tell them apart: `image-to-video` contains
--    both. The only reliable signal is the endpoint's own OpenAPI schema — an
--    audio INPUT field, and then the field's `description`, because the same
--    field name covers three different jobs:
--      driving   — our audio drives lip/motion. This is the class we want.
--      reference — audio guides generation; lip-sync to our track is a guess.
--      mux       — the audio is just pasted onto the output (background music).
--                  Lips do NOT sync. Choosing by field name alone falls in here.
--    `audio_note` keeps fal's wording verbatim so the classification is
--    auditable rather than asserted.
--
-- 2. PIPELINE ORDER. The catalog is sorted the way the work actually flows —
--    characters, voices, sets, frames, motion, lip-sync — not alphabetically
--    and not by fal's taxonomy. `stage_order` is that position, and it is
--    stored rather than derived so ordering costs no join.

alter table public.studio_models
  -- null = no audio input at all. Otherwise the ROLE the audio plays.
  add column if not exists audio_input text
    check (audio_input is null or audio_input in ('driving','reference','mux')),
  -- the input field's exact name in the schema (audio_url, audio_urls, …)
  add column if not exists audio_field text,
  -- fal's own description of that field, verbatim — the evidence for the role
  add column if not exists audio_note text,
  -- which pipeline stage this model serves, and its position in the flow
  add column if not exists stage_slug text,
  add column if not exists stage_order integer not null default 99,
  -- fal's raw category, kept alongside our coarser `kind`
  add column if not exists fal_category text,
  -- when the catalog sweep last saw this row (distinct from verified_at, which
  -- means "we pulled and read its OpenAPI schema")
  add column if not exists indexed_at timestamptz,
  -- true once the OpenAPI schema was fetched for the audio probe. Separate from
  -- verified_schema, which is the stronger claim that a human wrote a recipe
  -- against the verified contract.
  add column if not exists audio_probed boolean not null default false;

create index if not exists studio_models_stage_idx
  on public.studio_models (org_id, stage_order, shortlist_rank);
create index if not exists studio_models_audio_idx
  on public.studio_models (org_id, audio_input);

-- Backfill the pipeline order for the rows already seeded. The mapping is the
-- program's own stage list: 3 characters · 4 voices · 6 frames · 7 motion ·
-- 8 lip-sync, and 99 for anything cross-cutting like QC.
update public.studio_models set
  stage_slug = case kind
    when 'image'   then 'chars'
    when 'voice'   then 'voice'
    when 'video'   then 'motion'
    when 'lipsync' then 'lipsync'
    when 'qc'      then null
    else null end,
  stage_order = case kind
    when 'image'   then 3
    when 'voice'   then 4
    when 'video'   then 7
    when 'lipsync' then 8
    when 'qc'      then 98
    else 99 end
where stage_slug is null;

-- The three video models already known to take our audio as a DRIVING input,
-- from the sweep recorded in video-lab's shortlist-audio-input.json. Their
-- descriptions are re-read from the live schema by the indexer's audio probe;
-- these rows just make the category non-empty before the first probe runs.
update public.studio_models
   set kind = 'video_audio', stage_order = 7, stage_slug = 'motion'
 where endpoint_id in ('fal-ai/ltx-2.3-22b/audio-to-video',
                       'fal-ai/wan/v2.7/image-to-video');

-- Two endpoint ids were transcribed wrong into the original seed. The recipes in
-- video-lab had them right; the seed did not. Verified against fal's live
-- catalog: neither of the old ids exists, both of the new ones do.
--   fal-ai/chatterbox/multilingual      → fal-ai/chatterbox/text-to-speech/multilingual
--   fal-ai/chatterboxhd/speech-to-speech → resemble-ai/chatterboxhd/speech-to-speech
-- Left as an UPDATE rather than a delete+insert so the row keeps its identity.
update public.studio_models
   set endpoint_id = 'fal-ai/chatterbox/text-to-speech/multilingual',
       source_url  = 'https://fal.ai/models/fal-ai/chatterbox/text-to-speech/multilingual'
 where endpoint_id = 'fal-ai/chatterbox/multilingual'
   and not exists (select 1 from public.studio_models x
                    where x.org_id = studio_models.org_id
                      and x.endpoint_id = 'fal-ai/chatterbox/text-to-speech/multilingual');

update public.studio_models
   set endpoint_id = 'resemble-ai/chatterboxhd/speech-to-speech',
       source_url  = 'https://fal.ai/models/resemble-ai/chatterboxhd/speech-to-speech'
 where endpoint_id = 'fal-ai/chatterboxhd/speech-to-speech'
   and not exists (select 1 from public.studio_models x
                    where x.org_id = studio_models.org_id
                      and x.endpoint_id = 'resemble-ai/chatterboxhd/speech-to-speech');
