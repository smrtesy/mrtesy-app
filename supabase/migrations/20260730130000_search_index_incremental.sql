-- Incremental global-search indexing — keep search_documents fresh automatically
-- as content changes, instead of only via the manual /search/reindex backfill.
--
-- Why a queue + a worker, not "embed inside a trigger": embedding needs an
-- external Voyage HTTP call, which a Postgres trigger must not make inline
-- (slow, can fail the write). So the trigger only ENQUEUES the changed row's
-- (source_type, source_id); a backend worker (drained by pg_cron, see the
-- companion cron migration) fetches the row, embeds it, and upserts into
-- search_documents. This covers EVERY write path — including the Deno edge
-- functions that ingest source_messages — because it fires at the DB level.
--
-- Deletes need no embedding, so the trigger removes the search_documents row
-- inline (and any pending queue entry) rather than enqueuing.

CREATE TABLE IF NOT EXISTS search_index_queue (
  source_type text        NOT NULL,
  source_id   text        NOT NULL,
  op          text        NOT NULL DEFAULT 'upsert' CHECK (op IN ('upsert')),
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS search_index_queue_order_idx
  ON search_index_queue (enqueued_at);

-- Generic trigger: source_type comes from TG_ARGV[0]. INSERT/UPDATE enqueue a
-- re-index (deduped on the PK); DELETE removes the indexed row + queue entry.
CREATE OR REPLACE FUNCTION enqueue_search_index()
RETURNS trigger
LANGUAGE plpgsql
-- Pin search_path (linter 0011, same rationale as match_search_documents).
SET search_path = public
AS $$
DECLARE
  st text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_documents   WHERE source_type = st AND source_id = OLD.id::text;
    DELETE FROM search_index_queue WHERE source_type = st AND source_id = OLD.id::text;
    RETURN OLD;
  END IF;

  INSERT INTO search_index_queue (source_type, source_id, op, enqueued_at)
  VALUES (st, NEW.id::text, 'upsert', now())
  ON CONFLICT (source_type, source_id)
  DO UPDATE SET op = 'upsert', enqueued_at = now();
  RETURN NEW;
END;
$$;

-- Attach to the three content sources. UPDATE is column-scoped so a re-embed
-- only happens when the searchable text actually changed — not on every
-- unrelated column bump (e.g. a task's status/updated_at).
DROP TRIGGER IF EXISTS trg_search_index_tasks ON tasks;
CREATE TRIGGER trg_search_index_tasks
  AFTER INSERT OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION enqueue_search_index('task');
DROP TRIGGER IF EXISTS trg_search_index_tasks_upd ON tasks;
CREATE TRIGGER trg_search_index_tasks_upd
  AFTER UPDATE OF title, title_he, description ON tasks
  FOR EACH ROW EXECUTE FUNCTION enqueue_search_index('task');

DROP TRIGGER IF EXISTS trg_search_index_msgs ON source_messages;
CREATE TRIGGER trg_search_index_msgs
  AFTER INSERT OR DELETE ON source_messages
  FOR EACH ROW EXECUTE FUNCTION enqueue_search_index('info');
DROP TRIGGER IF EXISTS trg_search_index_msgs_upd ON source_messages;
CREATE TRIGGER trg_search_index_msgs_upd
  AFTER UPDATE OF subject, body_text ON source_messages
  FOR EACH ROW EXECUTE FUNCTION enqueue_search_index('info');

DROP TRIGGER IF EXISTS trg_search_index_threads ON claude_threads;
CREATE TRIGGER trg_search_index_threads
  AFTER INSERT OR DELETE ON claude_threads
  FOR EACH ROW EXECUTE FUNCTION enqueue_search_index('claude_thread');
DROP TRIGGER IF EXISTS trg_search_index_threads_upd ON claude_threads;
CREATE TRIGGER trg_search_index_threads_upd
  AFTER UPDATE OF title ON claude_threads
  FOR EACH ROW EXECUTE FUNCTION enqueue_search_index('claude_thread');
