-- Managed secrets — one place to add a key, live mirror + auto-propagate.
-- Design: docs/managed-secrets-plan.md (phase 1 = Railway loop).
--
-- Three tables:
--   managed_secrets         — the logical key; its value lives in Supabase Vault
--                             (vault_secret_id), never plaintext in a column.
--   managed_secret_targets  — one row per destination (provider + env var name +
--                             environment); carries the live-mirror bookkeeping
--                             (presence, a value FINGERPRINT for drift — never the
--                             value) and the last-sync result.
--   secret_sync_log         — append-only audit of every read/sync/write. Never
--                             stores a secret value.
--
-- Security: these tables hold the map of which secret goes where (and Vault ids),
-- so they are service-role only. RLS is ENABLED with NO policies → anon /
-- authenticated (PostgREST) are denied outright; the Express backend reaches them
-- with the service-role key, which bypasses RLS. This matches how app_secrets is
-- reached (backend-only, via the admin super-admin routes).

-- ── managed_secrets ────────────────────────────────────────────────────────────
create table if not exists public.managed_secrets (
  id              uuid primary key default gen_random_uuid(),
  key_name        text not null,
  description     text,
  -- Supabase Vault secret id. Null until a value is first set. The real value is
  -- read only at sync time via vault_read_secret; it is NEVER stored here.
  vault_secret_id uuid,
  -- Short sha256 fingerprint (first 12 hex) of the CURRENT intended value, so the
  -- mirror can flag drift ("provider value differs") without ever holding the value.
  value_fingerprint text,
  rotated_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint managed_secrets_key_name_unique unique (key_name)
);

comment on table public.managed_secrets is
  'Managed secrets registry — logical keys whose values live in Supabase Vault. Service-role only. See docs/managed-secrets-plan.md.';

-- ── managed_secret_targets ─────────────────────────────────────────────────────
create table if not exists public.managed_secret_targets (
  id                uuid primary key default gen_random_uuid(),
  secret_id         uuid not null references public.managed_secrets(id) on delete cascade,
  provider          text not null check (provider in ('railway', 'vercel', 'supabase')),
  -- The provider resource id this var belongs to: Railway service id / Vercel
  -- project id / Supabase project ref. Nullable → the connector auto-resolves from
  -- the platform-level provider config (e.g. the single Railway service).
  target_ref        text,
  -- The variable name on THIS provider (may differ per service).
  env_var_name      text not null,
  environment       text not null default 'production',
  -- Live-mirror bookkeeping, refreshed by the read path. Never the value.
  last_seen_present boolean,
  value_fingerprint text,             -- fingerprint of the value as it exists on the provider
  last_synced_at    timestamptz,
  last_sync_status  text,             -- 'ok' | 'error' | null (never synced)
  last_sync_error   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint managed_secret_targets_unique
    unique (secret_id, provider, target_ref, env_var_name, environment)
);

comment on table public.managed_secret_targets is
  'One destination per row for a managed secret (provider + env var + environment). Holds presence/fingerprint drift bookkeeping — never the value. Service-role only.';

create index if not exists managed_secret_targets_secret_idx
  on public.managed_secret_targets (secret_id);

-- ── secret_sync_log ────────────────────────────────────────────────────────────
create table if not exists public.secret_sync_log (
  id            uuid primary key default gen_random_uuid(),
  secret_id     uuid references public.managed_secrets(id) on delete set null,
  target_id     uuid references public.managed_secret_targets(id) on delete set null,
  action        text not null,        -- 'read' | 'sync' | 'write' | 'create' | 'rotate' | 'add_target' | 'remove_target'
  provider      text,
  env_var_name  text,
  result        text not null,        -- 'ok' | 'error'
  message       text,                 -- human-readable detail — NEVER a secret value
  actor         text,                 -- super-admin identity (user id / email)
  created_at    timestamptz not null default now()
);

comment on table public.secret_sync_log is
  'Append-only audit of every managed-secret read/sync/write. Never stores a secret value. Service-role only.';

create index if not exists secret_sync_log_secret_idx
  on public.secret_sync_log (secret_id, created_at desc);

-- ── lock down: RLS on, no policies (service-role only) ──────────────────────────
alter table public.managed_secrets        enable row level security;
alter table public.managed_secret_targets enable row level security;
alter table public.secret_sync_log        enable row level security;
