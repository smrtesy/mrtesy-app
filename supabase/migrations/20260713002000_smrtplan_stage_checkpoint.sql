-- smrtplan_stages.checkpoint — the stage's review point (planning protocol §13
-- "checkpoint"). The AI plan-builder / import proposal carries a `checkpoint`
-- per stage; until now there was no column to store it, so it was dropped on
-- import (docs/smrtplan-focus-integration.md §11 flagged this). Additive +
-- nullable, so existing stages are unaffected.

ALTER TABLE smrtplan_stages
  ADD COLUMN IF NOT EXISTS checkpoint text;

COMMENT ON COLUMN smrtplan_stages.checkpoint IS
  'The stage review point ("what proves this stage is done") — filled by the plan-builder (protocol §13).';
