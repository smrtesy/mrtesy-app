-- knowledge_base: per-user library of approved question→answer pairs, with a
-- Voyage embedding of the question for semantic reuse. When a new task/email/
-- WhatsApp message arrives, the action executor embeds the incoming question,
-- finds the closest previously-approved answer (match_knowledge_base below),
-- and feeds it to the draft model as reference material — so a question that
-- was answered once gets the same answer auto-drafted next time, even when
-- phrased differently or in another language.
--
-- User-scoped to match tasks / thread_memory / rules_memory. The Express
-- server writes via the service-role client (bypasses RLS); the self RLS
-- policy only matters for any direct frontend read.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_base (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question     text          NOT NULL,
  answer       text          NOT NULL,
  -- voyage-4 default output dimension. Nullable so a row can still be stored
  -- if Voyage is unavailable at save time; match_knowledge_base skips NULLs.
  embedding    vector(1024),
  -- 'gmail' | 'whatsapp' | free-form. No CHECK on purpose: source_messages
  -- emits several source_type values and we never want a save to fail on it.
  source_type  text,
  -- detected language of the question, free-form ('he' | 'en' | …).
  language     text,
  -- task this Q&A was approved from, for tracing. Nullable.
  task_id      uuid          REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_user ON knowledge_base (user_id, created_at DESC);

-- HNSW cosine index for nearest-neighbour search over the question embeddings.
CREATE INDEX IF NOT EXISTS idx_knowledge_base_embedding
  ON knowledge_base USING hnsw (embedding vector_cosine_ops);

ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

-- Self-access for the frontend. The server uses service_role and bypasses this.
DROP POLICY IF EXISTS knowledge_base_self ON knowledge_base;
CREATE POLICY knowledge_base_self ON knowledge_base
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Nearest-neighbour lookup scoped to one user. Returns rows whose question
-- embedding is within match_threshold cosine DISTANCE of the query embedding
-- (distance = 1 - cosine similarity; smaller = more similar), closest first.
-- Called from the server via the service-role client, so it filters by
-- p_user_id explicitly rather than relying on RLS.
CREATE OR REPLACE FUNCTION match_knowledge_base(
  query_embedding vector(1024),
  p_user_id       uuid,
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
  WHERE kb.user_id = p_user_id
    AND kb.embedding IS NOT NULL
    AND (kb.embedding <=> query_embedding) <= match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
$$;
