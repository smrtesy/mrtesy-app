-- WhatsApp Edge Function v11 — shadow-run monitoring queries
-- ===========================================================
--
-- Run these in the Supabase SQL editor (or via mcp__supabase__execute_sql)
-- during the 48-72 hour shadow window. The goal: prove that
-- source_messages_shadow (written by Edge whatsapp-v11) is byte-identical
-- to source_messages (written by Express whatsapp-webhook.ts) for every
-- WhatsApp chat touched during the window.
--
-- If all queries return clean / zero / matching results, the Edge port is
-- safe to flip into production. If any return mismatches, investigate
-- BEFORE turning off Express — that's the whole point of shadow.
--
-- Replace <SHADOW_START> with the timestamp you set WHATSAPP_SHADOW_FORWARD=1
-- on Railway, e.g. '2026-05-21 10:00:00+00'.


-- ───────────────────────────────────────────────────────────────────────
-- 1) Are shadow rows even being written? (sanity check, first 30 minutes)
-- ───────────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                       AS shadow_rows,
  count(*) FILTER (WHERE created_at > now() - interval '30 min') AS shadow_last_30min,
  min(created_at)                                                AS first_shadow_at,
  max(created_at)                                                AS last_shadow_at
FROM source_messages_shadow
WHERE source_type IN ('whatsapp', 'whatsapp_echo');


-- ───────────────────────────────────────────────────────────────────────
-- 2) Coverage: for every real WhatsApp source_messages row created during
--    the shadow window, is there a matching row in shadow?
--    A clean run = zero "missing in shadow" rows.
-- ───────────────────────────────────────────────────────────────────────
WITH real_in_window AS (
  SELECT user_id, source_type, source_id, subject, received_at
  FROM source_messages
  WHERE source_type IN ('whatsapp', 'whatsapp_echo')
    AND created_at > '<SHADOW_START>'
)
SELECT count(*)                       AS real_count,
       count(sh.source_id)            AS matched_in_shadow,
       count(*) - count(sh.source_id) AS missing_in_shadow
FROM real_in_window r
LEFT JOIN source_messages_shadow sh
  USING (user_id, source_type, source_id);


-- ───────────────────────────────────────────────────────────────────────
-- 2a) Spot-check: list specific (user_id, chat) pairs that are in real
--     but missing from shadow. Diagnose case-by-case.
-- ───────────────────────────────────────────────────────────────────────
SELECT r.user_id, r.source_id, r.subject, r.received_at
FROM source_messages r
LEFT JOIN source_messages_shadow sh
  USING (user_id, source_type, source_id)
WHERE r.source_type IN ('whatsapp', 'whatsapp_echo')
  AND r.created_at > '<SHADOW_START>'
  AND sh.source_id IS NULL
ORDER BY r.received_at DESC
LIMIT 20;


-- ───────────────────────────────────────────────────────────────────────
-- 3) Content equality: do real and shadow rows match field-by-field?
--    Zero rows = perfect parity. Any rows here = port bug.
-- ───────────────────────────────────────────────────────────────────────
SELECT r.source_id,
       r.subject IS DISTINCT FROM sh.subject              AS subject_diff,
       r.body_text IS DISTINCT FROM sh.body_text          AS body_diff,
       r.raw_content IS DISTINCT FROM sh.raw_content      AS raw_diff,
       r.sender IS DISTINCT FROM sh.sender                AS sender_diff,
       r.source_url IS DISTINCT FROM sh.source_url        AS url_diff,
       r.reply_to_context IS DISTINCT FROM sh.reply_to_context AS reply_diff,
       r.received_at IS DISTINCT FROM sh.received_at      AS received_diff,
       r.metadata IS DISTINCT FROM sh.metadata            AS meta_diff
FROM source_messages r
JOIN source_messages_shadow sh USING (user_id, source_type, source_id)
WHERE r.source_type IN ('whatsapp', 'whatsapp_echo')
  AND r.created_at > '<SHADOW_START>'
  AND (
    r.subject IS DISTINCT FROM sh.subject OR
    r.body_text IS DISTINCT FROM sh.body_text OR
    r.raw_content IS DISTINCT FROM sh.raw_content OR
    r.sender IS DISTINCT FROM sh.sender OR
    r.source_url IS DISTINCT FROM sh.source_url OR
    r.reply_to_context IS DISTINCT FROM sh.reply_to_context OR
    r.received_at IS DISTINCT FROM sh.received_at OR
    r.metadata IS DISTINCT FROM sh.metadata
  )
ORDER BY r.received_at DESC
LIMIT 50;


-- ───────────────────────────────────────────────────────────────────────
-- 4) raw_content byte-level diff for one specific source_id. Use this
--    after query 3 surfaces a mismatch to see the exact text diff.
-- ───────────────────────────────────────────────────────────────────────
SELECT 'real'   AS side, raw_content
FROM source_messages
WHERE source_id = '<wa:CHATID>' AND source_type = 'whatsapp'
UNION ALL
SELECT 'shadow' AS side, raw_content
FROM source_messages_shadow
WHERE source_id = '<wa:CHATID>' AND source_type = 'whatsapp';


-- ───────────────────────────────────────────────────────────────────────
-- 5) Health of the Edge Function itself: did any v11 invocations log
--    errors via console.error / console.warn? Check via:
-- ───────────────────────────────────────────────────────────────────────
-- Not in SQL — go to Supabase dashboard → Edge Functions → whatsapp-v11 → Logs
-- Or via MCP: mcp__supabase__get_logs project_id=exjnlghuzuvqedlltztz service=edge-function


-- ───────────────────────────────────────────────────────────────────────
-- DECISION RULE
-- ───────────────────────────────────────────────────────────────────────
-- After 48-72 hours:
--   - Query 2: missing_in_shadow = 0
--   - Query 3: returns 0 rows
--   - Query 5: no recurring error pattern
-- → Edge port is safe. Set LIVE_MODE_ENABLED=true in whatsapp-v11, point
--   DualHook at the Edge URL, retire Express webhook (return 410 Gone
--   for 1 week as safety net, then delete).
--
-- If queries 2 or 3 show mismatches → diagnose, fix whatsapp-v11, redeploy,
-- TRUNCATE source_messages_shadow, restart the shadow window.
