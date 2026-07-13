-- Day-tools framework: a single JSONB column on user_settings that holds
-- every "כלי היום" (day-tool) toggle + its per-tool config, keyed by tool slug.
--
-- Shape:
--   {
--     "method131": { "enabled": true, "medium_quota": 3, "big_quota": 1 },
--     "marathon":  { "enabled": true },
--     "planfocus": { "enabled": false }
--   }
--
-- Why JSONB and not a boolean column per tool: several tools are planned, each
-- with its own small config; one object keeps the whole "day method" together
-- and avoids a migration per new tool. The PATCH /me/settings route shallow-
-- merges at the tool-key level so updating one tool never clobbers the others.
--
-- Default '{}' means "no explicit choice yet" — the client registry supplies
-- each tool's default (see src/lib/smrttask/day-tools.ts), so existing users
-- keep today's behaviour with zero rows written.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS day_tools jsonb NOT NULL DEFAULT '{}'::jsonb;
