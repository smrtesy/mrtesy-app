-- One-time, short-lived tokens that let an org owner/admin PREVIEW the app as
-- one of their members (impersonation preview) — the primary use is checking a
-- no-email placeholder employee's view before giving them a real login email.
--
-- Flow: POST /api/org/members/:userId/preview-link (owner/admin, backend) inserts
-- a row and returns a URL to /api/preview?token=… (the Next.js app). Opening that
-- URL in a clean/incognito window consumes the token ONCE and mints a real
-- Supabase session as target_user_id, setting the app's auth cookies on that
-- window only — the manager's own session is untouched.
--
-- Only ever read/written by service-role backend code, so no RLS policies are
-- added (the table is invisible to the anon/authenticated frontend clients).

create table if not exists public.member_preview_tokens (
  token          uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  target_user_id uuid not null,
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz
);

-- The consume path filters on (token, used_at is null, expires_at > now); the PK
-- covers the token lookup. This index supports cleanup of expired rows.
create index if not exists idx_member_preview_tokens_expires
  on public.member_preview_tokens (expires_at);

comment on table public.member_preview_tokens is
  'One-time short-lived tokens for an org owner/admin to preview the app as a member (impersonation preview). Consumed once by the /api/preview route, which mints a session as target_user_id.';
