-- smrtVoice: takes are now MULTI-select "good" marks (⭐), not a single "in use"
-- pick. A line's play / download / archive and its outer indicator all follow
-- the SET of good takes. Reconcile legacy data to the new invariant:
--     line.approved  ==  (the line has >= 1 good take)
--
-- No schema change — behavioural + data fix only.

-- 1) Lines flagged approved but with NO good take (the old single-select never
--    tied the outer flag to a specific take): mark the take whose audio IS the
--    line's current output as good, so the indicator keeps pointing at a real,
--    highlighted take. Every such line matched exactly one take.
update public.smrtvoice_line_takes t
set approved = true
from public.smrtvoice_lines l
where t.line_id = l.id
  and t.output_audio_path = l.output_audio_path
  and l.approved = true
  and not exists (
    select 1 from public.smrtvoice_line_takes t2
    where t2.line_id = l.id and t2.approved = true
  );

-- 2) Re-sync every line's indicator to reality (also fixes a line with 2 good
--    takes whose flag was left false by the old single-select logic, e.g. a
--    line where the user marked two takes to stitch parts of each).
update public.smrtvoice_lines l
set approved = exists (
  select 1 from public.smrtvoice_line_takes t
  where t.line_id = l.id and t.approved = true
)
where l.approved <> exists (
  select 1 from public.smrtvoice_line_takes t
  where t.line_id = l.id and t.approved = true
);
