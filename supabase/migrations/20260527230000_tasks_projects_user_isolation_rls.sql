-- Tighten tasks/projects RLS to strict per-user isolation for browser clients.
--
-- Previously each table had TWO permissive policies which Postgres OR's together
-- for SELECT:
--   user_isolation     USING (user_id = auth.uid())                       -- own rows
--   tasks_org_select   USING (organization_id IS NULL                     -- + every row in
--                             OR organization_id IN (my orgs))            --   any org I'm in,
--                                                                         --   AND every NULL-org row
-- Because they are PERMISSIVE, the broader org rule wins, so the anon/authenticated
-- browser client could read tasks/projects belonging to other users (any teammate
-- in a shared org, or any row whose organization_id is NULL). The client-side
-- `.eq("user_id", ...)` filter is convenience only, not a security boundary.
--
-- Product requirement: a user may only ever read their OWN tasks/projects.
-- Dropping the org-scoped SELECT policies leaves user_isolation
-- (user_id = auth.uid(), FOR ALL) as the sole policy, enforcing strict per-user
-- isolation at the DB level for every browser query.
--
-- The Express backend uses the service-role client, which bypasses RLS and keeps
-- its own explicit org-scoping, so it is unaffected. Org/team project sharing
-- (planned) will be reintroduced later via an explicit, narrowly-scoped policy
-- rather than this blanket org-wide grant.

DROP POLICY IF EXISTS "tasks_org_select" ON public.tasks;
DROP POLICY IF EXISTS "projects_org_select" ON public.projects;
