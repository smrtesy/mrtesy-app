-- Pin search_path on the whatsapp_messages updated_at trigger function
-- (Supabase advisor: function_search_path_mutable). Behavior-identical.
CREATE OR REPLACE FUNCTION whatsapp_messages_bump_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
