-- Security-hardening plan §7 step 6 / §5.4 (decision א): per-org secrets.
--
-- The plan's original decision assumed app_secrets were per-org; they are not —
-- app_secrets is platform-wide infrastructure (the Anthropic/Railway/Supabase
-- keys) and must stay super-admin-only. This table is the actual per-org model:
-- free-form key/value secrets an ORG brings itself (its own WhatsApp token,
-- OpenAI key, SMTP, Stripe, …), managed by that org's OWNER, scoped by org_id,
-- and never visible to another org, to non-owners, or to a developer.
--
-- Shape mirrors app_secrets: the value lives in Supabase Vault (value_secret_id
-- ref) when secret, or in value_text when it's plain config. RLS is
-- deny-all-to-everyone (like app_secrets_no_one); the ONLY reader is the backend
-- service-role, which mediates owner + org scoping in code
-- (server/src/modules/platform/org-secrets). decrypt/vault_read stays
-- service-role-only, so a dump or a non-service_role DB role sees ciphertext.
CREATE TABLE IF NOT EXISTS public.org_secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key             text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),
  is_secret       boolean NOT NULL DEFAULT true,
  value_text      text,
  value_secret_id uuid,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);

COMMENT ON TABLE public.org_secrets IS
  'Security plan §5.4: per-org secrets an org brings itself. Value in Vault '
  '(value_secret_id) when is_secret, else value_text. Owner-managed, org-scoped, '
  'backend-mediated (service-role only). NOT app_secrets (platform-wide).';

-- Deny all direct table access; the backend (service-role) bypasses RLS and is
-- the sole path in. Identical stance to app_secrets_no_one.
ALTER TABLE public.org_secrets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_secrets_no_one ON public.org_secrets;
CREATE POLICY org_secrets_no_one ON public.org_secrets
  FOR ALL TO public USING (false) WITH CHECK (false);
