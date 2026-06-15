-- AI cost reduction: widen the WhatsApp burst-coalescing window 90s -> 600s.
--
-- WhatsApp is ~73% of classify volume. Rapid messages already coalesce into one
-- "burst" classified once, but only after the chat is quiet for
-- whatsapp_debounce_seconds (was 90s). An active conversation spread over time
-- has many >90s gaps, so it splits into many bursts — each a separate Sonnet
-- classify. Real data (7 days): 1132 WhatsApp messages produced 602 bursts at
-- 90s vs 390 at 600s — a ~35% cut in WhatsApp classify passes (~$0.7/day).
--
-- Tradeoff: a WhatsApp-derived task surfaces up to ~10 min after the chat
-- settles. Quality is unchanged — same Sonnet, same content; the existing
-- rolling-window + high-water split still ensures every new message is seen,
-- just classified together once the conversation settles. Fully reversible:
-- set the value back to 90.

ALTER TABLE smrttask_system_params
  ALTER COLUMN whatsapp_debounce_seconds SET DEFAULT 600;

UPDATE smrttask_system_params
  SET whatsapp_debounce_seconds = 600
  WHERE whatsapp_debounce_seconds = 90;
