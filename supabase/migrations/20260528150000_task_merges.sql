-- Task merge audit log.
--
-- Records each "merge" operation: N source tasks/suggestions are unified into
-- one target task. Sources are NOT linked back via FK on the tasks table
-- (per product decision — sources go to status='archived' with no pointer).
-- This table is the only place where the relationship survives, so it
-- doubles as both audit trail and the source-of-truth for "undo merge".
--
-- merge_kind values:
--   suggestion_into_existing  — 1+ inbox/unverified rows merged into an
--                                existing live task (target_task_id existed
--                                before the merge).
--   suggestions_into_new      — 2+ inbox/unverified rows merged into a brand
--                                new task (target row was INSERTed as part
--                                of the merge).
--   tasks_into_new            — 2+ existing live tasks merged into a brand
--                                new task (sources were active before).
--   ai_proposed               — merge that originated from an AI proposal
--                                (the user accepted a system-suggested
--                                grouping).
--
-- source_titles_snapshot shape:
--   [{ id, title, title_he, status, checklist, source_link }, ...]
-- Snapshot is kept so that "undo" can restore the original status (sources
-- might have been 'inbox' or 'in_progress' before the merge, not just one
-- of them).

CREATE TABLE IF NOT EXISTS task_merges (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_was_new         boolean NOT NULL,
  source_task_ids        uuid[] NOT NULL CHECK (array_length(source_task_ids, 1) >= 1),
  source_titles_snapshot jsonb NOT NULL,
  merge_kind             text NOT NULL CHECK (merge_kind IN (
                            'suggestion_into_existing',
                            'suggestions_into_new',
                            'tasks_into_new',
                            'ai_proposed'
                         )),
  ai_proposal            jsonb,         -- raw proposal returned by Sonnet (if any)
  merged_by              uuid NOT NULL REFERENCES auth.users(id),
  merged_at              timestamptz NOT NULL DEFAULT now(),
  undone_at              timestamptz
);

CREATE INDEX IF NOT EXISTS idx_task_merges_org_time
  ON task_merges(organization_id, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_merges_target
  ON task_merges(target_task_id);

ALTER TABLE task_merges ENABLE ROW LEVEL SECURITY;

-- Same org-scoping as tasks. Service role bypasses RLS as usual.
DROP POLICY IF EXISTS task_merges_org_select ON task_merges;
CREATE POLICY task_merges_org_select ON task_merges
  FOR SELECT USING (
    organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS task_merges_org_insert ON task_merges;
CREATE POLICY task_merges_org_insert ON task_merges
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS task_merges_org_update ON task_merges;
CREATE POLICY task_merges_org_update ON task_merges
  FOR UPDATE USING (
    organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

COMMENT ON TABLE task_merges IS
  'Audit log + undo source-of-truth for task merge operations. See migration header for shape.';
