-- merge_tasks(...) — atomic RPC that performs a task merge.
--
-- Input:
--   p_org_id            uuid               — caller's active org (checked against every row)
--   p_user_id           uuid               — auth.users.id of the operator (saved as merged_by)
--   p_source_ids        uuid[]             — sources to archive
--   p_target_id         uuid               — existing target task, or NULL when creating new
--   p_target_payload    jsonb              — when p_target_id IS NULL: row to INSERT into tasks.
--                                            When p_target_id IS NOT NULL: partial UPDATE applied to
--                                            the existing target (any subset of UPDATABLE_FIELDS).
--   p_sources_completed uuid[]             — subset of p_source_ids the user marked "already done".
--                                            These get status='completed' instead of 'archived'
--                                            (the AI's "already_done" warning was accepted).
--   p_merge_kind        text               — one of the CHECK values in task_merges
--   p_ai_proposal       jsonb              — raw AI proposal (or NULL)
--
-- Returns: jsonb with { merge_id, target_id, archived_count }.
--
-- Guarantees:
--   • All sources must belong to p_org_id, else exception.
--   • No source may already be archived/completed/dismissed (race protection) — else exception
--     with errcode '40001' so the API layer can return 409 Conflict.
--   • Either inserts the target or updates an existing one in the same org.
--   • Archives all sources except those listed in p_sources_completed (those go to 'completed').
--   • Inserts the audit row.
--   • Sources that happen to also be the target are SKIPPED for archive (merging into self).

CREATE OR REPLACE FUNCTION merge_tasks(
  p_org_id            uuid,
  p_user_id           uuid,
  p_source_ids        uuid[],
  p_target_id         uuid,
  p_target_payload    jsonb,
  p_sources_completed uuid[],
  p_merge_kind        text,
  p_ai_proposal       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_id       uuid;
  v_target_was_new  boolean;
  v_snapshot        jsonb;
  v_archived_count  int;
  v_completed_count int;
  v_merge_id        uuid;
  v_bad_count       int;
BEGIN
  -- Validate sources exist in this org and lock them for update.
  -- LOCK = FOR UPDATE prevents two simultaneous merges from racing.
  PERFORM 1
  FROM tasks
  WHERE id = ANY(p_source_ids)
    AND organization_id = p_org_id
  FOR UPDATE;

  -- Count how many of the source IDs actually belong to this org.
  SELECT count(*) INTO v_bad_count
  FROM unnest(p_source_ids) sid
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks WHERE id = sid AND organization_id = p_org_id
  );
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'one or more source tasks do not belong to this org'
      USING ERRCODE = '42501';   -- insufficient_privilege
  END IF;

  -- Race guard: no source may already be in a terminal state.
  SELECT count(*) INTO v_bad_count
  FROM tasks
  WHERE id = ANY(p_source_ids)
    AND status IN ('archived', 'completed', 'dismissed');
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'one or more source tasks were already finalized (race condition)'
      USING ERRCODE = '40001';   -- serialization_failure → API returns 409
  END IF;

  -- Build snapshot BEFORE any mutation, so undo can restore exact prior state.
  SELECT jsonb_agg(jsonb_build_object(
    'id',           id,
    'title',        title,
    'title_he',     title_he,
    'status',       status,
    'task_type',    task_type,
    'checklist',    checklist,
    'source_link',  source_link,
    'manually_verified', manually_verified
  ))
  INTO v_snapshot
  FROM tasks
  WHERE id = ANY(p_source_ids)
    AND organization_id = p_org_id;

  -- Resolve target: insert new or validate existing.
  IF p_target_id IS NULL THEN
    -- Insert new target. p_target_payload is the full row body.
    -- Required fields are stamped here; the rest comes from the payload.
    INSERT INTO tasks (
      user_id, organization_id, task_type, status, priority,
      manually_verified, title, title_he, description, due_date, due_time,
      checklist, tags, source_link, ai_generated_content, related_contact,
      related_contact_email, related_contact_phone, project_id
    )
    VALUES (
      p_user_id,
      p_org_id,
      COALESCE(p_target_payload->>'task_type', 'action'),
      COALESCE(p_target_payload->>'status', 'inbox'),
      COALESCE(p_target_payload->>'priority', 'medium'),
      true,  -- merged tasks are by definition user-curated
      p_target_payload->>'title',
      p_target_payload->>'title_he',
      p_target_payload->>'description',
      NULLIF(p_target_payload->>'due_date', '')::date,
      NULLIF(p_target_payload->>'due_time', '')::time,
      COALESCE(p_target_payload->'checklist', '[]'::jsonb),
      CASE
        WHEN p_target_payload->'tags' IS NOT NULL
          THEN ARRAY(SELECT jsonb_array_elements_text(p_target_payload->'tags'))
        ELSE NULL
      END,
      p_target_payload->>'source_link',
      p_target_payload->'ai_generated_content',
      p_target_payload->>'related_contact',
      p_target_payload->>'related_contact_email',
      p_target_payload->>'related_contact_phone',
      NULLIF(p_target_payload->>'project_id', '')::uuid
    )
    RETURNING id INTO v_target_id;
    v_target_was_new := true;
  ELSE
    -- Validate existing target is in this org.
    PERFORM 1 FROM tasks
     WHERE id = p_target_id AND organization_id = p_org_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target task not found in this org'
        USING ERRCODE = '42501';
    END IF;
    v_target_id := p_target_id;
    v_target_was_new := false;

    -- Apply partial update for any fields the caller provided.
    UPDATE tasks SET
      title        = COALESCE(p_target_payload->>'title', title),
      title_he     = COALESCE(p_target_payload->>'title_he', title_he),
      description  = COALESCE(p_target_payload->>'description', description),
      due_date     = COALESCE(NULLIF(p_target_payload->>'due_date', '')::date, due_date),
      due_time     = COALESCE(NULLIF(p_target_payload->>'due_time', '')::time, due_time),
      priority     = COALESCE(p_target_payload->>'priority', priority),
      checklist    = COALESCE(p_target_payload->'checklist', checklist),
      source_link  = COALESCE(p_target_payload->>'source_link', source_link),
      tags         = COALESCE(
                        CASE
                          WHEN p_target_payload->'tags' IS NOT NULL
                            THEN ARRAY(SELECT jsonb_array_elements_text(p_target_payload->'tags'))
                          ELSE NULL
                        END,
                        tags
                      ),
      manually_verified = true,
      updated_at   = now()
    WHERE id = v_target_id AND organization_id = p_org_id;
  END IF;

  -- Archive sources (except the target itself if it appears in the list,
  -- and except any that the user explicitly marked "already done").
  -- NOTE: we deliberately do NOT stamp completed_at here. A merged source
  -- isn't "completed" — its work was rolled into the target. Stamping it
  -- would mis-classify it in completion-based filters and would persist
  -- through an undo. completed_at is reserved for the explicit-completion
  -- branch below (sources flagged by the AI's "already_done" warning that
  -- the user accepted).
  WITH updated AS (
    UPDATE tasks
       SET status = 'archived',
           status_changed_at = now(),
           updated_at = now()
     WHERE id = ANY(p_source_ids)
       AND id <> v_target_id
       AND id <> ALL(COALESCE(p_sources_completed, ARRAY[]::uuid[]))
       AND organization_id = p_org_id
    RETURNING 1
  )
  SELECT count(*) INTO v_archived_count FROM updated;

  -- Sources flagged "already completed" by the user: status='completed'.
  IF p_sources_completed IS NOT NULL AND array_length(p_sources_completed, 1) > 0 THEN
    WITH updated AS (
      UPDATE tasks
         SET status = 'completed',
             completed_at = now(),
             status_changed_at = now(),
             updated_at = now()
       WHERE id = ANY(p_sources_completed)
         AND id <> v_target_id
         AND organization_id = p_org_id
      RETURNING 1
    )
    SELECT count(*) INTO v_completed_count FROM updated;
  ELSE
    v_completed_count := 0;
  END IF;

  -- Audit row.
  INSERT INTO task_merges (
    organization_id, target_task_id, target_was_new,
    source_task_ids, source_titles_snapshot,
    merge_kind, ai_proposal, merged_by
  ) VALUES (
    p_org_id, v_target_id, v_target_was_new,
    p_source_ids, v_snapshot,
    p_merge_kind, p_ai_proposal, p_user_id
  )
  RETURNING id INTO v_merge_id;

  RETURN jsonb_build_object(
    'merge_id',         v_merge_id,
    'target_id',        v_target_id,
    'target_was_new',   v_target_was_new,
    'archived_count',   v_archived_count,
    'completed_count',  v_completed_count
  );
END;
$$;

-- Only the service-role user (used by the Node API layer) should call this.
-- The API layer already verifies auth + org via middleware before invoking.
REVOKE ALL ON FUNCTION merge_tasks(uuid, uuid, uuid[], uuid, jsonb, uuid[], text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_tasks(uuid, uuid, uuid[], uuid, jsonb, uuid[], text, jsonb) TO service_role;


-- undo_task_merge(...) — reverses a merge.
--
-- For target_was_new=true: deletes the target row.
-- For target_was_new=false: leaves the target in place (we don't snapshot
--   pre-update target state, so we can't restore field values; reviving the
--   sources alone is the best we can do).
-- In both cases: restores each source's status from the snapshot, clears
-- completed_at if the source was not previously in a terminal state, and
-- stamps task_merges.undone_at.

CREATE OR REPLACE FUNCTION undo_task_merge(
  p_org_id   uuid,
  p_user_id  uuid,
  p_merge_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_merge          task_merges%ROWTYPE;
  v_snap_item      jsonb;
  v_restored_count int := 0;
BEGIN
  SELECT * INTO v_merge
  FROM task_merges
  WHERE id = p_merge_id AND organization_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge not found in this org'
      USING ERRCODE = '42501';
  END IF;
  IF v_merge.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'merge already undone'
      USING ERRCODE = '40001';
  END IF;

  -- Restore each source from snapshot.
  FOR v_snap_item IN SELECT jsonb_array_elements(v_merge.source_titles_snapshot)
  LOOP
    UPDATE tasks
       SET status            = v_snap_item->>'status',
           completed_at      = CASE
                                 WHEN v_snap_item->>'status' IN ('archived','completed','dismissed')
                                   THEN completed_at
                                 ELSE NULL
                               END,
           status_changed_at = now(),
           updated_at        = now()
     WHERE id = (v_snap_item->>'id')::uuid
       AND organization_id = p_org_id;
    IF FOUND THEN v_restored_count := v_restored_count + 1; END IF;
  END LOOP;

  -- Delete the target if it was created by the merge.
  IF v_merge.target_was_new THEN
    DELETE FROM tasks
     WHERE id = v_merge.target_task_id AND organization_id = p_org_id;
  END IF;

  UPDATE task_merges SET undone_at = now()
   WHERE id = p_merge_id;

  RETURN jsonb_build_object(
    'merge_id',        p_merge_id,
    'restored_count',  v_restored_count,
    'target_deleted',  v_merge.target_was_new
  );
END;
$$;

REVOKE ALL ON FUNCTION undo_task_merge(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION undo_task_merge(uuid, uuid, uuid) TO service_role;
