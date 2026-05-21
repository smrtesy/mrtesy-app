-- Enable Supabase Realtime broadcasts for the two tables the Sidebar's
-- live counters subscribe to. Without this the supabase.channel(...) call
-- in src/components/platform/layout/Sidebar.tsx subscribes successfully
-- but never receives postgres_changes events — the unread-suggestions
-- badge and open-tasks badge only refresh when the user reloads the page
-- or navigates between tabs.
--
-- RLS already restricts row visibility per-user (notifications.user_id =
-- auth.uid(), tasks user_isolation + tasks_org_select), so each client
-- only sees events for rows it can already SELECT. The publication
-- addition is the missing piece.

ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
