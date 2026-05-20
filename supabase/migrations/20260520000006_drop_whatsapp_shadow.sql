-- WhatsApp moved directly to the Vercel Route Handler at
-- src/app/api/webhooks/whatsapp/route.ts. The shadow-run plan that
-- created source_messages_shadow in 20260520000005 is no longer needed.
--
-- Drop the table. The earlier migration file is kept as history.

DROP TABLE IF EXISTS source_messages_shadow;
