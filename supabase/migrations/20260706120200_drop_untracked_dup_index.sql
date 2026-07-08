-- idx_tasks_source_msg existed only in the live DB (not in repo migrations)
-- and is byte-identical to idx_tasks_source_message created in
-- 20260706120100_perf_indexes.sql. Keep the repo-tracked one.
DROP INDEX IF EXISTS public.idx_tasks_source_msg;
