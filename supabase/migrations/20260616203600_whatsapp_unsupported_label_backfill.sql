-- Re-label historical WhatsApp `unsupported` messages that were stored as
-- "[הודעה נמחקה]" (message deleted).
--
-- Background: the webhook used to lump `type: "unsupported"` together with
-- `type: "revoke"` and label both as deleted. But `unsupported` is NOT a
-- deletion — Meta could not surface the message to the Cloud API:
--   * error 131060 → Coexistence/companion-device sync gap; the message
--     exists on the user's phone but never reached the API.
--   * error 131051 → a message type the Cloud API doesn't support
--     (view_once, poll, list, group_invite, …); `unsupported.type` names it.
-- The webhook now writes honest labels for new messages; this backfills the
-- existing rows so past conversations stop showing a misleading "deleted".
--
-- Only touches rows still carrying the old "[הודעה נמחקה]" placeholder, so it
-- is safe to re-run and never clobbers a genuine `revoke` deletion.

UPDATE whatsapp_messages
SET body_text = CASE
  WHEN (raw_payload->'errors'->0->>'code') = '131060'
    THEN '[הודעה לא זמינה — WhatsApp לא העביר אותה לאפליקציה (מכשיר מקושר). בדוק בטלפון]'
  WHEN COALESCE(raw_payload->'unsupported'->>'type', 'unknown') <> 'unknown'
    THEN '[הודעה לא נתמכת: ' || (raw_payload->'unsupported'->>'type') || ' — בדוק בטלפון]'
  ELSE '[הודעה לא נתמכת — לא ניתן להציג כאן. בדוק בטלפון]'
END
WHERE message_type = 'unsupported'
  AND body_text = '[הודעה נמחקה]';
