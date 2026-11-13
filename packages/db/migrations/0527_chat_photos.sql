-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CHAT PHOTOS for INTEGRATION-SHOTVIVA (Owner 2026-11-13: "上线前要支持" a photo plus a template in the conversation; then "用户上传的
-- 照片在聊天记录里面，应该要做到常驻长期保存呀" and "同意，用 Supabase", which replaced the 24-hour B). Number 0527 assigned by the
-- controller.
--   * Bucket chat-photos: private (no public URL), written and read only by the service role. There is no storage.objects policy
--     for anon/authenticated, so a client can neither upload, read, list nor delete. Object names are
--     <profile id>/<session id>.<turn id>.<n>.<random uuid>.jpg: the photos of one message, shown with it when the conversation is
--     read again. JPEG only (the chat composer makes every image a JPEG), 1 MB cap (the composer's limit is a 614,400-byte JPEG).
--     The owner sees them through a signed-in Graylum route; Shotviva reads one through a Graylum route with a few-minutes signed
--     Storage token. No time limit and no count limit (Owner). Deleted with their conversation and with the account (erasure).
--   * chat_photos_orphaned(limit): photos whose conversation is deleted (content_deleted_at / erased_at) or gone, oldest first, for
--     the 5-minute cron to delete through the Storage API (deleting the rows here would leave the files). The backstop of the
--     deletion that runs when the conversation is deleted. A photo younger than 10 minutes is never named (its turn may be opening).
--     Service role only.
-- Compatibility: additive. Old code never opens the bucket or calls the function.
-- Repeatable: the bucket row is upserted to these settings; CREATE OR REPLACE; the grants are idempotent.
-- Recovery: DROP FUNCTION public.chat_photos_orphaned(integer). The photos are user data kept with their conversations: do not
--   delete them to withdraw; the bucket can stay unused.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('chat-photos', 'chat-photos', false, 1048576, ARRAY['image/jpeg'])
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.chat_photos_orphaned(p_limit integer)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT o.name FROM storage.objects o
 WHERE o.bucket_id = 'chat-photos' AND o.created_at < now() - interval '10 minutes'
   AND NOT EXISTS (SELECT 1 FROM runtime_sessions s
     WHERE s.id::text = split_part(split_part(o.name, '/', 2), '.', 1) AND s.actor_id::text = split_part(o.name, '/', 1)
       AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
 ORDER BY o.created_at, o.name
 LIMIT least(greatest(coalesce(p_limit, 0), 0), 1000);
$function$;
REVOKE ALL ON FUNCTION public.chat_photos_orphaned(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_photos_orphaned(integer) TO service_role;

COMMIT;
