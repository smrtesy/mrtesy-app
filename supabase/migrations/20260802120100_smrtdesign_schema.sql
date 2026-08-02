-- ============================================================
-- smrtDesign — Database Schema
-- ============================================================
-- Three tables, all org-scoped under RLS (org_members pattern, mirrors
-- smrtvoice): projects (a design brief/subject), options (generated design
-- options, incl. remixed "combined" ones), selections (the pick-from-each
-- remix that produced a combined option).
--
-- The generation/remix engine is the built-in Claude console
-- (server/src/modules/claude): a project drives a claude_threads thread whose
-- turns run the design-process method and post rendered screenshots back.
-- `thread_id` links to that thread (plain uuid, no FK — keeps smrtDesign
-- decoupled from the claude_* tables; the app logic owns the link).

-- ─── 1. PROJECTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtdesign_projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES auth.users(id),

  name          text NOT NULL,
  subject       text NOT NULL,               -- what is being designed
  audience      text,                         -- who it's for
  languages     text[] NOT NULL DEFAULT '{he}', -- e.g. {he}, {en}, {he,en}
  option_count  integer NOT NULL DEFAULT 4 CHECK (option_count BETWEEN 1 AND 8),

  brief_json    jsonb NOT NULL DEFAULT '{}'::jsonb, -- the locked brief once chosen (§9 of the method)
  thread_id     uuid,                          -- driving claude_threads thread (no FK by design)

  status        text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','generating','options_ready','locked','failed'
  )),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtdesign_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtdesign_projects_org_members" ON smrtdesign_projects
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtdesign_projects_org_idx    ON smrtdesign_projects(org_id);
CREATE INDEX IF NOT EXISTS smrtdesign_projects_status_idx ON smrtdesign_projects(org_id, status);


-- ─── 2. OPTIONS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtdesign_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES smrtdesign_projects(id) ON DELETE CASCADE,

  round         integer NOT NULL DEFAULT 1,   -- 1 = first generation, higher = refinement/remix rounds
  anchor        text,                          -- the subject-specific anchor it was derived from (§0 step 2)
  title         text,

  -- The 7-dimension spec (§4): { typography, color, neutral, layout, motion, signature, voice }.
  -- This is what the remix (§4 mechanism) recombines and re-renders.
  spec_json     jsonb NOT NULL DEFAULT '{}'::jsonb,

  image_url     text,                          -- rendered screenshot (storage / signed URL)
  html_path     text,                          -- optional: the rendered artifact source in the thread workspace

  is_combined   boolean NOT NULL DEFAULT false, -- produced by remix (§4)
  is_locked     boolean NOT NULL DEFAULT false, -- chosen as the project's design

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtdesign_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtdesign_options_org_members" ON smrtdesign_options
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtdesign_options_project_idx ON smrtdesign_options(project_id, round);


-- ─── 3. SELECTIONS ───────────────────────────────────────────
-- The pick-from-each remix: for each dimension, which source option it was
-- taken from → the combined option that was rendered from the merged spec.
CREATE TABLE IF NOT EXISTS smrtdesign_selections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES smrtdesign_projects(id) ON DELETE CASCADE,
  created_by         uuid NOT NULL REFERENCES auth.users(id),

  -- { dimension: source_option_id } — e.g. { "typography": "<opt1>", "color": "<opt3>" }
  picks_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
  combined_option_id uuid REFERENCES smrtdesign_options(id) ON DELETE SET NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtdesign_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtdesign_selections_org_members" ON smrtdesign_selections
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtdesign_selections_project_idx ON smrtdesign_selections(project_id);


-- ─── TRIGGERS (updated_at) ───────────────────────────────────
CREATE OR REPLACE FUNCTION smrtdesign_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS smrtdesign_projects_updated_at ON smrtdesign_projects;
CREATE TRIGGER smrtdesign_projects_updated_at BEFORE UPDATE ON smrtdesign_projects
  FOR EACH ROW EXECUTE FUNCTION smrtdesign_update_updated_at();

DROP TRIGGER IF EXISTS smrtdesign_options_updated_at ON smrtdesign_options;
CREATE TRIGGER smrtdesign_options_updated_at BEFORE UPDATE ON smrtdesign_options
  FOR EACH ROW EXECUTE FUNCTION smrtdesign_update_updated_at();

DROP TRIGGER IF EXISTS smrtdesign_selections_updated_at ON smrtdesign_selections;
CREATE TRIGGER smrtdesign_selections_updated_at BEFORE UPDATE ON smrtdesign_selections
  FOR EACH ROW EXECUTE FUNCTION smrtdesign_update_updated_at();
