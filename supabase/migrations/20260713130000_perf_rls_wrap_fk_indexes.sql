-- Performance migration (advisor-driven), two zero-behavior-change parts:
--
-- 1. Wrap auth.uid() in (select auth.uid()) in the 12 RLS policies the
--    Supabase performance advisor flags as auth_rls_initplan — the bare call
--    is re-evaluated per row; the wrapped form runs once per query.
-- 2. Add the missing indexes that matter for user-facing latency:
--    the tasks list sort index and the advisor's unindexed foreign keys on
--    hot tables (auth path, task lists, message threads, notification feed).
--
-- Policy names/expressions were read from pg_policies on production before
-- writing this file; ALTER POLICY only swaps the expression.

-- ── 1. RLS initplan wraps ───────────────────────────────────────────────────

alter policy daily_plans_own_insert on daily_plans
  with check (user_id = (select auth.uid()));
alter policy daily_plans_own_select on daily_plans
  using (user_id = (select auth.uid()));
alter policy daily_plans_own_update on daily_plans
  using (user_id = (select auth.uid()));

alter policy focus_sessions_own_insert on focus_sessions
  with check (user_id = (select auth.uid()));
alter policy focus_sessions_own_select on focus_sessions
  using (user_id = (select auth.uid()));
alter policy focus_sessions_own_update on focus_sessions
  using (user_id = (select auth.uid()));

alter policy smrtplan_focus_own_delete on smrtplan_focus
  using (user_id = (select auth.uid()));
alter policy smrtplan_focus_own_insert on smrtplan_focus
  with check (user_id = (select auth.uid()));
alter policy smrtplan_focus_own_select on smrtplan_focus
  using (user_id = (select auth.uid()));
alter policy smrtplan_focus_own_update on smrtplan_focus
  using (user_id = (select auth.uid()));

alter policy sms_webhook_debug_owner on sms_webhook_debug
  using (user_id = (select auth.uid()));

alter policy smrtvoice_pronunciation_feedback_org_members on smrtvoice_pronunciation_feedback
  using (org_id in (
    select org_members.org_id from org_members
    where org_members.user_id = (select auth.uid())
  ))
  with check (org_id in (
    select org_members.org_id from org_members
    where org_members.user_id = (select auth.uid())
  ));

-- ── 2. Missing indexes ──────────────────────────────────────────────────────

-- Main tasks list: filters organization_id, orders by created_at desc.
-- Existing indexes cover (org), (org,status), (org,task_type) but none avoid
-- the sort.
create index if not exists idx_tasks_org_created
  on tasks (organization_id, created_at desc);

-- Auth/entitlement path — consulted on every authorized request.
create index if not exists idx_app_memberships_app_id on app_memberships (app_id);
create index if not exists idx_app_memberships_enabled_by on app_memberships (enabled_by);
create index if not exists idx_user_app_access_app_id on user_app_access (app_id);
create index if not exists idx_user_app_access_granted_by on user_app_access (granted_by);

-- Task lists join these.
create index if not exists idx_tasks_proposed_by on tasks (proposed_by);
create index if not exists idx_tasks_role_id on tasks (role_id);

-- Message threads / notification feed / conversations.
create index if not exists idx_messages_sender_id on messages (sender_id);
create index if not exists idx_notifications_from_user_id on notifications (from_user_id);
create index if not exists idx_conversations_created_by on conversations (created_by);

-- Ingest pipeline lookups.
create index if not exists idx_router_decisions_org on router_decisions (organization_id);
create index if not exists idx_router_decisions_source_message on router_decisions (source_message_id);
create index if not exists idx_router_decisions_applied_task on router_decisions (applied_task_id);
create index if not exists idx_router_decisions_target_task on router_decisions (target_task_id);

-- Knowledge base joins.
create index if not exists idx_knowledge_base_task_id on knowledge_base (task_id);
create index if not exists idx_knowledge_base_created_by on knowledge_base (created_by);
create index if not exists idx_knowledge_base_approved_by on knowledge_base (approved_by);

-- Remaining advisor FKs on tables in the report's top list.
create index if not exists idx_daily_plans_org_id on daily_plans (org_id);
create index if not exists idx_organizations_error_handler
  on organizations (error_handler_user_id);
