-- ============================================================
-- smrtBot — publish diff summary
-- ============================================================
-- A human-readable diff of what each publish changed (per content type:
-- added / removed / updated counts), so the publish history says WHAT changed
-- instead of just version + date. Computed at publish time (routes/publish.ts).

ALTER TABLE smrtbot_publish_batches
  ADD COLUMN IF NOT EXISTS summary_json jsonb NOT NULL DEFAULT '{}'::jsonb;
