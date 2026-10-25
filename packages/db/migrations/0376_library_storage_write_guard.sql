/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- ARCH-FIX B1 (number 0376 assigned by the controller). A library upload is a signed URL the browser
-- writes straight into Storage, and nothing checked the account at the moment of the write: the 10-25 erasure drill
-- wrote to four unfinished upload URLs after closing the account and every write returned 200, leaving the objects for
-- the orphan sweep. Storage records every object as a row in storage.objects, including signed uploads, so the check now
-- runs there, before the row is written, for the library-documents bucket only.
-- A new object (or a rename/move into the bucket) is accepted only when its path is a path library_upload_begin or
-- a text begin reserved, that reservation is not marked for cleanup, its document is still uploading or processing,
-- the path's guard window is open, and the account is open (same facts as library_actor: active, not deleted,
-- no erasure request). Anything else raises 42501, which Storage reports to the uploader as access denied.
-- The profile row is read FOR KEY SHARE: account_erasure_confirm holds it FOR UPDATE while it closes the account, so a
-- write that races the confirmation either commits first (and erasure cleanup removes it as before) or waits and then
-- sees the closed account. Ordinary profile updates (credits, settings) do not conflict with KEY SHARE.
-- Deletes and in-place metadata updates are not checked: cleanup and erasure must always be able to remove objects.
-- Repeatable: CREATE OR REPLACE, and the trigger is created only when missing.
-- Rollback (as the table owner): DROP TRIGGER library_storage_write_guard ON storage.objects; DROP FUNCTION
-- public.library_storage_guard_present(), public.library_storage_write_guard(); no data changes.
BEGIN;
CREATE OR REPLACE FUNCTION public.library_storage_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r library_upload_reservations; p profiles; open boolean;
BEGIN
 IF NEW.bucket_id IS DISTINCT FROM 'library-documents' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.bucket_id IS NOT DISTINCT FROM OLD.bucket_id AND NEW.name IS NOT DISTINCT FROM OLD.name
  THEN RETURN NEW; END IF;
 SELECT * INTO r FROM library_upload_reservations WHERE original_path=NEW.name OR text_path=NEW.name;
 IF r.document_id IS NOT NULL THEN
  SELECT * INTO p FROM profiles WHERE id=r.actor_id FOR KEY SHARE;
  -- Separate statements: after waiting for an erasure confirmation, the erasure request below is visible.
  open:=p.id IS NOT NULL AND p.status IS NOT DISTINCT FROM 'active' AND p.is_deleted::text IS NOT DISTINCT FROM 'false'
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=r.actor_id)
   AND EXISTS(SELECT 1 FROM library_documents d WHERE d.id=r.document_id AND d.deleted_at IS NULL
    AND d.status IN ('uploading','processing'))
   AND EXISTS(SELECT 1 FROM library_upload_reservations x WHERE x.document_id=r.document_id AND NOT x.cleanup
    AND ((x.original_path=NEW.name AND clock_timestamp()<x.original_guard_until)
     OR (x.text_path=NEW.name AND clock_timestamp()<x.text_guard_until)));
  IF open THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'LIBRARY_UPLOAD_CLOSED' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION public.library_storage_write_guard() FROM PUBLIC,anon,authenticated,service_role;
-- storage.objects belongs to supabase_storage_admin: the migration role may create a trigger on it (TRIGGER privilege,
-- checked on staging 10-25) but not drop one, so the trigger is created only when missing.
DO $t$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='storage.objects'::regclass
  AND tgname='library_storage_write_guard') THEN
  CREATE TRIGGER library_storage_write_guard BEFORE INSERT OR UPDATE OF bucket_id,name ON storage.objects
   FOR EACH ROW EXECUTE FUNCTION public.library_storage_write_guard();
 END IF;
END $t$;
-- Supabase owns storage.objects; a platform change that rebuilt the table would silently drop the trigger. The
-- 5-minute library cleanup asks this every run and records an error run (and a log line) when it is missing.
CREATE OR REPLACE FUNCTION public.library_storage_guard_present() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='storage.objects'::regclass
  AND tgname='library_storage_write_guard' AND tgenabled<>'D'
  AND tgfoid='public.library_storage_write_guard()'::regprocedure);
$$;
REVOKE ALL ON FUNCTION public.library_storage_guard_present() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.library_storage_guard_present() TO service_role;
COMMIT;
