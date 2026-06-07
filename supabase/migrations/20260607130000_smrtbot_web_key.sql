-- ============================================================
-- smrtBot — web-chat public embed key
-- ============================================================
-- The embeddable widget identifies its bot by a public key in the snippet
-- (<script data-key="wk_…">). The bot `slug` is only unique per org
-- (UNIQUE(org_id, slug)), so it can't safely identify a bot from an anonymous,
-- org-less public request. `web_key` is globally unique, opaque (doesn't leak
-- the slug/PK), and rotatable (regenerate to kill a leaked snippet).
--
-- Generated server-side when web chat is first enabled (see routes/bots.ts).

ALTER TABLE smrtbot_bots
  ADD COLUMN IF NOT EXISTS web_key text;

CREATE UNIQUE INDEX IF NOT EXISTS smrtbot_bots_web_key_idx
  ON smrtbot_bots (web_key)
  WHERE web_key IS NOT NULL;
