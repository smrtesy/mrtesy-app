-- Studio unified spine — voice projection (docs/studio-production-pipeline.md).
--
-- Projects each rendered voice take (smrtvoice_line_takes) into studio_artifacts
-- as a type='voice' row, so the spine now covers voice alongside image/video.
-- This is the FIRST step of the staged voice migration and it is deliberately
-- NON-INVASIVE: the voice engine is untouched — the projection is a DB-side
-- trigger that fires when the engine inserts a take (it writes takes best-effort
-- via service role). The trigger is defensive: any projection error is swallowed
-- (WARNING) so it can never break the engine's take write.
--
-- studio_project_id is resolved take → script → project (smrtvoice_projects, whose
-- studio_project_id was backfilled in 20260730120000); the audio is a storage PATH
-- (bucket smrtvoice-audio, signed on demand), so it goes in meta.audio_path, not
-- output_url. Keyed on voice_take_id (the spine's partial unique index).

create or replace function public.studio_artifacts_sync_from_take()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_studio_project uuid;
  v_shot_seq       integer;
begin
  begin
    select p.studio_project_id, l.shot_seq
      into v_studio_project, v_shot_seq
      from public.smrtvoice_scripts s
      join public.smrtvoice_projects p on p.id = s.project_id
      left join public.smrtvoice_lines l on l.id = new.line_id
      where s.id = new.script_id
      limit 1;

    insert into public.studio_artifacts as a (
      org_id, studio_project_id, type, script_id, shot_seq,
      status, model, cost_usd, voice_take_id, voice_line_id, meta, updated_at
    ) values (
      new.org_id, v_studio_project, 'voice', new.script_id, v_shot_seq,
      case when new.approved then 'approved' else 'completed' end,
      new.model, new.cost_usd, new.id, new.line_id,
      jsonb_build_object(
        'audio_path', new.output_audio_path,
        'duration_seconds', new.duration_seconds,
        'voice_label', new.voice_label,
        'resemble_voice_id', new.resemble_voice_id,
        'text_used', new.text_used),
      now()
    )
    on conflict (voice_take_id) where voice_take_id is not null
    do update set
      studio_project_id = excluded.studio_project_id,
      shot_seq          = excluded.shot_seq,
      status            = excluded.status,
      model             = excluded.model,
      cost_usd          = excluded.cost_usd,
      meta              = a.meta || excluded.meta,
      updated_at        = now();
  exception when others then
    raise warning 'studio_artifacts voice projection failed for take %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists studio_artifacts_from_take on public.smrtvoice_line_takes;
create trigger studio_artifacts_from_take
  after insert or update on public.smrtvoice_line_takes
  for each row execute function public.studio_artifacts_sync_from_take();

-- backfill existing takes
insert into public.studio_artifacts (
  org_id, studio_project_id, type, script_id, shot_seq,
  status, model, cost_usd, voice_take_id, voice_line_id, meta, created_at, updated_at
)
select t.org_id, p.studio_project_id, 'voice', t.script_id, l.shot_seq,
       case when t.approved then 'approved' else 'completed' end,
       t.model, t.cost_usd, t.id, t.line_id,
       jsonb_build_object(
         'audio_path', t.output_audio_path,
         'duration_seconds', t.duration_seconds,
         'voice_label', t.voice_label,
         'resemble_voice_id', t.resemble_voice_id,
         'text_used', t.text_used),
       t.created_at, now()
from public.smrtvoice_line_takes t
left join public.smrtvoice_scripts s on s.id = t.script_id
left join public.smrtvoice_projects p on p.id = s.project_id
left join public.smrtvoice_lines l on l.id = t.line_id
on conflict (voice_take_id) where voice_take_id is not null do nothing;
