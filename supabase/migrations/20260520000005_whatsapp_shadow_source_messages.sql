-- Shadow table for the WhatsApp Edge Function port (v11).
--
-- During shadow run, Express continues to own /api/webhooks/whatsapp and
-- writes the real source_messages rows. After Express finishes, it forwards
-- the same Meta payload to whatsapp-v11 (Edge Function) with header
-- X-Shadow-Run=1. v11 walks the payload, reads the (already-Express-written)
-- whatsapp_messages rows, and writes a parallel source_messages row HERE.
--
-- This lets us diff the two tables in SQL to verify the Edge port is
-- byte-identical before flipping DualHook to point at the Edge Function.
-- After flip + cleanup window, DROP TABLE source_messages_shadow.
--
-- Same schema as source_messages — INCLUDING ALL pulls indexes, constraints,
-- defaults. RLS off because only the service role writes/reads it.

CREATE TABLE IF NOT EXISTS source_messages_shadow (LIKE source_messages INCLUDING ALL);

ALTER TABLE source_messages_shadow DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE source_messages_shadow IS
  'Shadow table for WhatsApp Edge Function port verification. '
  'Temporary — drop after Express webhook is retired.';
