-- smrtVoice: soft-archive for studio lines. Archived lines are hidden from the
-- normal studio view (and from play-all / download-all / Drive archive) but are
-- kept and reversible. A separate "delete" hard-removes the line, and its takes
-- cascade via the smrtvoice_line_takes.line_id FK.
alter table public.smrtvoice_lines
  add column if not exists archived_at timestamptz;

comment on column public.smrtvoice_lines.archived_at is
  'When set, the line is archived (soft-hidden from the studio); null = active.';
