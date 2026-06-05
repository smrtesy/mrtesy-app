-- Super-admin error alerts: comprehensive coverage, per-user/per-error dedup.
--
-- Background: error notifications to super-admins are produced by the
-- AFTER INSERT trigger on log_entries (level='error'). Two problems this fixes:
--
--   1. Dedup was per-CATEGORY only (title = 'שגיאת מערכת: ' || category), so a
--      second user's error in the same category within the hour was silently
--      dropped — the admin couldn't tell that multiple users were affected, and
--      distinct errors masked each other. We now dedup per
--      (affected user + category + normalized error signature): the affected
--      user's email is folded into the title, and the dedup matches the title
--      plus a normalized prefix of the error (digit runs collapsed to '#').
--      Distinct users and distinct error types each surface; the same error
--      repeating (even with varying ids) is throttled to one alert/hour so a
--      storm can't flood the inbox.
--
--   2. Coverage: this trigger fires for ANY log_entries row with level='error',
--      from any user, any category, any subsystem — existing or future. Combined
--      with notifyError() now writing a log_entries error row (see
--      server/src/lib/platform/notify.ts), every app's handling-required errors
--      (smrtcrm/smrtbot/smrtvoice/smrtreach + the smrtTask/Google pipeline) flow
--      through this single fan-out to every super-admin.
--
-- Idempotent: create-or-replace the function (the existing trigger keeps
-- pointing at it; privileges are preserved across replace, but we re-issue the
-- revoke to stay clear of the security-definer advisor lints).

create or replace function public.notify_superadmins_on_error()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sa_user        uuid;
  sa_org         uuid;
  affected_email text;
  notif_title    text;
  notif_body     text;
  notif_sig      text;
begin
  -- WHO is affected — surfaced in the title so the admin sees the user, and so
  -- dedup is per (user + category) rather than collapsing all users together.
  select email into affected_email from auth.users where id = NEW.user_id;

  notif_title := 'שגיאת מערכת: ' || coalesce(nullif(NEW.category, ''), 'כללי')
                 || coalesce(' · ' || affected_email, '');
  notif_body  := left(
      coalesce(NEW.error_message, '(ללא פירוט שגיאה)')
      || coalesce(E'\nמשימה: ' || NEW.task_title, '')
      || coalesce(E'\nמקור: '  || NEW.source_type, ''),
      1500);

  -- Dedup signature: the error's stable PREFIX with digit runs collapsed to '#'.
  -- This distinguishes genuinely different errors (different text) while
  -- throttling the SAME error that repeats with varying ids/counters/timestamps
  -- ("request 123 failed" vs "request 456 failed" → identical signature), which
  -- a full-body equality check would treat as distinct and flood the inbox.
  notif_sig := regexp_replace(left(notif_body, 160), '[0-9]+', '#', 'g');

  for sa_user in select user_id from public.super_admins loop
    select org_id into sa_org
    from public.org_members
    where user_id = sa_user
    order by joined_at asc nulls last
    limit 1;

    if sa_org is null then
      continue;  -- notifications are org-scoped; skip admins with no org
    end if;

    -- Dedup per (super-admin, affected user + category [title], normalized error
    -- signature) within the hour. A different affected user OR a different error
    -- type produces a fresh alert; the same error repeating (even with varying
    -- ids) is suppressed so a storm can't flood the inbox.
    if exists (
      select 1 from public.notifications
      where user_id = sa_user
        and type = 'action_required'
        and title = notif_title
        and regexp_replace(left(body, 160), '[0-9]+', '#', 'g') = notif_sig
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

revoke execute on function public.notify_superadmins_on_error() from public, anon, authenticated;
