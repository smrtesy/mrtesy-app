-- Rename the app display name from "smrtesy AI Brain" to "smrtTask".
-- The slug ("smrtesy") stays unchanged — it is referenced in code via requireApp("smrtesy").
UPDATE apps
SET
  name        = 'smrtTask',
  description = 'AI-powered task collection and suggestions from Gmail, Drive, Calendar and WhatsApp'
WHERE slug = 'smrtesy';
