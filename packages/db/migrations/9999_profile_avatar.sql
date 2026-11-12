-- PROFILE-AVATAR (Owner 2026-11-12: users set their own avatar, before launch).
--
-- 1. A public-read bucket for avatars. An avatar is shown on every signed-in page (profile header, rail account button,
--    account popover), so a stable public URL is stored in profiles.avatar_url and no signed URL has to be refreshed.
--    Only the service role writes: there is no storage.objects policy for anon/authenticated, so a client can neither
--    upload, overwrite, delete nor list. Object names are <profile_id>/<random uuid>.<ext>, never guessable. 2 MB cap and
--    JPEG/PNG/WebP only, enforced by Storage as well as by the upload route.
-- 2. profiles.avatar_url becomes writable by the service role (the upload route). Users still cannot write it directly:
--    authenticated keeps UPDATE (nickname) only (0144), so no arbitrary URL can be set from the client.
-- Re-runnable: the bucket row is upserted to these settings, the grant is idempotent.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('profile-avatars', 'profile-avatars', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;

GRANT UPDATE (avatar_url) ON TABLE public.profiles TO service_role;
