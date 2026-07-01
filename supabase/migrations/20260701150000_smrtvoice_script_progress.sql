-- smrtVoice v2 follow-up: per-script progress RPC.
--
-- v1 tracked completed_lines / cost / duration on smrtvoice_projects and the
-- webhook called increment_project_progress after each line. In v2 those
-- counters live on smrtvoice_scripts (a project is now a folder of scripts),
-- so the line.completed webhook needs a script-scoped increment.

CREATE OR REPLACE FUNCTION increment_script_progress(
  p_script_id uuid,
  p_cost      numeric,
  p_duration  numeric
)
RETURNS void AS $$
BEGIN
  UPDATE smrtvoice_scripts
     SET completed_lines        = completed_lines + 1,
         total_cost_usd         = COALESCE(total_cost_usd, 0)         + COALESCE(p_cost, 0),
         total_duration_seconds = COALESCE(total_duration_seconds, 0) + COALESCE(p_duration, 0)
   WHERE id = p_script_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.increment_script_progress(uuid, numeric, numeric)
  SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.increment_script_progress(uuid, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_script_progress(uuid, numeric, numeric)
  TO service_role;
