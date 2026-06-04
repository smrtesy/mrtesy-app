-- Pin search_path on the smrtPlan updated_at trigger function to satisfy the
-- Supabase security linter (function_search_path_mutable). The function only
-- assigns NEW.updated_at, so an empty search_path is safe.
ALTER FUNCTION public.smrtplan_update_updated_at() SET search_path = '';
