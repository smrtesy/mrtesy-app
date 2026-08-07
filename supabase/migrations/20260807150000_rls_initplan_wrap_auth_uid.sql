-- Performance: fix 14 auth_rls_initplan advisor findings.
--
-- 14 RLS policies across 9 tables call auth.uid() directly in USING/WITH CHECK,
-- so Postgres re-evaluates it once PER ROW. Wrapping it as (select auth.uid())
-- turns it into an InitPlan evaluated ONCE per query. The returned value is
-- identical, so this changes performance only — same rows allowed/denied, same
-- security boundary, no table data touched. Supabase's recommended fix:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- ALTER POLICY (not DROP+CREATE) so cmd + TO <role> are preserved and there is
-- no window where the policy is absent. Expressions below are the exact current
-- definitions from pg_policies with every auth.uid() wrapped.

-- smrtdesign_* : org-members policies (ALL — USING + WITH CHECK identical)
ALTER POLICY smrtdesign_projects_org_members ON public.smrtdesign_projects
  USING (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())))
  WITH CHECK (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())));

ALTER POLICY smrtdesign_options_org_members ON public.smrtdesign_options
  USING (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())))
  WITH CHECK (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())));

ALTER POLICY smrtdesign_selections_org_members ON public.smrtdesign_selections
  USING (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())))
  WITH CHECK (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())));

-- drive_catalog : owner SELECT
ALTER POLICY drive_catalog_owner_select ON public.drive_catalog
  USING ((select auth.uid()) = user_id);

ALTER POLICY drive_catalog_scans_owner_select ON public.drive_catalog_scans
  USING ((select auth.uid()) = user_id);

-- org_restrictions
ALTER POLICY org_restrictions_select_members ON public.org_restrictions
  USING (org_id IN (SELECT org_members.org_id FROM org_members WHERE org_members.user_id = (select auth.uid())));

ALTER POLICY org_restrictions_super_admins ON public.org_restrictions
  USING ((select auth.uid()) IN (SELECT super_admins.user_id FROM super_admins));

-- user_resource_grants
ALTER POLICY user_resource_grants_select_self ON public.user_resource_grants
  USING (user_id = (select auth.uid()));

ALTER POLICY user_resource_grants_select_admins ON public.user_resource_grants
  USING (org_id IN (SELECT org_members.org_id FROM org_members
                    WHERE org_members.user_id = (select auth.uid())
                      AND org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])));

ALTER POLICY user_resource_grants_super_admins ON public.user_resource_grants
  USING ((select auth.uid()) IN (SELECT super_admins.user_id FROM super_admins));

-- permission_audit_log
ALTER POLICY permission_audit_log_select_admins ON public.permission_audit_log
  USING (org_id IN (SELECT org_members.org_id FROM org_members
                    WHERE org_members.user_id = (select auth.uid())
                      AND org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])));

ALTER POLICY permission_audit_log_super_admins ON public.permission_audit_log
  USING ((select auth.uid()) IN (SELECT super_admins.user_id FROM super_admins));

-- classifier_golden_set : owner (ALL — USING + WITH CHECK)
ALTER POLICY classifier_golden_set_owner ON public.classifier_golden_set
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- search_documents : public-or-owner read
ALTER POLICY search_documents_read ON public.search_documents
  USING (((org_id IS NULL) AND (user_id IS NULL)) OR (user_id = (select auth.uid())));
