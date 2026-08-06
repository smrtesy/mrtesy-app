-- Feature Channels (ערוצי-בשלות) — docs/feature-channels-plan.md.
--
-- Two release channels over ONE deployment: "beta" (Chanoch + selected team,
-- sees everything) and "stable" (customers, sees only promoted/verified
-- features). This is ORTHOGONAL to the permissions/app-entitlement layer:
-- permissions = "who is ALLOWED what"; channel = "which MATURITY level of the
-- product they see". Two separate axes.
--
-- Structure vs state (plan §3): the STRUCTURE — which features exist, what
-- screen they belong to, code_ref, intent — lives in code
-- (src/lib/feature-registry.ts), where the push hook can enforce it. This
-- table holds the STATE — what is enabled per channel, which version, dates,
-- notes — edited from the /admin/features screen with ZERO AI/tokens at read
-- time (the layout reads it once and injects into AppAccessContext).
--
-- Additive only (ADD COLUMN / CREATE TABLE) — applied via the Supabase
-- Management API per repo policy, never `supabase db push`.

-- §4.1 — where the channel is stored and how it resolves.
-- user override wins over the org default; new users default to 'stable' so a
-- regular customer never sees beta until Chanoch assigns them explicitly.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS release_channel text NOT NULL DEFAULT 'stable'
    CHECK (release_channel IN ('stable', 'beta'));

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS release_channel text NOT NULL DEFAULT 'stable'
    CHECK (release_channel IN ('stable', 'beta'));

COMMENT ON COLUMN public.user_settings.release_channel IS
  'Per-user release channel override (feature-channels). stable|beta. Wins over organizations.release_channel. Set by super-admin only — no self-serve toggle.';
COMMENT ON COLUMN public.organizations.release_channel IS
  'Org default release channel (feature-channels). stable|beta. A user override in user_settings.release_channel takes precedence.';

-- §4.4 — the STATE table. feature_id mirrors src/lib/feature-registry.ts.
CREATE TABLE IF NOT EXISTS public.feature_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id      text NOT NULL UNIQUE,      -- kebab, matches feature-registry.ts
  screen_key      text NOT NULL,             -- path from site-map.ts, e.g. "/whatsapp"
  title           text NOT NULL,
  title_he        text,
  stable_enabled  boolean NOT NULL DEFAULT false,  -- the toggle, stable channel
  beta_enabled    boolean NOT NULL DEFAULT true,   -- the toggle, beta channel
  stable_version  text NOT NULL DEFAULT 'v1',      -- which version in stable
  beta_version    text NOT NULL DEFAULT 'v1',      -- which version in beta
  intent          text NOT NULL DEFAULT 'fork'
                    CHECK (intent IN ('fork', 'migrate')),
  promote_by      date,                       -- migrate only, soft, optional
  notes_url       text,                        -- link explaining the changes
  last_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.feature_channels IS
  'Per-feature channel STATE (feature-channels, plan §4.4). One row per feature_id from src/lib/feature-registry.ts. Read once by (app)/layout.tsx into AppAccessContext; edited from /admin/features. stable/beta_enabled = the toggle; stable/beta_version = which version each channel renders; intent fork|migrate; promote_by soft deadline for migrate only.';

-- Read path is "give me every feature for a screen"; keep it indexed.
CREATE INDEX IF NOT EXISTS feature_channels_screen_key_idx
  ON public.feature_channels (screen_key);
