-- smrtPlan review notes — the in-app "review pass" store (docs/smrtplan-simulation-plan
-- §5 "מעבר סקירה", degree 1). While reviewing a plan the user opens a task, reads its
-- full text, and writes a free-text "what to change" note. Notes are SHARED at the plan
-- level (any reviewer with full access sees them) and exportable to CSV for batch apply.
--
-- One note per (plan, task): the note is editable in place — writing again replaces it,
-- clearing it deletes the row. This mirrors the external review CSV's single free-text
-- "מה לשנות" column, one cell per task.
--
-- Additive, standalone table — no existing table or flow is affected.

CREATE TABLE IF NOT EXISTS plan_review_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note        text NOT NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_plan_review_notes_plan ON plan_review_notes (org_id, plan_id);

ALTER TABLE plan_review_notes ENABLE ROW LEVEL SECURITY;

-- Backend-only, exactly like the rest of the smrtPlan routes: the client never touches
-- this table directly — it always goes through the service-role Express backend
-- (api() → /api/plans/:id/review*), which scopes every query to the active org and
-- shares notes across the plan's reviewers. RLS is enabled with no permissive client
-- policy so any direct (anon/authed) client read is denied; the service role bypasses it.

COMMENT ON TABLE plan_review_notes IS
  'Shared per-plan review notes (one free-text "what to change" per task), written during '
  'the in-app review pass and exportable to CSV for batch apply (smrtplan-simulation-plan §5).';
