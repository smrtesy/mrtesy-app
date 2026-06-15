-- smrtCRM: merge groups into tags, then drop the group tables.
--
-- Product decision (June 2026): the manage panel had three near-identical
-- membership concepts (tags / groups / segments). Tags and groups were both
-- just static contact membership, so groups are folded into tags and the
-- group tables are removed. Segments (saved dynamic queries) stay.
--
-- This migration is written to be safe for any org with existing data:
--   1. For every group, ensure a manual tag with the same name exists.
--   2. Re-point every group membership to that tag.
--   3. Drop the group tables.
-- On the production project at write time all four group/membership counts
-- were 0, so steps 1–2 are effectively no-ops there; they exist so no data is
-- lost on any other org.

-- 1. Group → tag (reuse an existing same-named tag if present).
INSERT INTO smrtcrm_tags (org_id, created_by, name, kind, created_at)
SELECT g.org_id, g.created_by, g.name, 'manual', g.created_at
FROM smrtcrm_groups g
ON CONFLICT (org_id, name) DO NOTHING;

-- 2. Group membership → tag assignment (match the tag by org_id + name).
INSERT INTO smrtcrm_tag_assignments (contact_id, tag_id, org_id, created_at)
SELECT gm.contact_id, t.id, gm.org_id, gm.created_at
FROM smrtcrm_group_members gm
JOIN smrtcrm_groups g ON g.id = gm.group_id
JOIN smrtcrm_tags   t ON t.org_id = g.org_id AND t.name = g.name
ON CONFLICT (contact_id, tag_id) DO NOTHING;

-- 3. Drop the group tables (members first — FK to groups).
DROP TABLE IF EXISTS smrtcrm_group_members;
DROP TABLE IF EXISTS smrtcrm_groups;
