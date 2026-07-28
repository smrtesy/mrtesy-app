-- smrtStudio — the full fal catalog, with each endpoint's contract.
--
-- Brings the studio catalog to what video-lab's `docs/models/catalog.json`
-- holds: all 1,394 endpoints, the capability flags that make them filterable,
-- and the second classification axis. Three things drove this.
--
-- 1. THE SWEEP WAS MISSING A QUARTER OF THE CATALOG. fal's `/api/models` pages
--    OVERLAP: one straight pass over the 35 pages returns ~1,057 unique ids out
--    of a reported 1,394. The old indexer walked page 1..N once and deduped, so
--    it silently indexed 76% of fal and called it complete. The indexer now
--    sweeps until a pass adds nothing new and also walks per-category. Nothing
--    in the schema enforces that, but `catalog_total` on the sweep result does
--    surface it.
--
-- 2. "CAN IT DO THE JOB" WAS NOT ANSWERABLE. Choosing a model means asking
--    whether it takes a start image, an end image, a prompt, a trained LoRA, or
--    two speakers. All of that lives in the OpenAPI schema, which was fetched
--    live per model and never stored — so it could be READ one model at a time
--    but never FILTERED across the catalog. The flags below are stored for
--    filtering; the full field list is still fetched live on open, because a
--    stored copy of someone else's contract goes stale without anyone noticing.
--
-- 3. ONE AXIS WAS NOT ENOUGH. `audio_input` says what a model does with our
--    recording (driving / reference / mux). It does not say what the model
--    BUILDS, and those are independent questions: LTX audio-to-video and
--    sync-lipsync are both `driving`, but one generates a whole shot from the
--    audio and the other only repaints the mouth of a video you already have.
--    `audio_build` is that second axis.
--
-- Everything here is additive; no existing column changes meaning.

alter table public.studio_models
  -- Our seven top-level groups, coarser than `kind` and matching the tabs:
  -- image | video | audio | understanding | 3d | training | tools
  add column if not exists group_key text not null default 'tools',
  -- fal's own model family ("LTX 2.3", "Nano Banana Pro"). The reason 12
  -- full-shot endpoints are really 3 engines, and why a panel should not pay
  -- for eleven tests of the same model.
  add column if not exists family text not null default '',
  -- fal's one-line summary and its longer `about` from x-fal-metadata.
  add column if not exists summary text not null default '',
  add column if not exists about text not null default '',
  add column if not exists published_at date,

  -- Axis 2. Only meaningful when audio_input = 'driving': a model that merely
  -- muxes a track has nothing to build.
  add column if not exists audio_build text
    check (audio_build is null
           or audio_build in ('full_scene','full_body','avatar','mouth_fix')),
  -- Which tier of evidence decided audio_input. 'field_description' means fal's
  -- own wording for that field said so; 'model_purpose' means the field was
  -- described as nothing more than "URL of the input audio" and the class came
  -- from what the endpoint exists to do. The screen shows the difference rather
  -- than implying fal spelled it out.
  add column if not exists audio_classified_from text
    check (audio_classified_from is null
           or audio_classified_from in ('field_description','model_purpose')),

  -- Price. `price_usd`/`price_unit` already exist; these say when a single
  -- number is NOT honest. 245 endpoints price by tier (per resolution, per
  -- quality mode, per step) and fal gives no single figure — those keep
  -- price_usd null and show their prose instead of a number that is wrong.
  add column if not exists price_ambiguous boolean not null default false,
  -- What one reference shot costs, so a per-megapixel price and a per-second
  -- price can be compared at all. Video endpoints only, and only where the unit
  -- makes it derivable.
  add column if not exists shot_estimate_usd numeric,
  add column if not exists shot_estimate_basis text not null default '',

  -- Capability flags, read from the official schema. Stored because filtering
  -- across 1,394 rows cannot fetch 1,394 schemas.
  add column if not exists cap_prompt boolean not null default false,
  add column if not exists cap_negative_prompt boolean not null default false,
  add column if not exists cap_start_image boolean not null default false,
  add column if not exists cap_end_image boolean not null default false,
  add column if not exists cap_video_input boolean not null default false,
  -- A LoRA we trained ourselves. Only the `loras` field counts: `camera_lora`
  -- is a preset LTX ships with and `distill_lora_*` is internal acceleration,
  -- and counting those inflates the number by half.
  add column if not exists cap_lora boolean not null default false,
  add column if not exists cap_seed boolean not null default false,
  -- How many separate audio FILES the endpoint accepts. >1 means two characters
  -- can speak in one shot, which exactly one video model in the catalog allows.
  add column if not exists cap_audio_channels integer not null default 0,
  add column if not exists input_field_count integer not null default 0,
  -- false when fal returns no schema at all — reported, never rendered as
  -- "takes no input".
  add column if not exists schema_available boolean not null default false,

  -- ffmpeg / workflow-utilities: pipeline plumbing (mux a track, merge clips,
  -- burn subtitles, normalise loudness). fal scatters these across four
  -- categories, so they are unfindable among the creative models.
  add column if not exists is_pipeline_tool boolean not null default false,

  -- Our own research, carried per model. Regenerating fal's facts must never
  -- destroy it, so the sweep writes everything else and leaves this alone.
  add column if not exists research_notes jsonb not null default '[]'::jsonb;

create index if not exists studio_models_group_idx
  on public.studio_models (org_id, group_key);
create index if not exists studio_models_build_idx
  on public.studio_models (org_id, audio_build);
create index if not exists studio_models_tool_idx
  on public.studio_models (org_id, is_pipeline_tool)
  where is_pipeline_tool = true;

-- Backfill group_key for rows already on the shelf, from fal's category. The
-- sweep overwrites this, but the screen must not read 'tools' for every row in
-- the window between the migration and the next index run.
update public.studio_models set group_key = case
    when category in ('text-to-image','image-to-image') then 'image'
    when category in ('text-to-video','image-to-video','video-to-video','audio-to-video') then 'video'
    when category in ('text-to-speech','text-to-audio','audio-to-audio',
                      'speech-to-speech','video-to-audio') then 'audio'
    when category in ('vision','speech-to-text','image-to-text','video-to-text',
                      'audio-to-text','image-to-json') then 'understanding'
    when category in ('image-to-3d','text-to-3d','3d-to-3d') then '3d'
    when category = 'training' then 'training'
    else 'tools' end
where group_key = 'tools';

-- Same for the pipeline-tool flag, which is derivable from the endpoint id.
update public.studio_models
   set is_pipeline_tool = true
 where endpoint_id like '%ffmpeg-api%'
    or endpoint_id like '%workflow-utilities%';
