-- Turn the per-user knowledge_base into an ORGANIZATION-wide knowledge center
-- with a manager-approval gate.
--
-- Product decision (May 2026):
--   * The knowledge base is shared at the ORG level — every org member can READ
--     approved entries, and the AI draft pipeline reuses them for the whole org.
--   * Adding/approving is gated: any member may SUGGEST an entry (status='pending'),
--     but only an org manager (org_members.role in ('owner','admin')) may approve
--     it. Only approved entries are ever fed to the model or surfaced as "active".
--
-- Existing rows were personal (user_id only). Per the same decision they are
-- shared + auto-approved: assigned to their author's org (when unambiguous) and
-- marked 'approved'. Rows whose author belongs to several orgs (or none) can't be
-- attributed safely, so they stay organization_id IS NULL + status='pending'
-- for a human to resolve rather than leaking into the wrong org.

-- ── 1. New columns ──────────────────────────────────────────────────────────

ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at     timestamptz;

-- status defaults to 'pending' so any future insert that forgets to set it fails
-- closed (invisible until approved) rather than leaking unreviewed content.
ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- ── 2. Backfill existing personal rows ──────────────────────────────────────

-- author of record = the original owner
UPDATE knowledge_base SET created_by = user_id WHERE created_by IS NULL;

-- attribute to the author's org only when they belong to exactly one org
UPDATE knowledge_base kb
SET organization_id = sub.org_id
FROM (
  SELECT user_id, max(org_id) AS org_id, count(*) AS n
  FROM org_members
  GROUP BY user_id
) sub
WHERE kb.user_id = sub.user_id
  AND sub.n = 1
  AND kb.organization_id IS NULL;

-- unambiguously-attributed rows are auto-approved (they were already in active use)
UPDATE knowledge_base
SET status = 'approved', approved_at = now()
WHERE organization_id IS NOT NULL AND status <> 'approved';

-- ambiguous rows stay pending with a NULL org for a human to resolve
UPDATE knowledge_base
SET status = 'pending'
WHERE organization_id IS NULL;

-- ── 3. Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_knowledge_base_org
  ON knowledge_base (organization_id, status, created_at DESC);

-- ── 4. RLS — org members may READ; writes stay server-side (service_role) ─────

-- The old policy granted FOR ALL on user_id = auth.uid() only, which siloed
-- every entry to its author. Replace with an org-aware read policy. All writes
-- go through Express with the service-role client (which bypasses RLS), so no
-- write policy is needed; a permissive write policy would only widen exposure.
DROP POLICY IF EXISTS knowledge_base_self ON knowledge_base;
DROP POLICY IF EXISTS knowledge_base_org_read ON knowledge_base;
CREATE POLICY knowledge_base_org_read ON knowledge_base
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR organization_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- ── 5. Org-scoped nearest-neighbour lookup (approved entries only) ───────────

-- Mirrors match_knowledge_base but scopes to one organization and only returns
-- approved entries, so a pending/rejected suggestion never reaches the model.
CREATE OR REPLACE FUNCTION match_knowledge_base_org(
  query_embedding vector(1024),
  p_org_id        uuid,
  match_threshold float DEFAULT 0.25,
  match_count     int   DEFAULT 1
)
RETURNS TABLE (
  id         uuid,
  question   text,
  answer     text,
  language   text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    kb.id,
    kb.question,
    kb.answer,
    kb.language,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base kb
  WHERE kb.organization_id = p_org_id
    AND kb.status = 'approved'
    AND kb.embedding IS NOT NULL
    AND (kb.embedding <=> query_embedding) <= match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Pin search_path (linter 0011, same rationale as match_knowledge_base).
ALTER FUNCTION public.match_knowledge_base_org(vector, uuid, double precision, integer)
  SET search_path = public;
