-- Global content search — one unified index over every searchable surface in
-- the platform, so a single query can return settings/screens, tasks/
-- suggestions/info, and Claude conversations, grouped by type.
--
-- Design (docs/global-search-plan.md):
--   • ONE table, not an embedding column per source table — so there is one
--     vector index, one match function, and grouping is a GROUP BY source_type.
--   • Mirrors the proven knowledge_base / info_facts pattern: pgvector
--     vector(1024) (voyage-4), HNSW cosine index, a match_* SQL function called
--     from Express via the service-role client (filters by org/user explicitly
--     rather than relying on RLS).
--   • HYBRID retrieval: a `keywords` text column carries names/entities/synonyms
--     and gets a trgm GIN index, so an exact-entity query ("שפרה") matches by
--     token while the embedding matches by meaning ("ביטוח רפואי"). Vector alone
--     blurs specific entities; the trgm half is what pins them.
--   • source_id is TEXT with NO foreign key: it references different tables per
--     source_type (a tasks uuid, a source_messages uuid, a claude_threads uuid,
--     or a destination href), so no single FK fits. Freshness is maintained by
--     the indexer per source, not by a DB cascade — except destinations, which
--     are global config.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS search_documents (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Permission scope. Both NULL = a global row (navigation destinations, which
  -- every user can see; per-destination admin gating happens in the endpoint).
  -- org_id set = tenant content; user_id set = private to that user.
  org_id       uuid        REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 'destination' | 'task' | 'suggestion' | 'info' | 'claude_thread'
  source_type  text        NOT NULL,
  -- The source row's id (uuid as text) or, for destinations, the href.
  source_id    text        NOT NULL,
  title        text        NOT NULL,
  snippet      text,
  -- The deep link opened when the result is clicked (a tab).
  url          text        NOT NULL,
  -- Names / entities / synonyms for the trgm (exact-ish) half of hybrid search.
  keywords     text,
  language     text,
  -- voyage-4 embedding of title + snippet + keywords. Nullable so a row can be
  -- stored even when Voyage is unavailable; match_search_documents skips NULLs.
  embedding    vector(1024),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- One row per source item; re-indexing an item upserts on this.
  UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS search_documents_scope_idx
  ON search_documents (org_id, user_id, source_type);

-- HNSW cosine index for nearest-neighbour search over the embeddings.
CREATE INDEX IF NOT EXISTS search_documents_embedding_idx
  ON search_documents USING hnsw (embedding vector_cosine_ops);

-- trgm GIN index on keywords for the exact-entity half of hybrid search.
CREATE INDEX IF NOT EXISTS search_documents_keywords_trgm_idx
  ON search_documents USING gin (keywords gin_trgm_ops);

ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;

-- Self/global read for any direct frontend access. The server uses service_role
-- and bypasses this; the endpoint does the real permission filtering.
DROP POLICY IF EXISTS search_documents_read ON search_documents;
CREATE POLICY search_documents_read ON search_documents
  FOR SELECT USING (
    (org_id IS NULL AND user_id IS NULL)
    OR user_id = auth.uid()
  );

-- ─── Hybrid match: vector (meaning) + trgm (exact entity), permission-scoped ───
-- Returns the best-scoring rows across all requested source types. A row
-- qualifies if EITHER its embedding is close enough OR its keywords are
-- textually similar to the query; the score blends both so an exact-name hit
-- (high text similarity) surfaces even when the embedding is only lukewarm, and
-- vice-versa. Called from Express with the service-role client, so it filters
-- org/user explicitly.
CREATE OR REPLACE FUNCTION match_search_documents(
  query_embedding vector(1024),
  query_text      text,
  p_org_id        uuid,
  p_user_id       uuid,
  p_source_types  text[] DEFAULT ARRAY['destination','task','suggestion','info','claude_thread'],
  vec_threshold   float  DEFAULT 0.35,   -- max cosine DISTANCE to qualify on meaning
  txt_threshold   float  DEFAULT 0.30,   -- min word_similarity to qualify on text
  match_count     int    DEFAULT 24
)
RETURNS TABLE (
  id          uuid,
  source_type text,
  source_id   text,
  title       text,
  snippet     text,
  url         text,
  language    text,
  vec_sim     float,
  txt_sim     float,
  score       float
)
LANGUAGE sql STABLE
AS $$
  WITH scoped AS (
    SELECT
      d.*,
      CASE WHEN d.embedding IS NOT NULL
           THEN 1 - (d.embedding <=> query_embedding)
           ELSE 0 END                                    AS vec_sim,
      word_similarity(query_text, coalesce(d.keywords, '') || ' ' || d.title) AS txt_sim,
      (d.embedding IS NOT NULL AND (d.embedding <=> query_embedding) <= vec_threshold) AS vec_hit
    FROM search_documents d
    WHERE d.source_type = ANY(p_source_types)
      AND (
        (d.org_id IS NULL AND d.user_id IS NULL)          -- global (destinations)
        OR d.user_id = p_user_id                          -- the caller's own rows (any org / null org)
        OR (d.org_id = p_org_id AND d.user_id IS NULL)    -- org-wide, non-personal rows
      )
  )
  SELECT
    id, source_type, source_id, title, snippet, url, language,
    vec_sim, txt_sim,
    -- Blend: meaning is the base, an exact-entity text hit adds a strong boost.
    (vec_sim + 0.6 * txt_sim) AS score
  FROM scoped
  WHERE vec_hit OR txt_sim >= txt_threshold
  ORDER BY score DESC
  LIMIT match_count;
$$;

-- Pin search_path (linter 0011, same rationale as match_knowledge_base).
ALTER FUNCTION public.match_search_documents(vector, text, uuid, uuid, text[], double precision, double precision, integer)
  SET search_path = public;
