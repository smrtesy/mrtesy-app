-- user_settings.timezone had DEFAULT 'America/New_York', so every new row was
-- born with a non-null US timezone and the app could never tell "user chose
-- this" from "stale default" — blocking browser-timezone capture during
-- onboarding. Drop the default: new rows start NULL, onboarding captures the
-- real browser timezone, and code paths fall back to Asia/Jerusalem when NULL.
-- Existing rows are not modified.
ALTER TABLE public.user_settings ALTER COLUMN timezone DROP DEFAULT;
