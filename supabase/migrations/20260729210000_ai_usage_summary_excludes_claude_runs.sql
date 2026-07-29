-- Migration: document, at the database, that public.claude_runs is DELIBERATELY
-- excluded from ai_usage_summary() — and must stay excluded.
--
-- COMMENT-only. No behaviour changes, no signature change, re-runnable.
--
-- WHY THIS FILE EXISTS
-- ai_usage_summary() is the single source for every cost total the platform shows
-- (/admin/usage, the /admin overview card, the price-tracker). It unions exactly
-- two sources: public.ai_usage (token providers) and public.experiment_runs (fal).
-- public.claude_runs — the Claude Code console's own runs — is absent, and that is
-- correct: those runs execute on the Claude *subscription* and are NOT billed per
-- token. claude_runs.total_cost_usd is the engine's equivalent-API estimate, a
-- consumption measure, explicitly not an amount owed (see the column COMMENT added
-- in 20260726220000_claude_runs_model_and_usage.sql).
--
-- THE FAILURE THIS PREVENTS
-- On 2026-07-27, migration 20260727165158 folded fal into this function, reasoning:
-- "A total that silently omits a whole provider is the same class of defect as the
-- truncation bug: the number looks complete and isn't." That reasoning is right for
-- fal (real invoiced spend that was missing) and WRONG for claude_runs. Applying it
-- by analogy would add non-existent charges to a ledger whose whole purpose is to
-- reconcile against real provider invoices (as of 2026-07-29: $148.13 invoiced
-- across 19,887 ai_usage calls, against $5.90 of equivalent-value estimate across
-- 17 claude_runs) — a total that no longer matches any invoice is worse than one
-- that is scoped and says so.
--
-- So the invariant is: a source enters ai_usage_summary() only if it represents
-- money actually invoiced by a provider. Subscription consumption is a separate
-- account and is reported on its own surface (GET /api/claude/usage → the Claude
-- runs screen), never mixed into this total.
--
-- Enforcement is documentation, deliberately: there is no code path to guard here
-- (the omission IS the current behaviour). What was missing was the reason, so the
-- next session reads it before "completing the ledger".

COMMENT ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text) IS
  'All paid AI spend for a time window, grouped: token providers from ai_usage '
  'plus fal.ai generation read from experiment_runs. Aggregates server-side so '
  'the admin dashboard can never silently sum a PostgREST-truncated 1000-row '
  'sample. p_until is exclusive; NULL means "up to now". p_user_id / '
  'p_component_prefix are optional filters. missing_cost counts rows with no '
  'cost recorded, so a partial total is never presented as a complete one. fal '
  'model names are withheld (''—'') to preserve blind scoring. '
  'SCOPE — INVOICED SPEND ONLY: a source belongs here only if a provider actually '
  'bills it. public.claude_runs is therefore DELIBERATELY EXCLUDED: Claude Code '
  'console runs execute on the Claude subscription and are not billed per token, '
  'so their total_cost_usd is an equivalent-API estimate, not an amount owed. Do '
  'NOT union claude_runs into this function to "complete the ledger" — it would '
  'add charges that appear on no invoice and break reconciliation. Subscription '
  'consumption has its own surface: GET /api/claude/usage.';
