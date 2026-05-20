-- Bump default daily AI budget from $1 to $10.
-- Also lift any user still on the old $1 default to $10. Users who chose a
-- custom value (different from 1.00) keep their setting.

ALTER TABLE user_settings
  ALTER COLUMN daily_ai_budget_usd SET DEFAULT 10.00;

UPDATE user_settings
   SET daily_ai_budget_usd = 10.00
 WHERE daily_ai_budget_usd = 1.00;
