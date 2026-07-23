-- Auto-QC fields on experiment_runs (video-lab). The QC filter's verdict is
-- stored and NEVER deletes; rejected runs stay viewable + human-overridable
-- from the app. Idempotent (already applied via MCP).
alter table public.experiment_runs
  add column if not exists qc_status text not null default 'pending',    -- pending|pass|rejected
  add column if not exists qc_score numeric,                             -- overall auto score
  add column if not exists qc_reason text,                               -- why flagged/rejected
  add column if not exists qc_scores jsonb not null default '{}'::jsonb,  -- per-metric (face_sim, lipsync, ...)
  add column if not exists overridden boolean not null default false;    -- human rescued a rejected run

create index if not exists experiment_runs_qc_status_idx on public.experiment_runs (org_id, qc_status);
