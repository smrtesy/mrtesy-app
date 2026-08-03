-- Search index queue: give up on a row that keeps failing.
--
-- Why: an item that errors, or whose Voyage embedding comes back null, was left
-- in the queue forever (worker.ts kept it so a later drain could retry). With
-- Voyage on the free tier (3 requests/min, 10K tokens/min) EVERY embed call
-- 429s once the queue is busy, so every row was re-queued every minute and the
-- backlog never drained — the queue sat at 128 rows for four days and new
-- content stopped getting embeddings. A permanently-failing row must not be
-- able to block the index.
--
-- The row's TEXT is already written to search_documents before the embedding is
-- attempted, so dropping it from the queue after N tries costs only the vector
-- (semantic match) for that one item — keyword search still finds it.
ALTER TABLE search_index_queue
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN search_index_queue.attempts IS
  'Times the drain tried and failed this row. The worker drops the row once it '
  'passes its cap so one bad item can never stall the whole index.';
