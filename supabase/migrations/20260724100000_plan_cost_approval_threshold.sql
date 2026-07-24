-- Plan-level cost-approval threshold (project-planning-protocol §16.6).
--
-- Every plan gets a money ceiling: below it the performer just answers "yes" in
-- session; above it an approval task opens for the manager. Storing it on the
-- plan makes the rule travel with the plan instead of living in a doc only, so
-- a plan that spends money (ads, trials, salaries) carries its own limit.
--
-- NULL = no threshold configured (nothing changes; approval stays a human call).
alter table smrtplan_plans
  add column if not exists cost_approval_threshold_usd numeric;

comment on column smrtplan_plans.cost_approval_threshold_usd is
  'Plan-level cost-approval ceiling in USD (§16.6). Spend below it needs no separate approval; at or above it, an approval task opens for the plan manager. NULL = not configured.';
