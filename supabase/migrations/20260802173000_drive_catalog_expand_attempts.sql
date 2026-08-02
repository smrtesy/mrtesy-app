-- Per-folder expansion attempt tracking, so a folder whose Drive listing keeps
-- failing (transient 429/5xx or a persistent permission error) is retried a
-- bounded number of times and then given up (marked folder_expanded=true with
-- expand_error) instead of sitting in the BFS frontier forever and making the
-- self-kicking scan busy-loop the Drive API. Additive columns only.

ALTER TABLE public.drive_catalog
  ADD COLUMN IF NOT EXISTS expand_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expand_error    text;
