-- Fan out system errors to super-admins as notifications.
--
-- Any row inserted into log_entries with level='error' creates an
-- action_required notification for every super-admin (scoped to their primary
-- org, since notifications are org-scoped). De-duped to at most one unread
-- alert per category per admin per hour so a systemic failure (e.g. Anthropic
-- API credits exhausted) can't flood the inbox.

create or replace function public.notify_superadmins_on_error()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sa_user uuid;
  sa_org  uuid;
  notif_title text;
  notif_body  text;
begin
  notif_title := 'שגיאת מערכת: ' || coalesce(nullif(NEW.category, ''), 'כללי');
  notif_body  := left(
      coalesce(NEW.error_message, '(ללא פירוט שגיאה)')
      || coalesce(E'\nמשימה: ' || NEW.task_title, '')
      || coalesce(E'\nמקור: '  || NEW.source_type, ''),
      1500);

  for sa_user in select user_id from public.super_admins loop
    select org_id into sa_org
    from public.org_members
    where user_id = sa_user
    order by joined_at asc nulls last
    limit 1;

    if sa_org is null then
      continue;  -- notifications are org-scoped; skip admins with no org
    end if;

    if exists (
      select 1 from public.notifications
      where user_id = sa_user
        and type = 'action_required'
        and title = notif_title
        and is_read = false
        and created_at > now() - interval '1 hour'
    ) then
      continue;
    end if;

    insert into public.notifications
      (org_id, user_id, app_slug, type, title, body, entity_type, entity_id)
    values
      (sa_org, sa_user, 'smrtesy', 'action_required', notif_title, notif_body, 'log_entry', NEW.id);
  end loop;

  return NEW;
end;
$$;

-- Trigger functions aren't reachable via PostgREST; revoke to stay clear of the
-- security-definer advisor lints (0028/0029).
revoke execute on function public.notify_superadmins_on_error() from public, anon, authenticated;

drop trigger if exists trg_notify_superadmins_on_error on public.log_entries;
create trigger trg_notify_superadmins_on_error
after insert on public.log_entries
for each row
when (NEW.level = 'error')
execute function public.notify_superadmins_on_error();
