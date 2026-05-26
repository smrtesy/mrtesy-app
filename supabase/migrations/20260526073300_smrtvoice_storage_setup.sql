-- ============================================================
-- smrtVoice — Storage Bucket Setup
-- ============================================================
-- Creates the private bucket and RLS policy.
-- If bucket creation via SQL fails (permissions), create it manually
-- via Supabase Dashboard:
--   1. Storage → New bucket
--   2. Name: smrtvoice-audio
--   3. Public: NO
--   4. File size limit: 500 MB
--   5. Allowed MIME types: audio/wav, audio/mpeg, audio/mp4, audio/x-wav

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'smrtvoice-audio',
  'smrtvoice-audio',
  false,
  524288000,
  ARRAY['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/x-wav']
)
ON CONFLICT (id) DO NOTHING;

-- Read access: org members can SELECT objects in their org's prefix.
-- Path structure: {org_id}/...
DROP POLICY IF EXISTS "smrtvoice_audio_read_org_members" ON storage.objects;
CREATE POLICY "smrtvoice_audio_read_org_members"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'smrtvoice-audio'
  AND (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM org_members
    WHERE user_id = auth.uid()
  )
);

-- Writes happen exclusively via service role (Voice Engine + smrtesy backend).
-- No public write policy by design.
