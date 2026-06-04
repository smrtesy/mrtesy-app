-- ============================================================
-- smrtPlan — Database Schema (Stage 1)
-- ============================================================
-- Authoritative DDL from smrtplan-build-spec.md §3.
--
-- Order matters: smrtplan_plans must exist before the tasks ALTER (tasks
-- gains a plan_id FK to it), and tasks must exist before
-- smrtplan_episode_stage_status (which FKs task_id). The block below follows
-- that dependency order:
--   1. app_user_access            (full/lite access level per user × app)
--   2. smrtplan_plans             (the plan — born in smrtPlan)
--   3. ALTER tasks                (plan_id, hierarchy, engine, assignment, privacy)
--   4. smrtplan_stages            (stream stages: content → script → ...)
--   5. smrtplan_episodes          (stream instances: episodes)
--   6. smrtplan_episode_stage_status (matrix cell, linked to a task)
--   7. smrtplan_dependencies      (the path: plan/stage/task → plan/stage/task)
--
-- Every smrtPlan table is org-scoped. RLS for the new tables is defined inline
-- here (org-member based, with private-plan refinement on smrtplan_plans). The
-- is_private RLS rewrite for the shared `tasks` table lives in the next
-- migration (20260604000200) so the existing smrtTask policy is replaced in a
-- reviewable, isolated change.


-- ─── shared updated_at trigger fn (idempotent) ───────────────
CREATE OR REPLACE FUNCTION smrtplan_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ─── 1. APP_USER_ACCESS ──────────────────────────────────────
-- Access level (full = creator/planner, lite = consumer) per user × app.
-- Enforced in the UI/API layer; RLS just lets org members read their rows.
CREATE TABLE IF NOT EXISTS app_user_access (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_level text NOT NULL CHECK (access_level IN ('full','lite')),
  granted_by   uuid REFERENCES auth.users(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, app_id, user_id)
);

ALTER TABLE app_user_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_user_access_org_members" ON app_user_access;
CREATE POLICY "app_user_access_org_members" ON app_user_access
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS app_user_access_user_idx ON app_user_access(user_id);
CREATE INDEX IF NOT EXISTS app_user_access_org_app_idx ON app_user_access(org_id, app_id);


-- ─── 2. SMRTPLAN_PLANS ───────────────────────────────────────
-- A plan: effort (task container) or stream (episode × stage matrix).
-- Hierarchy via parent_id (a parent plan = a group / sub-track).
-- start_date NULL => the plan lives in the repository (not on the timeline).
CREATE TABLE IF NOT EXISTS smrtplan_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES smrtplan_plans(id) ON DELETE SET NULL,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  title_he        text NOT NULL,
  title_en        text,
  goal            text,
  kind            text NOT NULL CHECK (kind IN ('effort','stream')),
  group_label     text,
  start_date      date,
  end_date        date,
  stage           text NOT NULL DEFAULT 'active' CHECK (stage IN ('idea','shaping','active')),
  progress        real NOT NULL DEFAULT 0,
  progress_manual real,
  is_critical     boolean NOT NULL DEFAULT false,
  color           text,
  is_private      boolean NOT NULL DEFAULT false,
  owner_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtplan_plans ENABLE ROW LEVEL SECURITY;
-- Private plan => owner only. Shared plan => any org member (role refinement
-- in the API layer). Mirrors the tasks is_private rule.
DROP POLICY IF EXISTS "smrtplan_plans_visibility" ON smrtplan_plans;
CREATE POLICY "smrtplan_plans_visibility" ON smrtplan_plans
  USING (
    (is_private = true  AND owner_user_id = auth.uid())
    OR
    (is_private = false AND org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  )
  WITH CHECK (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );
CREATE INDEX IF NOT EXISTS smrtplan_plans_org_idx       ON smrtplan_plans(org_id);
CREATE INDEX IF NOT EXISTS smrtplan_plans_parent_idx    ON smrtplan_plans(parent_id);
CREATE INDEX IF NOT EXISTS smrtplan_plans_repository_idx ON smrtplan_plans(org_id) WHERE start_date IS NULL;

DROP TRIGGER IF EXISTS smrtplan_plans_updated_at ON smrtplan_plans;
CREATE TRIGGER smrtplan_plans_updated_at BEFORE UPDATE ON smrtplan_plans
  FOR EACH ROW EXECUTE FUNCTION smrtplan_update_updated_at();


-- ─── 3. ALTER tasks — plan link, hierarchy, engine, assignment, privacy ──
-- Additive only; no existing column is touched. is_private defaults to true so
-- NO existing personal task is exposed when the new tasks RLS lands.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS plan_id            uuid REFERENCES smrtplan_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS duration_days      int,
  ADD COLUMN IF NOT EXISTS earliest_start     date,
  ADD COLUMN IF NOT EXISTS latest_start       date,
  ADD COLUMN IF NOT EXISTS latest_finish      date,
  ADD COLUMN IF NOT EXISTS is_critical        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assignment_status  text NOT NULL DEFAULT 'accepted'
     CHECK (assignment_status IN ('proposed','accepted','declined')),
  ADD COLUMN IF NOT EXISTS proposed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_private         boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS tasks_plan_idx        ON tasks(plan_id)        WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_parent_task_idx ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;


-- ─── 4. SMRTPLAN_STAGES ──────────────────────────────────────
-- Stream stages (content → script → recording → ...). Ordered by `sequence`.
CREATE TABLE IF NOT EXISTS smrtplan_stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id       uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  name_he       text NOT NULL,
  name_en       text,
  sequence      int NOT NULL,
  required_role text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtplan_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_stages_org_members" ON smrtplan_stages;
CREATE POLICY "smrtplan_stages_org_members" ON smrtplan_stages
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_stages_plan_idx ON smrtplan_stages(plan_id, sequence);


-- ─── 5. SMRTPLAN_EPISODES ────────────────────────────────────
-- Stream instances (episodes / chapters). Ordered by `sequence`.
CREATE TABLE IF NOT EXISTS smrtplan_episodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  name_he     text NOT NULL,
  name_en     text,
  family      text,
  due_date    date,
  sequence    int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtplan_episodes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_episodes_org_members" ON smrtplan_episodes;
CREATE POLICY "smrtplan_episodes_org_members" ON smrtplan_episodes
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_episodes_plan_idx ON smrtplan_episodes(plan_id, sequence);


-- ─── 6. SMRTPLAN_EPISODE_STAGE_STATUS (matrix cell) ──────────
-- One cell of the stream matrix: the status of a stage for an episode, linked
-- to the executing task in smrtTask.
CREATE TABLE IF NOT EXISTS smrtplan_episode_stage_status (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  episode_id   uuid NOT NULL REFERENCES smrtplan_episodes(id) ON DELETE CASCADE,
  stage_id     uuid NOT NULL REFERENCES smrtplan_stages(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','prog','done')),
  task_id      uuid REFERENCES tasks(id) ON DELETE SET NULL,
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, stage_id)
);

ALTER TABLE smrtplan_episode_stage_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_episode_stage_status_org_members" ON smrtplan_episode_stage_status;
CREATE POLICY "smrtplan_episode_stage_status_org_members" ON smrtplan_episode_stage_status
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_ess_episode_idx ON smrtplan_episode_stage_status(episode_id);
CREATE INDEX IF NOT EXISTS smrtplan_ess_stage_idx   ON smrtplan_episode_stage_status(stage_id);
CREATE INDEX IF NOT EXISTS smrtplan_ess_task_idx    ON smrtplan_episode_stage_status(task_id) WHERE task_id IS NOT NULL;

DROP TRIGGER IF EXISTS smrtplan_ess_updated_at ON smrtplan_episode_stage_status;
CREATE TRIGGER smrtplan_ess_updated_at BEFORE UPDATE ON smrtplan_episode_stage_status
  FOR EACH ROW EXECUTE FUNCTION smrtplan_update_updated_at();


-- ─── 7. SMRTPLAN_DEPENDENCIES (the path) ─────────────────────
-- Generic dependency edge: from_* depends on to_* ("from needs to").
-- from/to can be a plan, a stage, or a task. A task→task edge is the
-- "what's needed to start" link (the provider task supplies the consumer).
CREATE TABLE IF NOT EXISTS smrtplan_dependencies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_type  text NOT NULL CHECK (from_type IN ('plan','stage','task')),
  from_id    uuid NOT NULL,
  to_type    text NOT NULL CHECK (to_type IN ('plan','stage','task')),
  to_id      uuid NOT NULL,
  satisfied  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_type, from_id, to_type, to_id)
);

ALTER TABLE smrtplan_dependencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_dependencies_org_members" ON smrtplan_dependencies;
CREATE POLICY "smrtplan_dependencies_org_members" ON smrtplan_dependencies
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_dependencies_from_idx ON smrtplan_dependencies(from_type, from_id);
CREATE INDEX IF NOT EXISTS smrtplan_dependencies_to_idx   ON smrtplan_dependencies(to_type, to_id);
CREATE INDEX IF NOT EXISTS smrtplan_dependencies_org_idx  ON smrtplan_dependencies(org_id);
