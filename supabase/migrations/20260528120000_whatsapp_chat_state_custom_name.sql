-- User-defined display name per WhatsApp chat. Overrides the contact's
-- WhatsApp profile name (whatsapp_messages.from_name) anywhere we surface
-- the contact: thread list, chat header, and the `sender` field on
-- source_messages — which feeds the smrtTask classifier and any task
-- recommendation that references the person you were talking to.
--
-- Stored on the same (user_id, chat_id) row that already tracks per-chat
-- read state; one row covers both pieces of per-chat user state.
ALTER TABLE whatsapp_chat_state
  ADD COLUMN IF NOT EXISTS custom_name text;
