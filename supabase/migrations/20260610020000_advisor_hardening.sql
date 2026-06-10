-- Advisor hardening — two safe, behavior-preserving fixes flagged by the
-- Supabase security advisors. Neither changes any working code path.
-- Idempotent; safe to re-run.

-- ── 1. accept_my_invites(): drop the implicit PUBLIC/anon EXECUTE grant ──────
-- The function is SECURITY DEFINER and self-scopes via auth.uid() — for an
-- anonymous caller it reads no email and returns immediately (a no-op), so the
-- anon exposure is harmless, but a SECURITY DEFINER function should not be
-- anon-callable on principle (advisor 0028). The only real caller is the
-- post-sign-in auth/callback, which runs as `authenticated`; that grant is
-- retained, so nothing breaks.
REVOKE ALL ON FUNCTION accept_my_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_my_invites() TO authenticated;

-- ── 2. smrtbot-web-icons: scope the SELECT policy to the owning org ──────────
-- The bucket is PUBLIC, so the floating-widget icon is served via its public
-- object URL (getPublicUrl → /object/public/...) which bypasses RLS entirely —
-- the broad SELECT policy below was never needed for serving (confirmed in the
-- Supabase storage docs). Its only effect was to let ANY authenticated client
-- LIST every file in the bucket across all orgs, leaking org_id prefixes and
-- icon filenames (advisor 0025). Scope it to the caller's own org, matching the
-- existing INSERT/UPDATE/DELETE write policies. Uploads use upsert:false with a
-- unique path, so no upsert SELECT dependency exists; anon widget embeds keep
-- loading the icon via the public URL.
DROP POLICY IF EXISTS "smrtbot_web_icons_public_read" ON storage.objects;
DROP POLICY IF EXISTS "smrtbot_web_icons_org_read"    ON storage.objects;
CREATE POLICY "smrtbot_web_icons_org_read"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'smrtbot-web-icons'
  AND (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM org_members WHERE user_id = auth.uid()
  )
);
