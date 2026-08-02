-- Fix: the managed_secret_targets unique constraint treated NULL target_ref as
-- distinct, so the common single-service Railway case (target_ref = NULL, the
-- connector auto-resolves the service) let the SAME target be added twice — and a
-- sync would then write it twice. Recreate the constraint with NULLS NOT DISTINCT
-- (Postgres 15+; this project is on 17) so two NULL target_refs collide like any
-- other duplicate. No data is deleted or changed — the tables were created empty in
-- the prior migration, so there are no existing duplicate NULLs to reconcile.

alter table public.managed_secret_targets
  drop constraint if exists managed_secret_targets_unique;

alter table public.managed_secret_targets
  add constraint managed_secret_targets_unique
  unique nulls not distinct (secret_id, provider, target_ref, env_var_name, environment);
