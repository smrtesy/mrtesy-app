-- ============================================================
-- smrtBot — record when a manual study session was reported
-- ============================================================
-- Manual reports ("למדתי מ-X עד Y") store the studied window in started_at/
-- ended_at; reported_at captures WHEN the user sent the report (for audit).
ALTER TABLE smrtbot_study_sessions ADD COLUMN IF NOT EXISTS reported_at timestamptz;
