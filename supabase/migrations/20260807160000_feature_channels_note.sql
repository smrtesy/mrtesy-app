-- Feature Channels — the manual note (docs/feature-channels-plan.md).
--
-- Design refinement (Chanoch, 2026-08-07): the per-feature card is managed
-- ENTIRELY by version. The old `intent` (fork/migrate), `promote_by` date and
-- `notes_url` link were dropped from the UI — "intent" was inferred from
-- whether a feature stays split, and the change explanation is now written by
-- Claude in the registry (structure), not pasted as a link.
--
-- What the STATE table still needs from the user is a free-text NOTE — a human
-- remark Claude never touches. Everything else the screen edits already exists
-- (stable/beta_enabled + stable/beta_version). The version LIST (options +
-- history) lives in the code registry, so no column for it here.
--
-- Additive only (ADD COLUMN) — applied via the Supabase Management API per repo
-- policy, never `supabase db push`. The now-unused intent/promote_by/notes_url
-- columns are left in place (the table is empty, so nothing breaks and no data
-- is lost); they can be dropped later via an approved destructive migration.

ALTER TABLE public.feature_channels
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.feature_channels.note IS
  'Free-text human note for this feature (feature-channels). Written by the admin from /admin/features; Claude never edits it. The change explanation ("what changed per version") lives in the code registry, not here.';
