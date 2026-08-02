-- ============================================================
-- smrtDesign — Storage Bucket Setup
-- ============================================================
-- Private bucket for rendered design-option screenshots (PNG/JPEG/WebP).
-- Path structure: {org_id}/{project_id}/{option_id}.png
-- Writes happen exclusively via the service-role backend (the generation run
-- posts each render to POST /api/design/projects/:id/options, which uploads
-- here). Reads are org-scoped; the frontend gets short-lived signed URLs.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'smrtdesign-renders',
  'smrtdesign-renders',
  false,
  10485760, -- 10 MB per render
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Read access: org members can SELECT objects under their org's prefix.
DROP POLICY IF EXISTS "smrtdesign_renders_read_org_members" ON storage.objects;
CREATE POLICY "smrtdesign_renders_read_org_members"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'smrtdesign-renders'
  AND (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM org_members
    WHERE user_id = auth.uid()
  )
);
-- No public write policy by design — service role only.
