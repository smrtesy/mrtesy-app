-- ============================================================
-- smrtBot — web-chat widget appearance + behaviour
-- ============================================================
-- Lets each bot's web widget be styled and configured from the admin "Web
-- chat" tab (the embed snippet stays minimal — just data-key — and the widget
-- reads everything else from these columns via the public /config endpoint).
--
-- web_accent_color + web_greeting already exist (20260607120000).

ALTER TABLE smrtbot_bots
  -- Logo/icon shown on the floating launcher button and the widget header
  -- avatar. Falls back to the default chat bubble when null.
  ADD COLUMN IF NOT EXISTS web_icon_url text,
  -- Header title + subtitle. Title falls back to the bot name.
  ADD COLUMN IF NOT EXISTS web_title    text,
  ADD COLUMN IF NOT EXISTS web_subtitle text,
  -- Launcher placement + panel size, both configured from the tab.
  ADD COLUMN IF NOT EXISTS web_position text NOT NULL DEFAULT 'right',  -- 'right' | 'left'
  ADD COLUMN IF NOT EXISTS web_size     text NOT NULL DEFAULT 'standard'; -- 'compact' | 'standard' | 'large'
