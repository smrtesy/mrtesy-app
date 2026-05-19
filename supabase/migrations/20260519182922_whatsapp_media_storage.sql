-- Document storage for WhatsApp media + columns to point to it.
--
-- The WhatsApp webhook receives only a Meta media_id; to actually keep the
-- file (PDFs, spreadsheets, etc.) we have to do a two-step fetch against
-- Meta's Graph API and store the bytes ourselves. The previous Apps Script
-- pushed documents into Google Drive; here we use Supabase Storage so the
-- backend doesn't depend on the user's Google OAuth.

-- ============================================================
-- whatsapp_messages: extra columns for stored media
-- ============================================================

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_url      text,   -- signed URL or storage path
  ADD COLUMN IF NOT EXISTS media_filename text,
  ADD COLUMN IF NOT EXISTS media_size     bigint;

COMMENT ON COLUMN whatsapp_messages.media_url IS
  'Supabase Storage path (bucket=whatsapp-media) for documents we persisted, or null if we kept only metadata (audio/image/video — those are transcribed/OCRed/placeholdered).';

-- ============================================================
-- Storage bucket: whatsapp-media
-- ============================================================
-- Private bucket — the backend uses the service-role key to upload, and
-- the frontend fetches via signed URLs minted from our API. We never
-- expose direct anon access to user files.

INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-media', 'whatsapp-media', false)
ON CONFLICT (id) DO NOTHING;

-- Row-level security: only the owning user can read their own objects.
-- Path convention: <user_id>/<wamid>-<filename>.
-- (Service-role writes bypass RLS — that's how the webhook uploads.)

DROP POLICY IF EXISTS "whatsapp_media_owner_read" ON storage.objects;
CREATE POLICY "whatsapp_media_owner_read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'whatsapp-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "whatsapp_media_owner_delete" ON storage.objects;
CREATE POLICY "whatsapp_media_owner_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'whatsapp-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
