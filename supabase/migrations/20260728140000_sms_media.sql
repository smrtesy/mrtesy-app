-- SMS/MMS media: stored attachments + the transcript/OCR they produce.
--
-- WHY
-- WhatsApp has transcribed voice notes and OCR'd images since May 2026; SMS
-- never did. The SMS side was built by mirroring the WhatsApp thread builder by
-- hand, and the media half of that builder was simply never copied — so an MMS
-- carrying nothing but a photo reached the classifier as an EMPTY body and was
-- dropped ("empty_body": 16 such messages in the first three weeks of the SMS
-- integration alone). The classifier never learned they existed.
--
-- SHAPE — one jsonb array, not five scalar columns
-- whatsapp_messages carries media_url / media_filename / media_size /
-- media_mime as scalars because a WhatsApp message holds at most ONE
-- attachment. An MMS can carry several parts (a photo plus a caption image,
-- three pictures in one send), so scalars would silently keep the first and
-- lose the rest. media_parts is the single source of truth:
--
--   [{ "path": "<user_id>/<message_id>-0.jpg",   -- Supabase Storage key
--      "mime": "image/jpeg",
--      "filename": "IMG_0421.jpg",              -- as the sender named it
--      "size": 184320,                          -- bytes
--      "kind": "image" | "audio" | "video" | "file" }]
--
-- The DERIVED TEXT (Gemini OCR / transcript) is NOT stored here. It goes into
-- sms_messages.body_text, exactly where the WhatsApp webhook puts it, because
-- body_text is what refreshSmsSourceThread folds into the rolling
-- [INCOMING]/[OUTGOING] transcript the classifier reads, and what /api/sms/search
-- searches. A second copy in a media column would be a second source of truth
-- that drifts — whatsapp_messages already carries that scar (media_ocr_text and
-- audio_transcript are legacy columns the reader still has to fall back to).

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS media_parts jsonb;

COMMENT ON COLUMN public.sms_messages.media_parts IS
  'MMS attachments stored in the sms-media bucket: array of {path,mime,filename,size,kind}. NULL for a plain text SMS. The OCR/transcript text derived from them lives in body_text (single source of truth) — see supabase/migrations/20260728140000_sms_media.sql.';

-- Partial index: the reader and any media backfill only ever ask for the rows
-- that HAVE attachments, which is a small minority of an SMS corpus.
CREATE INDEX IF NOT EXISTS sms_messages_media_parts_idx
  ON public.sms_messages (user_id, received_at DESC)
  WHERE media_parts IS NOT NULL;

-- ============================================================
-- Storage bucket: sms-media
-- ============================================================
-- Private, same contract as whatsapp-media (migration 20260519182922): the
-- webhook uploads with the service-role key (bypasses RLS), the frontend only
-- ever receives short-lived signed URLs minted by our own API. A separate
-- bucket rather than reusing whatsapp-media so a per-channel retention or size
-- policy can be set later without touching the other channel's objects.

INSERT INTO storage.buckets (id, name, public)
VALUES ('sms-media', 'sms-media', false)
ON CONFLICT (id) DO NOTHING;

-- Path convention: <user_id>/<message_id>-<index>.<ext>, so foldername()[1] is
-- the owning user and the owner check below is exact.

DROP POLICY IF EXISTS "sms_media_owner_read" ON storage.objects;
CREATE POLICY "sms_media_owner_read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'sms-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "sms_media_owner_delete" ON storage.objects;
CREATE POLICY "sms_media_owner_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'sms-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
