-- Fix app_slug data: rows were inserted with default 'smrttask' but the DB slug is 'smrtesy'
UPDATE rules_memory   SET app_slug = 'smrtesy' WHERE app_slug = 'smrttask';
UPDATE sync_schedules SET app_slug = 'smrtesy' WHERE app_slug = 'smrttask';
UPDATE run_sessions   SET app_slug = 'smrtesy' WHERE app_slug = 'smrttask';

-- Update smrtTask app description to Hebrew
UPDATE apps
SET description = 'מנהל משימות חכם שסורק אוטומטית את המייל, הקלנדר וה-WhatsApp שלך ויוצר משימות עם עדיפויות'
WHERE slug = 'smrtesy';

-- Add guide_url column so each app can expose a user-facing guide page
ALTER TABLE apps ADD COLUMN IF NOT EXISTS guide_url text;
UPDATE apps SET guide_url = '/tasks/guide' WHERE slug = 'smrtesy';
