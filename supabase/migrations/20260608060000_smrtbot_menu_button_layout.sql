-- ============================================================
-- smrtBot — menu node button layout
-- ============================================================
-- How a menu node renders when it has MORE than 3 buttons (WhatsApp's
-- interactive-button cap):
--   'auto'  → render as a single WhatsApp list (default)
--   'split' → split into several messages, each with up to 3 buttons
-- ≤3 buttons always render as buttons regardless.

ALTER TABLE smrtbot_menu_nodes
  ADD COLUMN IF NOT EXISTS button_layout text NOT NULL DEFAULT 'auto';
