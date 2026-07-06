-- Wrap bare auth.uid()/auth.jwt()/auth.role() calls in RLS policies with
-- (SELECT ...) so Postgres evaluates them once per query (initplan) instead
-- of once per row. Addresses 130 auth_rls_initplan warnings from the
-- Supabase performance advisor. Semantics are unchanged.
--
-- Implemented as a dynamic rewrite over pg_policies so it applies the same
-- transformation to whatever policies exist at apply time, and is idempotent:
-- policies already using the (SELECT auth.uid()) form round-trip unchanged
-- and are skipped.

DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
  changed int := 0;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    new_qual := CASE WHEN p.qual IS NULL THEN NULL ELSE
      regexp_replace(
        regexp_replace(p.qual,
          'auth\.(uid|jwt|role)\(\)', '(SELECT auth.\1())', 'g'),
        -- collapse the double-wrap this produces on already-wrapped policies
        '\( SELECT \(SELECT auth\.(uid|jwt|role)\(\)\) AS (uid|jwt|role)\)',
        '( SELECT auth.\1() AS \2)', 'g')
    END;
    new_check := CASE WHEN p.with_check IS NULL THEN NULL ELSE
      regexp_replace(
        regexp_replace(p.with_check,
          'auth\.(uid|jwt|role)\(\)', '(SELECT auth.\1())', 'g'),
        '\( SELECT \(SELECT auth\.(uid|jwt|role)\(\)\) AS (uid|jwt|role)\)',
        '( SELECT auth.\1() AS \2)', 'g')
    END;

    IF new_qual IS DISTINCT FROM p.qual OR new_check IS DISTINCT FROM p.with_check THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I%s%s',
        p.policyname, p.schemaname, p.tablename,
        CASE WHEN new_qual IS NOT NULL THEN ' USING (' || new_qual || ')' ELSE '' END,
        CASE WHEN new_check IS NOT NULL THEN ' WITH CHECK (' || new_check || ')' ELSE '' END);
      changed := changed + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'rls_initplan_wrap: rewrote % policies', changed;
END $$;

-- Drop exact-duplicate indexes flagged by the advisor
-- (organizations_slug_key is the UNIQUE-constraint-backed one; keep it)
DROP INDEX IF EXISTS public.idx_organizations_slug;
-- idx_tasks_project and idx_tasks_project_id are identical partial indexes
DROP INDEX IF EXISTS public.idx_tasks_project;
