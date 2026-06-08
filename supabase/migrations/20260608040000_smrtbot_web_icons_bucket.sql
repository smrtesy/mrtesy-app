-- ============================================================
-- smrtBot — web-chat icon storage bucket
-- ============================================================
-- Public bucket for the web widget logo/icon (the floating launcher + header
-- avatar). Public so the icon loads cross-origin on any customer site; writes
-- are restricted to org members under their own "{org_id}/..." prefix.
--
-- If bucket creation via SQL fails (permissions), create it manually:
--   Storage → New bucket → name: smrtbot-web-icons → Public: YES
--   → File size limit: 2 MB → MIME: image/png,image/jpeg,image/webp,image/svg+xml

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'smrtbot-web-icons',
  'smrtbot-web-icons',
  true,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;

-- Public read: the bucket is public, but objects still need a SELECT policy for
-- the public URL to resolve.
DROP POLICY IF EXISTS "smrtbot_web_icons_public_read" ON storage.objects;
CREATE POLICY "smrtbot_web_icons_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'smrtbot-web-icons');

-- Writes (insert/update/delete): org members, scoped to their org prefix
-- "{org_id}/...".
DROP POLICY IF EXISTS "smrtbot_web_icons_write_org_members" ON storage.objects;
CREATE POLICY "smrtbot_web_icons_write_org_members"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'smrtbot-web-icons'
  AND (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM org_members WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "smrtbot_web_icons_update_org_members" ON storage.objects;
CREATE POLICY "smrtbot_web_icons_update_org_members"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'smrtbot-web-icons'
  AND (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM org_members WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "smrtbot_web_icons_delete_org_members" ON storage.objects;
CREATE POLICY "smrtbot_web_icons_delete_org_members"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'smrtbot-web-icons'
  AND (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM org_members WHERE user_id = auth.uid()
  )
);
