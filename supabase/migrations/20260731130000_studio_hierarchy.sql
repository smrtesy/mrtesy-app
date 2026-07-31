-- Studio production hierarchy: project → (optional) script → (optional) shot →
-- voice / image / video, with optional cross-type source links so a video can
-- carry the voice take + image it was composed from.
-- Design: docs/studio-hierarchy-plan.md. All columns are ADDITIVE and NULLABLE —
-- standalone artifacts (e.g. video-from-prompt) leave them null; structured
-- production fills them in. No existing behavior changes. Forward-only.

-- 1) Script rises to project level — the structural spine of the whole project,
--    not voice-only. project_id (the smrtvoice_projects container) stays for now
--    because the voice engine still reads language/model from it; a later step
--    retires that layer once the engine is weaned off it.
ALTER TABLE public.smrtvoice_scripts
  ADD COLUMN IF NOT EXISTS studio_project_id uuid
    REFERENCES public.studio_projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS smrtvoice_scripts_studio_project_idx
  ON public.smrtvoice_scripts(studio_project_id, seq);

-- 2) Cross-type unit of division. A "shot" is one segment/clip; voice line,
--    image and video of the same shot share this seq under the same script.
--    Optional — null means "not organized into a shot".
ALTER TABLE public.smrtvoice_lines
  ADD COLUMN IF NOT EXISTS shot_seq integer;

ALTER TABLE public.experiment_runs
  ADD COLUMN IF NOT EXISTS shot_seq integer;

-- 3) Link image/video runs into the hierarchy, and let a video name the exact
--    voice take + image it was built from. All nullable → a prompt-only run
--    leaves every one of these null.
ALTER TABLE public.experiment_runs
  ADD COLUMN IF NOT EXISTS script_id uuid
    REFERENCES public.smrtvoice_scripts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_voice_line_id uuid
    REFERENCES public.smrtvoice_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_image_run_id uuid
    REFERENCES public.experiment_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS experiment_runs_script_shot_idx
  ON public.experiment_runs(script_id, shot_seq);
CREATE INDEX IF NOT EXISTS experiment_runs_source_voice_idx
  ON public.experiment_runs(source_voice_line_id)
  WHERE source_voice_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS experiment_runs_source_image_idx
  ON public.experiment_runs(source_image_run_id)
  WHERE source_image_run_id IS NOT NULL;
