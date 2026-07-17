-- Performance migration (advisor-driven), zero-behavior-change.
--
-- The Supabase performance advisor flags 10 RLS policies across the four
-- workclock/debrief tables added on 2026-07-14 (task_debriefs, work_sessions,
-- work_task_spans, claude_actions) as auth_rls_initplan: they call bare
-- auth.uid() in the policy expression, which Postgres re-evaluates once PER ROW.
-- Wrapping it in (select auth.uid()) makes it an InitPlan that runs ONCE per
-- query. Same result set, no security change — only the row-scan cost drops.
--
-- This is the same fix applied to 12 earlier policies in
-- 20260713130000_perf_rls_wrap_fk_indexes.sql; those four tables just postdate
-- that migration. ALTER POLICY only swaps the expression (USING for
-- SELECT/UPDATE, WITH CHECK for INSERT) — the policy names, commands and roles
-- are untouched.

-- task_debriefs (20260714100000)
alter policy task_debriefs_own_select on task_debriefs
  using (user_id = (select auth.uid()));
alter policy task_debriefs_own_insert on task_debriefs
  with check (user_id = (select auth.uid()));

-- work_sessions (20260714190000)
alter policy work_sessions_own_select on work_sessions
  using (user_id = (select auth.uid()));
alter policy work_sessions_own_insert on work_sessions
  with check (user_id = (select auth.uid()));
alter policy work_sessions_own_update on work_sessions
  using (user_id = (select auth.uid()));

-- work_task_spans (20260714210000)
alter policy work_task_spans_own_select on work_task_spans
  using (user_id = (select auth.uid()));
alter policy work_task_spans_own_insert on work_task_spans
  with check (user_id = (select auth.uid()));

-- claude_actions (20260714220000)
alter policy claude_actions_own_select on claude_actions
  using (user_id = (select auth.uid()));
alter policy claude_actions_own_insert on claude_actions
  with check (user_id = (select auth.uid()));
alter policy claude_actions_own_update on claude_actions
  using (user_id = (select auth.uid()));
