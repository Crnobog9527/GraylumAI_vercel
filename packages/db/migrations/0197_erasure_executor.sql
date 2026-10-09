-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Reuse the subject and erasure request as authority; no queue or expiring lease.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS erasure_history_complete boolean NOT NULL DEFAULT false;
ALTER TABLE public.account_erasure_requests
 ADD COLUMN IF NOT EXISTS storage_manifest_cursor text,
 ADD COLUMN IF NOT EXISTS storage_manifest_done boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS executor_token uuid,
 ADD COLUMN IF NOT EXISTS executor_started_at timestamptz,
 ADD COLUMN IF NOT EXISTS executor_attempted_at timestamptz,
 ADD COLUMN IF NOT EXISTS executor_error_codes text[] NOT NULL DEFAULT '{}';

-- Only insertion after this guard establishes known history. Existing subjects stay unknown.
-- Losing any attachment reference invalidates that proof, including ordinary pre-closure purge.
CREATE OR REPLACE FUNCTION public.erasure_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.erasure_history_complete:=true;
 ELSIF NEW.erasure_history_complete AND NOT OLD.erasure_history_complete THEN
  RAISE EXCEPTION 'ERASURE_HISTORY_CANNOT_BE_ASSERTED' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS erasure_history_guard ON public.profiles;
CREATE TRIGGER erasure_history_guard BEFORE INSERT OR UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.erasure_history_guard();
CREATE OR REPLACE FUNCTION public.erasure_history_lost() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject uuid;
BEGIN
 IF OLD.attachments IS NULL OR OLD.attachments='[]'::jsonb THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.attachments IS NOT DISTINCT FROM OLD.attachments THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='tickets' THEN subject:=OLD.user_id;
 ELSE SELECT user_id INTO subject FROM tickets WHERE id=OLD.ticket_id; END IF;
 -- A verified erasure removes references only after checking the external objects.
 UPDATE profiles SET erasure_history_complete=false WHERE (id IN (subject,OLD.user_id) OR id::text IN
   (SELECT split_part(path,'/',1) FROM jsonb_array_elements_text(OLD.attachments) path))
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=subject
   AND e.storage_verified_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=profiles.id
   AND e.storage_verified_at IS NOT NULL);
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS erasure_history_lost ON public.tickets;
CREATE TRIGGER erasure_history_lost BEFORE DELETE OR UPDATE OF attachments ON public.tickets
 FOR EACH ROW EXECUTE FUNCTION public.erasure_history_lost();
DROP TRIGGER IF EXISTS erasure_history_lost ON public.ticket_replies;
CREATE TRIGGER erasure_history_lost BEFORE DELETE OR UPDATE OF attachments ON public.ticket_replies
 FOR EACH ROW EXECUTE FUNCTION public.erasure_history_lost();

-- Stamp the existing proof before reference deletion, in the same transaction.
DO $$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 needle:='  DELETE FROM ticket_replies WHERE ctid IN';
 IF position('-- executor storage proof' IN source)=0 THEN
  IF length(source)-length(replace(source,needle,''))<>length(needle) THEN RAISE EXCEPTION 'ERASURE_EXECUTOR_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(source,needle,E'  -- executor storage proof\n  UPDATE account_erasure_requests SET storage_verified_at=clock_timestamp() WHERE profile_id=p_profile_id;\n'||needle);
 END IF;
END $$;

-- Blank only body fields while preserving attachment authority until absence proof.
DO $$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.account_erasure_ticket_guard()'::regprocedure);
 needle:=' -- The service-only retention function';
 IF position('-- executor body scrub' IN source)=0 THEN
  IF position(needle IN source)=0 THEN RAISE EXCEPTION 'ERASURE_GUARD_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(source,needle,$patch$ -- executor body scrub
 IF TG_OP='UPDATE' AND (EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=subject)
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=OLD.user_id)) THEN
  IF TG_TABLE_NAME='tickets' THEN
   IF NEW.title='' AND NEW.description='' AND to_jsonb(NEW)-ARRAY['title','description']=to_jsonb(OLD)-ARRAY['title','description'] THEN RETURN NEW; END IF;
  ELSE
   IF NEW.content='' AND to_jsonb(NEW)-'content'=to_jsonb(OLD)-'content' THEN RETURN NEW; END IF;
  END IF;
 END IF;
$patch$||needle);
 END IF;
 source:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 needle:=' IF p_storage_verified AND NOT EXISTS';
 IF position('-- executor body scrub' IN source)=0 THEN
  IF position(needle IN source)=0 THEN RAISE EXCEPTION 'ERASURE_CLEANUP_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(source,needle,$patch$ -- executor body scrub
 UPDATE tickets SET title='',description='' WHERE ctid IN (SELECT ctid FROM tickets
  WHERE user_id=p_profile_id AND (title<>'' OR description<>'') LIMIT 100 FOR UPDATE SKIP LOCKED);
 UPDATE ticket_replies SET content='' WHERE ctid IN (SELECT r.ctid FROM ticket_replies r
  WHERE content<>'' AND (r.user_id=p_profile_id OR EXISTS(SELECT 1 FROM tickets t WHERE t.id=r.ticket_id AND t.user_id=p_profile_id))
  LIMIT 100 FOR UPDATE OF r SKIP LOCKED);
$patch$||needle);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_executor_claim(p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.account_erasure_requests;
BEGIN
 IF p_token IS NULL THEN RAISE EXCEPTION 'ERASURE_EXECUTOR_INVALID'; END IF;
 SELECT * INTO r FROM account_erasure_requests WHERE stage<>'completed' AND executor_token IS NULL
  AND (executor_attempted_at IS NULL OR executor_attempted_at<clock_timestamp()-interval '5 minutes')
  ORDER BY executor_attempted_at NULLS FIRST,confirmed_at,profile_id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF r.profile_id IS NULL THEN RETURN jsonb_build_object('claimed',false); END IF;
 PERFORM account_erasure_assert_closed(r.profile_id);
 UPDATE account_erasure_requests SET executor_token=p_token,executor_started_at=clock_timestamp(),
  executor_attempted_at=clock_timestamp(),executor_error_codes=ARRAY['ERASURE_EXECUTOR_RUNNING'] WHERE profile_id=r.profile_id;
 RETURN jsonb_build_object('claimed',true,'profileId',r.profile_id,'requestId',r.request_id);
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_executor_proof(p_profile_id uuid,p_request_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_profile_id
  AND request_id=p_request_id AND executor_token=p_token AND p_token IS NOT NULL) THEN
  RAISE EXCEPTION 'ERASURE_EXECUTOR_NOT_CLAIMED' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('historyComplete',(SELECT erasure_history_complete FROM profiles WHERE id=p_profile_id),
  'quiescent',(account_erasure_storage_ready(p_profile_id)->>'ready')::boolean
   AND NOT EXISTS(SELECT 1 FROM ticket_upload_intents i WHERE i.profile_id::text IN (
    SELECT split_part(path,'/',1) FROM tickets t CROSS JOIN LATERAL
     jsonb_array_elements_text(coalesce(t.attachments,'[]'::jsonb)) path WHERE t.user_id=p_profile_id
    UNION SELECT split_part(path,'/',1) FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
     CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.attachments,'[]'::jsonb)) path WHERE t.user_id=p_profile_id)));
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_executor_finish(
 p_profile_id uuid,p_request_id uuid,p_token uuid,p_codes text[],p_release boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_codes IS NULL OR cardinality(p_codes)>20 OR p_release IS NULL
  OR EXISTS(SELECT 1 FROM unnest(p_codes) c WHERE c IS NULL OR c!~'^[A-Z0-9_]{1,64}$') THEN
  RAISE EXCEPTION 'ERASURE_EXECUTOR_INVALID';
 END IF;
 UPDATE account_erasure_requests SET executor_error_codes=p_codes,
  executor_token=CASE WHEN p_release THEN NULL ELSE executor_token END,
  executor_started_at=CASE WHEN p_release THEN NULL ELSE executor_started_at END
 WHERE profile_id=p_profile_id AND request_id=p_request_id AND executor_token=p_token AND p_token IS NOT NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('recorded',n=1);
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_executor_pending()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT to_jsonb(count(*)) FROM account_erasure_requests WHERE stage<>'completed';
$$;
-- Bounded subject inventory and indexed candidate-path checks avoid a global row cap.
CREATE INDEX IF NOT EXISTS erasure_ticket_paths ON public.tickets USING gin(attachments);
CREATE INDEX IF NOT EXISTS erasure_reply_paths ON public.ticket_replies USING gin(attachments);
CREATE OR REPLACE FUNCTION public.account_erasure_attachment_page(
 p_profile_id uuid,p_after text DEFAULT NULL,p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE items jsonb; next_cursor text;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 -- Cursor contains only source row identity and array ordinal, never a filename or body.
 WITH refs AS (
  SELECT path,CASE WHEN split_part(path,'/',1)=t.user_id::text THEN t.user_id::text ELSE '' END uploader,
   '0:'||t.id::text||':'||lpad(ord::text,10,'0') cursor
   FROM tickets t CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(t.attachments,'[]')) WITH ORDINALITY a(path,ord)
   WHERE t.user_id=p_profile_id
  UNION ALL
  SELECT path,CASE WHEN split_part(path,'/',1) IN (t.user_id::text,r.user_id::text) THEN split_part(path,'/',1) ELSE '' END,
   '1:'||r.id::text||':'||lpad(ord::text,10,'0')
   FROM tickets t JOIN ticket_replies r ON r.ticket_id=t.id
   CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.attachments,'[]')) WITH ORDINALITY a(path,ord)
   WHERE t.user_id=p_profile_id
 ), page AS (SELECT * FROM refs WHERE p_after IS NULL OR cursor COLLATE "C">p_after COLLATE "C"
  ORDER BY cursor COLLATE "C" LIMIT p_limit+1)
 SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'uploaderId',uploader,'subjectId',p_profile_id)
  ORDER BY cursor COLLATE "C"),'[]'),CASE WHEN count(*)>p_limit THEN
   (array_agg(cursor ORDER BY cursor COLLATE "C"))[p_limit] ELSE NULL END INTO items,next_cursor FROM page;
 RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(items)>p_limit THEN items-p_limit ELSE items END,
  'nextCursor',next_cursor);
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_attachment_checkpoint(
 p_profile_id uuid,p_request_id uuid,p_token uuid,p_after text DEFAULT NULL,p_next text DEFAULT NULL,p_commit boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.account_erasure_requests;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 SELECT * INTO r FROM account_erasure_requests WHERE profile_id=p_profile_id FOR UPDATE;
 IF p_token IS NULL OR r.executor_token IS DISTINCT FROM p_token OR r.request_id IS DISTINCT FROM p_request_id THEN
  RAISE EXCEPTION 'ERASURE_EXECUTOR_NOT_CLAIMED' USING ERRCODE='42501';
 END IF;
 IF p_commit IS NULL THEN RAISE EXCEPTION 'ERASURE_CHECKPOINT_INVALID'; END IF;
 IF p_commit THEN
  IF r.storage_manifest_done OR r.storage_manifest_cursor IS DISTINCT FROM p_after
   OR p_next IS NOT NULL AND (p_next!~'^[01]:[0-9a-f-]{36}:[0-9]{10}$'
    OR p_after IS NOT NULL AND p_next COLLATE "C"<=p_after COLLATE "C") THEN
   RAISE EXCEPTION 'ERASURE_CHECKPOINT_INVALID';
  END IF;
  UPDATE account_erasure_requests SET storage_manifest_cursor=p_next,storage_manifest_done=p_next IS NULL
   WHERE profile_id=p_profile_id RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('cursor',r.storage_manifest_cursor,'done',r.storage_manifest_done);
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_attachment_classify(p_profile_id uuid,p_paths text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_paths IS NULL OR cardinality(p_paths)>100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'state',CASE
  WHEN EXISTS(SELECT 1 FROM tickets WHERE attachments ? path AND user_id IS DISTINCT FROM p_profile_id)
   OR EXISTS(SELECT 1 FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
    WHERE r.attachments ? path AND t.user_id IS DISTINCT FROM p_profile_id) THEN 'shared'
  WHEN EXISTS(SELECT 1 FROM tickets WHERE attachments ? path AND user_id=p_profile_id)
   OR EXISTS(SELECT 1 FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
    WHERE r.attachments ? path AND t.user_id=p_profile_id) THEN 'exclusive'
  WHEN split_part(path,'/',1)=p_profile_id::text THEN 'unreferenced' ELSE 'unknown' END)),'[]')
 INTO result FROM unnest(p_paths) path;
 RETURN result;
END $$;
DO $$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['erasure_history_guard()','erasure_history_lost()',
  'account_erasure_executor_claim(uuid)','account_erasure_executor_proof(uuid,uuid,uuid)',
  'account_erasure_executor_pending()',
  'account_erasure_attachment_page(uuid,text,integer)','account_erasure_attachment_classify(uuid,text[])',
  'account_erasure_attachment_checkpoint(uuid,uuid,uuid,text,text,boolean)',
  'account_erasure_executor_finish(uuid,uuid,uuid,text[],boolean)'] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC,anon,authenticated,service_role';
  IF signature LIKE 'account_erasure_executor_%' OR signature LIKE 'account_erasure_attachment_%' THEN
   EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO service_role';
  END IF;
 END LOOP;
END $$;
COMMIT;
