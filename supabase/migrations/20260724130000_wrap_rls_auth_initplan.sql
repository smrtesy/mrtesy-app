-- Wrap auth.*() calls in RLS policies (auth_rls_initplan perf advisory)
--
-- Postgres re-evaluates a bare auth.uid()/auth.role()/auth.jwt() ONCE PER ROW
-- inside an RLS policy. Wrapping as (select auth.uid()) makes the planner
-- evaluate it a single time per statement (InitPlan) and reuse the value.
-- The value is identical for the whole statement -> pure performance change,
-- zero behavior change.
--
-- Generated mechanically from the live pg_policies definitions on 2026-07-24:
-- each policy's exact USING/WITH CHECK expression is preserved verbatim and
-- only the auth.*() token is wrapped. Applied via ALTER POLICY so roles, cmd
-- and permissive/restrictive are untouched. Single transaction: if any one
-- statement fails to parse the whole migration rolls back.
--
-- Dry-run verified on prod (executed inside a rolled-back DO block).

BEGIN;

ALTER POLICY "daily_report_entries_own_delete" ON "public"."daily_report_entries"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_entries_own_insert" ON "public"."daily_report_entries"
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_entries_own_select" ON "public"."daily_report_entries"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_entries_own_update" ON "public"."daily_report_entries"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_items_own_delete" ON "public"."daily_report_items"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_items_own_insert" ON "public"."daily_report_items"
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_items_own_select" ON "public"."daily_report_items"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_items_own_update" ON "public"."daily_report_items"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_options_own_delete" ON "public"."daily_report_options"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_options_own_insert" ON "public"."daily_report_options"
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_options_own_select" ON "public"."daily_report_options"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_options_own_update" ON "public"."daily_report_options"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_runs_own_delete" ON "public"."daily_report_runs"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_runs_own_insert" ON "public"."daily_report_runs"
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_runs_own_select" ON "public"."daily_report_runs"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "daily_report_runs_own_update" ON "public"."daily_report_runs"
  USING ((user_id = (select auth.uid())));

COMMIT;
