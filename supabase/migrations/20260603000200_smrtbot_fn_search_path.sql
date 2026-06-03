-- Pin search_path on the smrtBot updated_at trigger function to satisfy the
-- Supabase security linter (function_search_path_mutable). The function only
-- assigns NEW.updated_at, so an empty search_path is safe.
ALTER FUNCTION public.smrtbot_touch_updated_at() SET search_path = '';
