-- Defensive: ensure apps.slug is 'smrtesy' (what the entire codebase expects
-- via requireApp("smrtesy"), Sidebar.enabledApps.includes("smrtesy"), and the
-- (app)/layout.tsx app_memberships→apps(slug) join). The seed in
-- 20260510000001_platform_foundation.sql already created it as 'smrtesy', but
-- something flipped it to 'smrttask' at some point, breaking app detection
-- (sidebar lost the smrtTask section, inbox hid the Suggestions tab even
-- though the count badge showed 90 unverified suggestions).
--
-- This UPDATE is a no-op if the slug is already 'smrtesy'.
UPDATE apps SET slug = 'smrtesy' WHERE slug = 'smrttask';
