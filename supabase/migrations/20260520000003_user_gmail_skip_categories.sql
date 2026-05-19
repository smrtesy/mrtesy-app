-- Lets each user opt-out of treating specific Gmail categories as
-- informational. Default: all four "non-Primary" categories are skipped,
-- matching the behavior introduced in ai-process v16.
--
-- Empty array = no Gmail category filtering — every message reaches the
-- Haiku classifier even if Gmail tagged it Promotions/Social/Updates/Forums.
-- That's the right toggle for a sales team where promotions ARE actionable.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS gmail_skip_categories text[] DEFAULT
    ARRAY['CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES','CATEGORY_FORUMS']::text[];

COMMENT ON COLUMN user_settings.gmail_skip_categories IS
  'Gmail label IDs treated as informational by ai-process preClassify. NULL or empty disables the filter. Default: all four CATEGORY_* tabs.';
