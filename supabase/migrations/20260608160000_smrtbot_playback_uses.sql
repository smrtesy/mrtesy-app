-- ============================================================
-- smrtBot — per-link playback use limit (anti-forwarding)
-- ============================================================
-- Each playback token carries a unique jti. The verify endpoint counts uses
-- per jti and blocks beyond max_uses (default 2 → allows one refresh, blocks
-- wide forwarding). HLS segment requests hit the CDN, NOT our verify endpoint,
-- so only the page-load verify counts. Written solely by the service-role
-- verify endpoint, so RLS is enabled with no policy (service role bypasses it).

CREATE TABLE IF NOT EXISTS smrtbot_playback_uses (
  jti           uuid PRIMARY KEY,
  video         text,
  email         text,
  uses          integer NOT NULL DEFAULT 0,
  max_uses      integer NOT NULL DEFAULT 2,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_playback_uses ENABLE ROW LEVEL SECURITY;

-- Atomic check-and-increment: inserts the row on first use (uses=1) or bumps
-- the counter, returning whether the use is still within the limit. The
-- INSERT…ON CONFLICT…RETURNING runs as a single statement so concurrent loads
-- can't both slip past the cap.
CREATE OR REPLACE FUNCTION smrtbot_playback_consume(
  p_jti uuid, p_video text, p_email text, p_max integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uses integer;
BEGIN
  INSERT INTO public.smrtbot_playback_uses (jti, video, email, uses, max_uses)
  VALUES (p_jti, p_video, p_email, 1, p_max)
  ON CONFLICT (jti) DO UPDATE
    SET uses = public.smrtbot_playback_uses.uses + 1, last_used_at = now()
  RETURNING uses INTO v_uses;
  RETURN v_uses <= p_max;
END$$;
