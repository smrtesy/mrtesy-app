-- ============================================================
-- smrtInfo — Information-center fact store schema
-- ============================================================
-- The queryable knowledge base behind the smrtInfo "ask anything" center.
-- Each info_facts row is ONE extracted fact (entity/attribute/value) pulled
-- from the ingest stream (source_messages: gmail/drive/whatsapp/calendar/sms),
-- with a Voyage embedding of a natural-language rendering for semantic search.
--
-- SECURITY: RLS is ENABLED with NO policy on purpose (same pattern as
-- smrtvault_credentials). All reads/writes go through the service-role Express
-- server, which scopes every query by org_id and — for personal facts — by
-- user_id. Passwords are NEVER stored here: a detected secret becomes a
-- save-suggestion routed to smrtVault (Supabase Vault); info_facts keeps at
-- most a non-sensitive pointer ("a bank password exists in the vault").

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── updated_at trigger ──────────────────────────────────────
CREATE OR REPLACE FUNCTION smrtinfo_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ─── 1. Facts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS info_facts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,

  -- personal | org | unclassified. Defaults to 'unclassified' so an
  -- unattributed fact surfaces in both views for a one-tap assignment,
  -- never silently mis-scoped.
  scope              text NOT NULL DEFAULT 'unclassified'
                       CHECK (scope IN ('personal','org','unclassified')),

  entity             text NOT NULL,   -- "FPL", "ביטוח חיים – יהודית", "בנק – קופצ'יק"
  attribute          text NOT NULL,   -- "insurer", "payment_date", "account_user"
  value              text NOT NULL,   -- the fact value
  effective_date     date,            -- when the value takes effect (optional)

  confidence         numeric(4,3),    -- AI confidence 0..1
  -- hybrid extraction: high-confidence facts land verified=true (live &
  -- authoritative); low-confidence land verified=false ("לא מאומת") and are
  -- offered for one-tap approval. Both are searchable; the UI flags unverified.
  verified           boolean NOT NULL DEFAULT false,

  language           text,

  -- provenance. source_message_id is the source_messages row id (kept WITHOUT a
  -- FK: that base table predates the migrations folder, so we avoid locking it /
  -- assuming its id type). source_url is the verbatim deep link (product rule:
  -- never strip a URL down to its domain).
  source_message_id  uuid,
  source_type        text,            -- gmail | whatsapp | google_drive | ...
  source_url         text,

  -- semantic search over a natural-language rendering of the fact.
  embedding          vector(1024),

  -- lifecycle: when a newer fact supersedes this (entity,attribute,scope),
  -- the old row is copied to info_fact_history and superseded_by points at the
  -- replacement, so match_info_facts can exclude stale values.
  superseded_by      uuid REFERENCES info_facts(id) ON DELETE SET NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE info_facts ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only (see SECURITY note above).

CREATE INDEX IF NOT EXISTS info_facts_owner_idx
  ON info_facts(org_id, user_id);
-- dedup / supersede lookup by (org, scope, entity, attribute)
CREATE INDEX IF NOT EXISTS info_facts_key_idx
  ON info_facts(org_id, scope, entity, attribute);
-- "current only" is the common filter
CREATE INDEX IF NOT EXISTS info_facts_live_idx
  ON info_facts(org_id) WHERE superseded_by IS NULL;
-- Hebrew-aware keyword matching on the entity name (hybrid search).
CREATE INDEX IF NOT EXISTS info_facts_entity_trgm_idx
  ON info_facts USING gin (entity gin_trgm_ops);
-- HNSW cosine index for nearest-neighbour search over the fact embeddings.
CREATE INDEX IF NOT EXISTS info_facts_embedding_idx
  ON info_facts USING hnsw (embedding vector_cosine_ops);

CREATE TRIGGER info_facts_updated_at BEFORE UPDATE ON info_facts
  FOR EACH ROW EXECUTE FUNCTION smrtinfo_set_updated_at();

-- ─── 2. Fact history (superseded values) ─────────────────────
CREATE TABLE IF NOT EXISTS info_fact_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id         uuid REFERENCES info_facts(id) ON DELETE SET NULL,
  org_id          uuid NOT NULL,
  user_id         uuid NOT NULL,
  scope           text,
  entity          text,
  attribute       text,
  value           text,
  effective_date  date,
  source_url      text,
  archived_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE info_fact_history ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only (audit/history rows).

CREATE INDEX IF NOT EXISTS info_fact_history_owner_idx
  ON info_fact_history(org_id, user_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS info_fact_history_fact_idx
  ON info_fact_history(fact_id);

-- ─── 3. Context profile (personal/org disambiguation key) ────
-- One editable profile per (org,user): "my orgs" (domains, vendors), "my
-- family", "my personal vs org accounts". The extractor uses it to tag each
-- fact scope=personal|org|unclassified.
CREATE TABLE IF NOT EXISTS info_context_profile (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  profile     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

ALTER TABLE info_context_profile ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only.

CREATE TRIGGER info_context_profile_updated_at BEFORE UPDATE ON info_context_profile
  FOR EACH ROW EXECUTE FUNCTION smrtinfo_set_updated_at();

-- ─── 3b. Secret save-suggestions (password → smrtVault, gated) ──
-- A password detected in a message is NEVER auto-saved and NEVER stored as a
-- fact. The candidate secret is written to Supabase Vault immediately as a
-- PENDING secret (encrypted); this row keeps only the non-sensitive pointer.
-- On approve → an smrtvault_credentials row is created reusing password_secret_id
-- (no plaintext re-handling). On dismiss → the pending Vault secret is
-- neutralized (overwritten empty), mirroring smrtVault's delete pattern.
CREATE TABLE IF NOT EXISTS info_secret_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  label              text NOT NULL,
  username           text,
  url                text,
  password_secret_id uuid NOT NULL,           -- Vault secret id (pending)
  source_message_id  uuid,
  source_type        text,
  source_url         text,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','dismissed')),
  credential_id      uuid,                     -- smrtvault_credentials id after approve
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE info_secret_suggestions ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only (points at secret material).

CREATE INDEX IF NOT EXISTS info_secret_suggestions_owner_idx
  ON info_secret_suggestions(org_id, user_id, status);

CREATE TRIGGER info_secret_suggestions_updated_at BEFORE UPDATE ON info_secret_suggestions
  FOR EACH ROW EXECUTE FUNCTION smrtinfo_set_updated_at();

-- ─── 4. Nearest-neighbour lookup ─────────────────────────────
-- Cosine search over current (non-superseded) facts, scoped to one org and to
-- the caller for personal facts. Called from Express via the service-role
-- client, so it filters explicitly rather than relying on RLS. Mirrors
-- match_knowledge_base_org.
CREATE OR REPLACE FUNCTION match_info_facts(
  query_embedding vector(1024),
  p_org_id        uuid,
  p_user_id       uuid,
  p_scopes        text[] DEFAULT ARRAY['personal','org','unclassified'],
  match_threshold float DEFAULT 0.45,
  match_count     int   DEFAULT 8
)
RETURNS TABLE (
  id             uuid,
  scope          text,
  entity         text,
  attribute      text,
  value          text,
  effective_date date,
  confidence     float,
  verified       boolean,
  source_type    text,
  source_url     text,
  similarity     float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    f.id, f.scope, f.entity, f.attribute, f.value, f.effective_date,
    f.confidence::float, f.verified, f.source_type, f.source_url,
    1 - (f.embedding <=> query_embedding) AS similarity
  FROM info_facts f
  WHERE f.org_id = p_org_id
    AND f.superseded_by IS NULL
    AND f.embedding IS NOT NULL
    AND f.scope = ANY(p_scopes)
    -- personal facts are private to their owner; org/unclassified are org-wide
    AND (f.scope <> 'personal' OR f.user_id = p_user_id)
    AND (f.embedding <=> query_embedding) <= match_threshold
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Pin search_path (linter 0011, same rationale as match_knowledge_base).
ALTER FUNCTION public.match_info_facts(vector, uuid, uuid, text[], double precision, integer)
  SET search_path = public;
