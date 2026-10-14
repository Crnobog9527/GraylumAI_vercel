-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: off-database minimal erasure manifest (Owner approved 2026-10-12).
-- After an older backup is restored, every account erasure and single-item deletion confirmed
-- after that snapshot must be replayed before service reopens. The durable list lives in Redis;
-- this table is only the "pending sync" record, written in the same transaction as the deletion.
-- It holds IDs and the confirmation time only: never body, title, filename, email or content hash.
-- Runbook: docs/runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md
BEGIN;
SET LOCAL lock_timeout = '5s';

-- No foreign keys: a pending row must never block or be removed by the deletion it records.
CREATE TABLE IF NOT EXISTS public.erasure_manifest_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('account','answer','session','artifact','content','library_document')),
 target_id uuid NOT NULL,
 profile_id uuid NOT NULL,
 confirmed_at timestamptz NOT NULL,
 synced_at timestamptz,
 UNIQUE(kind,target_id)
);
CREATE INDEX IF NOT EXISTS erasure_manifest_outbox_unsynced
 ON public.erasure_manifest_outbox(confirmed_at,id) WHERE synced_at IS NULL;
CREATE INDEX IF NOT EXISTS erasure_manifest_outbox_confirmed ON public.erasure_manifest_outbox(confirmed_at);
ALTER TABLE public.erasure_manifest_outbox ENABLE ROW LEVEL SECURITY;
-- No client or service_role table access: only the service functions below read or write it.
REVOKE ALL ON public.erasure_manifest_outbox FROM PUBLIC,anon,authenticated,service_role;

-- Never raises: a manifest problem must not undo or block the user's deletion. A failure is
-- reported as a WARNING without IDs. Repeated confirmation keeps the first confirmation time.
CREATE OR REPLACE FUNCTION public.erasure_manifest_note(k text,target uuid,profile uuid,at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF k IS NULL OR target IS NULL OR profile IS NULL OR at IS NULL
  OR k NOT IN ('account','answer','session','artifact','content','library_document') THEN RETURN; END IF;
 INSERT INTO erasure_manifest_outbox(kind,target_id,profile_id,confirmed_at) VALUES(k,target,profile,at)
 ON CONFLICT(kind,target_id) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
 RAISE WARNING 'ERASURE_MANIFEST_NOTE_FAILED';
END $$;

-- Account erasure: the durable tombstone is the account_erasure_requests row itself.
CREATE OR REPLACE FUNCTION public.erasure_manifest_account_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM erasure_manifest_note('account',NEW.profile_id,NEW.profile_id,NEW.confirmed_at);
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 RAISE WARNING 'ERASURE_MANIFEST_NOTE_FAILED';
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS erasure_manifest_account ON public.account_erasure_requests;
CREATE TRIGGER erasure_manifest_account AFTER INSERT ON public.account_erasure_requests
 FOR EACH ROW EXECUTE FUNCTION public.erasure_manifest_account_trigger();

-- Library deletion: library_delete (0203, not redefined later) sets deleted_at once, NULL -> NOT NULL.
-- Account-closure cleanup calls the same function with closed=true; library_actor only lets
-- that path run after account_erasure_requests exists, so those rows are covered by 'account'.
-- Unfinished-upload cleanup of an open account is recorded too: it is a real deletion and
-- replaying library_delete for it is harmless.
CREATE OR REPLACE FUNCTION public.erasure_manifest_library_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.actor_id) THEN
  PERFORM erasure_manifest_note('library_document',NEW.id,NEW.actor_id,NEW.deleted_at);
 END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 RAISE WARNING 'ERASURE_MANIFEST_NOTE_FAILED';
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS erasure_manifest_library ON public.library_documents;
CREATE TRIGGER erasure_manifest_library AFTER UPDATE OF deleted_at ON public.library_documents
 FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
 EXECUTE FUNCTION public.erasure_manifest_library_trigger();

-- Single deletion: content_erasure_confirm (0201, patched by 0209) marks a whole dependency
-- closure in one call (dependent answers, whole-session executions, strategy-draft projects,
-- every version of a content family). No row-level marker identifies the target the user chose,
-- and opc_content_versions.erased_at is shared with account scrub. So the one exact place is the
-- confirm call itself: one statement after its preview check records (kind, target) with the same
-- stamp as content_deleted_at. Any later failure rolls the row back with the deletion.
DO $$
DECLARE source text; marker text:='-- 0227 erasure manifest';
 needle text:=E' deleted:=(scope->>''alreadyDeleted'')::boolean;\n';
BEGIN
 source:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
 IF position(marker IN source)=0 THEN
  IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
   RAISE EXCEPTION 'ERASURE_MANIFEST_SOURCE_MISMATCH';
  END IF;
  source:=replace(source,needle,needle||' '||marker||E'\n PERFORM erasure_manifest_note(k,target,a,stamp);\n');
  EXECUTE source;
 END IF;
END $$;

-- Service-only sync API. Bounded batches; rows older than 35 days are no longer needed.
CREATE OR REPLACE FUNCTION public.erasure_manifest_pending(n integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'targetId',target_id,'profileId',profile_id,
  'confirmedAt',confirmed_at) ORDER BY confirmed_at,id),'[]'::jsonb)
 FROM (SELECT * FROM erasure_manifest_outbox WHERE synced_at IS NULL
  AND confirmed_at>clock_timestamp()-interval '35 days'
  ORDER BY confirmed_at,id LIMIT least(greatest(coalesce(n,100),1),500)) x
$$;
CREATE OR REPLACE FUNCTION public.erasure_manifest_mark_synced(ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE changed integer;
BEGIN
 IF ids IS NULL OR cardinality(ids)=0 THEN RETURN 0; END IF;
 IF cardinality(ids)>500 THEN RAISE EXCEPTION 'ERASURE_MANIFEST_BATCH_TOO_LARGE' USING ERRCODE='22023'; END IF;
 UPDATE erasure_manifest_outbox SET synced_at=clock_timestamp() WHERE id=ANY(ids) AND synced_at IS NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed;
END $$;
-- Synced or not: after 35 days no supported backup can still predate the confirmation.
CREATE OR REPLACE FUNCTION public.erasure_manifest_cleanup()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE removed integer;
BEGIN
 DELETE FROM erasure_manifest_outbox WHERE confirmed_at<clock_timestamp()-interval '35 days';
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;

REVOKE ALL ON FUNCTION public.erasure_manifest_note(text,uuid,uuid,timestamptz),
 public.erasure_manifest_account_trigger(),public.erasure_manifest_library_trigger(),
 public.erasure_manifest_pending(integer),public.erasure_manifest_mark_synced(uuid[]),
 public.erasure_manifest_cleanup()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.erasure_manifest_pending(integer),public.erasure_manifest_mark_synced(uuid[]),
 public.erasure_manifest_cleanup() TO service_role;
COMMIT;
