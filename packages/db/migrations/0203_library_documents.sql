-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-2a, default closed; public erasure hooks extend the merged predecessor chain.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS public.library_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('document','image','audio','video')),
 format text CHECK(format IN ('txt','md','docx','pdf','jpeg','png','webp')),
 purpose text CHECK(purpose IN ('authored','reference')), filename text CHECK(octet_length(filename)<=1024),
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','processing','ready','failed','deleting')),
 original_bytes bigint NOT NULL DEFAULT 0 CHECK(original_bytes BETWEEN 0 AND 10000000),
 text_bytes bigint NOT NULL DEFAULT 0 CHECK(text_bytes BETWEEN 0 AND 10000000),
 content_version integer NOT NULL DEFAULT 1 CHECK(content_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
 UNIQUE(actor_id,request_id), UNIQUE(id,actor_id)
);
CREATE TABLE IF NOT EXISTS public.library_document_segments (
 document_id uuid NOT NULL, actor_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0), title text NOT NULL DEFAULT '' CHECK(octet_length(title)<=512),
 body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 8192),
 bytes integer GENERATED ALWAYS AS (octet_length(body)) STORED,
 page_number integer CHECK(page_number BETWEEN 1 AND 500), source text NOT NULL CHECK(source IN ('extracted','recognized')),
 PRIMARY KEY(document_id,ordinal),
 FOREIGN KEY(document_id,actor_id) REFERENCES public.library_documents(id,actor_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.library_upload_reservations (
 document_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 original_hold bigint NOT NULL CHECK(original_hold BETWEEN 0 AND 10000000),
 text_hold bigint NOT NULL DEFAULT 0 CHECK(text_hold BETWEEN 0 AND 10000000),
 segment_hold bigint NOT NULL DEFAULT 0 CHECK(segment_hold BETWEEN 0 AND 10000000),
 original_guard_until timestamptz NOT NULL, text_guard_until timestamptz,
 original_path text NOT NULL UNIQUE, text_path text UNIQUE,
 cleanup boolean NOT NULL DEFAULT false, absent_observed_at timestamptz,
 checked_at timestamptz NOT NULL DEFAULT '-infinity', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(document_id,actor_id) REFERENCES public.library_documents(id,actor_id) ON DELETE RESTRICT,
 CHECK(original_path=actor_id::text||'/'||document_id::text||'/original'),
 CHECK(text_path IS NULL OR text_path=actor_id::text||'/'||document_id::text||'/text')
);
CREATE TABLE IF NOT EXISTS public.library_recognition_units (
 document_id uuid NOT NULL, actor_id uuid NOT NULL,
 unit_kind text NOT NULL CHECK(unit_kind IN ('pdf_page','word_image')),
 position integer NOT NULL CHECK(position BETWEEN 1 AND 500), has_text boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','paused','over_limit','settling')),
 bill2_request_id uuid, PRIMARY KEY(document_id,unit_kind,position),
 FOREIGN KEY(document_id,actor_id) REFERENCES public.library_documents(id,actor_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS library_documents_actor ON public.library_documents(actor_id,id);
CREATE INDEX IF NOT EXISTS library_reservations_actor ON public.library_upload_reservations(actor_id);
CREATE INDEX IF NOT EXISTS library_reservations_cleanup ON public.library_upload_reservations(checked_at,document_id);
ALTER TABLE public.library_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_document_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_upload_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_recognition_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.library_documents,public.library_document_segments,
 public.library_upload_reservations,public.library_recognition_units FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('library-documents','library-documents',false,10000000,ARRAY['text/plain','text/markdown',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf',
 'image/jpeg','image/png','image/webp']) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.system_settings(key,value) VALUES('library_upload_enabled','false') ON CONFLICT(key) DO NOTHING;

-- Every entry point uses the same profile lock as erasure and quota changes. No JWT actor argument is trusted.
CREATE OR REPLACE FUNCTION public.library_actor(a uuid,allow_closed boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p profiles;
BEGIN
 IF current_setting('role',true) IS DISTINCT FROM 'service_role' OR a IS NULL THEN
  RAISE EXCEPTION 'LIBRARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM profiles WHERE id=a FOR UPDATE;
 IF p.id IS NULL OR (NOT allow_closed AND (p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a))) THEN
  RAISE EXCEPTION 'LIBRARY_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
END $$;

-- Same membership facts/projection as membershipEntitlements; no cached or client-supplied quota.
CREATE OR REPLACE FUNCTION public.library_capacity(a uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE level_name text; facts jsonb; sub jsonb; orders jsonb; managed jsonb; part jsonb; cap bigint;
BEGIN
 SELECT membership_level INTO level_name FROM profiles WHERE id=a;
 facts:=pay_common_membership_facts(a); orders:=facts->'latest_order';
 IF orders->>'status' IN ('refunded','partially_refunded','partial_refunded')
  OR orders->>'payment_status' IN ('refunded','partially_refunded','partial_refunded') THEN level_name:='free'; END IF;
 FOR part IN SELECT value FROM jsonb_each(coalesce(orders->'metadata','{}'))
  WHERE key IN ('stripeRefundReconciliation','subscriptionCreditGrantReversal','refundReconciliation','refund') LOOP
  IF part->>'isFullRefund'='true' OR part->>'fullRefund'='true' OR part->>'reviewRequired'='true'
   OR part->>'refundType'='full' THEN level_name:='free'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(facts->'subscriptions') s
  WHERE coalesce(s->>'mapping_state','') NOT IN ('none','mapped')) THEN level_name:='free'; END IF;
 SELECT coalesce(jsonb_agg(s),'[]') INTO managed FROM jsonb_array_elements(facts->'subscriptions') s
  WHERE s->>'mapping_state'='mapped' AND s->>'payment_channel'='stripe'
  AND lower(s->>'status') IN ('active','trialing','past_due','incomplete','unpaid');
 IF jsonb_array_length(managed)>1 THEN level_name:='free'; END IF;
 sub:=coalesce(managed->0,facts->'subscriptions'->0);
 IF sub IS NOT NULL THEN
  IF (sub->>'mapping_state'='mapped' AND sub->>'payment_channel' IS DISTINCT FROM 'stripe')
   OR (sub->>'mapping_state'='none' AND sub->>'payment_channel' IS NOT NULL)
   OR (sub->>'mapping_state'='mapped' AND lower(sub->>'status') IN ('past_due','incomplete','unpaid','canceled','cancelled'))
   THEN level_name:='free'; END IF;
  IF sub->>'mapping_state'='mapped' AND lower(sub->>'status') IN ('active','trialing') THEN
   IF NOT EXISTS(SELECT 1 FROM membership_plans WHERE id::text=sub->>'membership_plan_id' AND level=level_name)
    OR (sub->>'cancel_at_period_end'='true' AND (sub->>'current_period_end')::timestamptz<=clock_timestamp())
    THEN level_name:='free'; END IF;
  END IF;
 END IF;
 SELECT library_storage_bytes INTO cap FROM membership_plans WHERE level=coalesce(level_name,'free');
 IF cap IS NULL THEN RAISE EXCEPTION 'LIBRARY_UNAVAILABLE'; END IF;
 RETURN cap;
END $$;
CREATE OR REPLACE FUNCTION public.library_usage(a uuid) RETURNS bigint
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(original_hold+text_hold+segment_hold),0)::bigint FROM library_upload_reservations WHERE actor_id=a
$$;
CREATE OR REPLACE FUNCTION public.library_upload_begin(a uuid,r uuid,n text,f text,p text,declared bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; path text;
BEGIN
 PERFORM library_actor(a);
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE key='library_upload_enabled' AND value::jsonb='true'::jsonb)
  THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 IF r IS NULL OR n IS NULL OR octet_length(n) NOT BETWEEN 1 AND 1024 OR p IS NULL
  OR p NOT IN ('authored','reference') OR declared IS NULL OR declared NOT BETWEEN 1 AND 10000000
  OR f IS NULL OR f NOT IN ('txt','md','jpeg','png','webp') THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 SELECT * INTO d FROM library_documents WHERE actor_id=a AND request_id=r;
 IF d.id IS NOT NULL THEN
  RETURN jsonb_build_object('documentId',d.id,'dispatch',false,'status',d.status); END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a)>=10000 THEN RAISE EXCEPTION 'LIBRARY_FILE_LIMIT'; END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a AND status IN ('uploading','processing'))>=4
  THEN RAISE EXCEPTION 'LIBRARY_INFLIGHT_LIMIT'; END IF;
 IF library_usage(a)+10000000>library_capacity(a) THEN RAISE EXCEPTION 'LIBRARY_SPACE'; END IF;
 INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename)
 VALUES(a,r,CASE WHEN f IN ('jpeg','png','webp') THEN 'image' ELSE 'document' END,f,p,n) RETURNING * INTO d;
 path:=a::text||'/'||d.id::text||'/original';
 -- Dispatch must finish within five minutes; SDK HTTP is bounded separately. Never reissue this grant.
 INSERT INTO library_upload_reservations(document_id,actor_id,original_hold,original_guard_until,original_path)
 VALUES(d.id,a,10000000,clock_timestamp()+interval '3 hours 5 minutes',path);
 RETURN jsonb_build_object('documentId',d.id,'dispatch',true,'path',path,'status',d.status);
END $$;

CREATE OR REPLACE FUNCTION public.library_document_read(a uuid,did uuid,require_ready boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; r library_upload_reservations;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR SHARE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status IN ('deleting','failed')
  OR (require_ready AND d.status<>'ready') THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 SELECT * INTO r FROM library_upload_reservations WHERE document_id=did;
 RETURN to_jsonb(d)||jsonb_build_object('path',r.original_path,'guardUntil',r.original_guard_until);
END $$;
CREATE OR REPLACE FUNCTION public.library_publish(a uuid,did uuid,actual bigint,segments jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; s jsonb; total bigint:=0; idx integer:=0; added bigint;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status NOT IN ('uploading','ready') THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF d.status='ready' THEN RETURN jsonb_build_object('status','ready','documentId',did); END IF;
 IF actual IS NULL OR actual NOT BETWEEN 1 AND 10000000 OR jsonb_typeof(segments) IS DISTINCT FROM 'array'
  OR jsonb_array_length(segments)>10000 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 IF d.kind='image' AND segments<>'[]'::jsonb THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(segments) LOOP
  IF jsonb_typeof(s->'body') IS DISTINCT FROM 'string' OR octet_length(s->>'body') NOT BETWEEN 1 AND 8192
   OR jsonb_typeof(s->'title') IS DISTINCT FROM 'string' OR octet_length(s->>'title')>512
   THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
  total:=total+octet_length(s->>'body');
 END LOOP;
 IF total>10000000 THEN RAISE EXCEPTION 'LIBRARY_TEXT_LIMIT'; END IF;
 SELECT total-segment_hold INTO added FROM library_upload_reservations WHERE document_id=did;
 IF added>0 AND library_usage(a)+added>library_capacity(a) THEN RAISE EXCEPTION 'LIBRARY_SPACE'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(segments) LOOP
  INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,source)
  VALUES(did,a,idx,s->>'title',s->>'body','extracted'); idx:=idx+1;
 END LOOP;
 UPDATE library_upload_reservations SET segment_hold=total WHERE document_id=did;
 UPDATE library_documents SET status='ready',original_bytes=actual,text_bytes=total WHERE id=did;
 RETURN jsonb_build_object('status','ready','documentId',did);
END $$;
CREATE OR REPLACE FUNCTION public.library_delete(a uuid,did uuid,closed boolean DEFAULT false,unfinished_only boolean DEFAULT false,expiry_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents;
BEGIN
 PERFORM library_actor(a,closed);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 IF d.id IS NULL THEN RETURN jsonb_build_object('status','deleted'); END IF;
 IF unfinished_only AND d.status='ready' THEN RETURN jsonb_build_object('status','ready'); END IF;
 IF expiry_only AND clock_timestamp()<=(SELECT greatest(original_guard_until,text_guard_until)
  FROM library_upload_reservations WHERE document_id=did) THEN
  RETURN jsonb_build_object('status',d.status); END IF;
 UPDATE library_documents SET status='deleting',deleted_at=coalesce(deleted_at,clock_timestamp()),
  filename=NULL,purpose=NULL,format=NULL,original_bytes=0,text_bytes=0 WHERE id=did;
 DELETE FROM library_document_segments WHERE document_id=did;
 DELETE FROM library_recognition_units WHERE document_id=did AND bill2_request_id IS NULL;
 UPDATE library_upload_reservations SET cleanup=true,segment_hold=0 WHERE document_id=did;
 RETURN jsonb_build_object('status','deleting');
END $$;
CREATE OR REPLACE FUNCTION public.library_list(a uuid,after_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM library_actor(a);
 RETURN jsonb_build_object('usedBytes',library_usage(a),'capacityBytes',library_capacity(a),'documents',(
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT id,kind,format,purpose,filename,status,
  original_bytes,text_bytes,content_version,created_at FROM library_documents WHERE actor_id=a
  AND (after_id IS NULL OR id>after_id) ORDER BY id LIMIT 50) x));
END $$;
CREATE OR REPLACE FUNCTION public.library_segments(a uuid,did uuid,ver integer,start_at integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 d:=library_document_read(a,did);
 IF ver IS DISTINCT FROM (d->>'content_version')::integer THEN RAISE EXCEPTION 'LIBRARY_VERSION_CHANGED'; END IF;
 IF start_at<0 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT ordinal,title,body,bytes,page_number,source
  FROM library_document_segments WHERE document_id=did AND ordinal>=start_at ORDER BY ordinal LIMIT 1) s);
END $$;
CREATE OR REPLACE FUNCTION public.library_purpose(a uuid,did uuid,p text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM library_document_read(a,did);
 IF p IS NULL OR p NOT IN ('authored','reference') THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 UPDATE library_documents SET purpose=p WHERE id=did;
END $$;

-- Service-only bounded sweep; closed accounts are cleaned by the same domain functions.
CREATE OR REPLACE FUNCTION public.library_cleanup_candidates(a uuid DEFAULT NULL,n integer DEFAULT 50,did uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF current_setting('role',true) IS DISTINCT FROM 'service_role' OR n NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'LIBRARY_FORBIDDEN'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT r.*,d.status,
  (p.is_deleted::text='true'
   OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=r.actor_id)) AS closed
  FROM library_upload_reservations r JOIN library_documents d ON d.id=r.document_id JOIN profiles p ON p.id=r.actor_id
  WHERE (a IS NULL OR r.actor_id=a) AND (did IS NULL OR r.document_id=did)
  AND (r.cleanup OR p.is_deleted::text='true'
   OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=r.actor_id)
   OR (r.original_guard_until<clock_timestamp() AND (d.status='uploading'
    OR (d.status='ready' AND r.original_hold<>d.original_bytes))))
  ORDER BY r.checked_at,r.document_id LIMIT n) x);
END $$;
CREATE OR REPLACE FUNCTION public.library_cleanup_observe(a uuid,did uuid,absent boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r library_upload_reservations; d library_documents;
BEGIN
 PERFORM library_actor(a,true);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 SELECT * INTO r FROM library_upload_reservations WHERE document_id=did AND actor_id=a FOR UPDATE;
 IF r.document_id IS NULL THEN RETURN true; END IF;
 UPDATE library_upload_reservations SET checked_at=clock_timestamp() WHERE document_id=did;
 IF NOT r.cleanup THEN
  IF d.status='ready' AND clock_timestamp()>greatest(r.original_guard_until,r.text_guard_until) THEN
   UPDATE library_upload_reservations SET original_hold=d.original_bytes WHERE document_id=did;
  END IF;
  RETURN false;
 END IF;
 IF absent IS DISTINCT FROM true OR clock_timestamp()<=greatest(r.original_guard_until,r.text_guard_until) THEN
  UPDATE library_upload_reservations SET absent_observed_at=NULL WHERE document_id=did; RETURN false; END IF;
 IF r.absent_observed_at IS NULL THEN
  UPDATE library_upload_reservations SET absent_observed_at=clock_timestamp() WHERE document_id=did; RETURN false; END IF;
 IF clock_timestamp()<r.absent_observed_at+interval '1 second'
  OR EXISTS(SELECT 1 FROM library_recognition_units WHERE document_id=did AND bill2_request_id IS NOT NULL)
  THEN RETURN false; END IF;
 DELETE FROM library_upload_reservations WHERE document_id=did;
 DELETE FROM library_documents WHERE id=did;
 RETURN true;
END $$;
-- Includes live-token cleanup shells; an empty bucket alone never proves completion.
CREATE OR REPLACE FUNCTION public.library_erasure_remaining(a uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (SELECT count(*) FROM library_documents WHERE actor_id=a)
  +(SELECT count(*) FROM library_document_segments WHERE actor_id=a)
  +(SELECT count(*) FROM library_recognition_units WHERE actor_id=a)
  +(SELECT count(*) FROM library_upload_reservations WHERE actor_id=a)
$$;

CREATE OR REPLACE FUNCTION public.library_cleanup_touch(a uuid,did uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM library_actor(a,true);
 UPDATE library_upload_reservations SET checked_at=clock_timestamp() WHERE document_id=did AND actor_id=a;
END $$;
CREATE OR REPLACE FUNCTION public.library_paths_claimed(paths text[]) RETURNS text[]
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(array_agg(x.path),'{}'::text[]) FROM unnest(paths) x(path)
 WHERE cardinality(paths)<=100 AND EXISTS(SELECT 1 FROM library_upload_reservations
  WHERE original_path=x.path OR text_path=x.path)
$$;

CREATE OR REPLACE FUNCTION public.library_cleanup_backlog(a uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('pending',count(*),'oldestDeletedAt',min(d.deleted_at),
  'overdue',count(*) FILTER (WHERE d.deleted_at<clock_timestamp()-interval '24 hours'))
 FROM library_upload_reservations r JOIN library_documents d ON d.id=r.document_id
 JOIN profiles p ON p.id=r.actor_id WHERE (a IS NULL OR r.actor_id=a) AND
 (r.cleanup OR (d.status='uploading' AND r.original_guard_until<clock_timestamp())
  OR p.is_deleted::text='true'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=r.actor_id))
$$;

-- Explicit entry points only; helper routines and raw tables remain inaccessible.
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('library_actor','library_capacity','library_usage','library_upload_begin',
   'library_document_read','library_publish','library_delete','library_list','library_segments','library_purpose',
   'library_cleanup_candidates','library_cleanup_observe','library_erasure_remaining','library_paths_claimed','library_cleanup_touch','library_cleanup_backlog') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) NOT IN ('library_actor','library_capacity','library_usage') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
-- Reuse the original request's completion proof. Ticket progress remains independent.
ALTER TABLE public.account_erasure_requests ADD COLUMN IF NOT EXISTS library_storage_verified_at timestamptz;
CREATE OR REPLACE FUNCTION public.library_erasure_proof(a uuid,rid uuid,token uuid,verified boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r account_erasure_requests;
BEGIN
 PERFORM account_erasure_assert_closed(a);
 PERFORM 1 FROM profiles WHERE id=a FOR UPDATE;
 SELECT * INTO r FROM account_erasure_requests WHERE profile_id=a FOR UPDATE;
 IF token IS NULL OR r.executor_token IS DISTINCT FROM token OR r.request_id IS DISTINCT FROM rid THEN
  RAISE EXCEPTION 'ERASURE_EXECUTOR_NOT_CLAIMED' USING ERRCODE='42501'; END IF;
 IF verified IS NULL THEN RAISE EXCEPTION 'ERASURE_INVALID_STORAGE_PROOF'; END IF;
 IF verified THEN
  IF library_erasure_remaining(a)<>0 THEN RAISE EXCEPTION 'ERASURE_LIBRARY_PENDING'; END IF;
  UPDATE account_erasure_requests SET library_storage_verified_at=clock_timestamp() WHERE profile_id=a;
  RETURN true;
 END IF;
 RETURN r.library_storage_verified_at IS NOT NULL AND library_erasure_remaining(a)=0;
END $$;
REVOKE ALL ON FUNCTION public.library_erasure_proof(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.library_erasure_proof(uuid,uuid,uuid,boolean) TO service_role;

-- Extend merged 0192/0197 functions in place, retaining predecessor modifications.
-- Unique anchors fail closed on source drift; markers make repeat application stable.
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n', E' CASE\n WHEN t IN (''library_documents'',''library_document_segments'',\n  ''library_upload_reservations'',''library_recognition_units'') THEN RETURN (j->>''actor_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n',
   E' FOREACH t IN ARRAY ARRAY[\n  ''library_document_segments'',''library_recognition_units'',''library_documents'',\n'),
  ('account_erasure_business_remaining(uuid)', ' SELECT (SELECT count(*) FROM runtime_sessions',
   E' SELECT public.library_erasure_remaining(p_profile_id)\n +(SELECT count(*) FROM account_erasure_requests WHERE profile_id=p_profile_id\n  AND stage<>''completed'' AND library_storage_verified_at IS NULL)\n +(SELECT count(*) FROM runtime_sessions'),
  ('account_erasure_local_cleanup(uuid,boolean)', ' IF p_storage_verified AND NOT EXISTS',
   E' IF p_storage_verified AND EXISTS(SELECT 1 FROM account_erasure_requests\n  WHERE profile_id=p_profile_id AND library_storage_verified_at IS NOT NULL)\n  AND library_erasure_remaining(p_profile_id)=0 AND NOT EXISTS')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- LIB-2a public erasure' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'LIBRARY_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   source:=replace(source,needle,E' -- LIB-2a public erasure\n'||replacement);
   -- Never prune reservations, their parents, or unsettled recognition identities.
   IF sig='account_erasure_prune_business(uuid,integer)' THEN
    needle:='   IF item.body ? ''erased_at''';
    IF position(needle IN source)=0 THEN RAISE EXCEPTION 'LIBRARY_ERASURE_PRUNE_MISMATCH'; END IF;
    source:=replace(source,needle,$patch$   IF t LIKE 'library_%' AND (
     EXISTS(SELECT 1 FROM library_upload_reservations WHERE actor_id=p_profile_id)
     OR EXISTS(SELECT 1 FROM library_recognition_units WHERE actor_id=p_profile_id AND bill2_request_id IS NOT NULL)
    ) THEN CONTINUE; END IF;
$patch$||needle);
   END IF;
   EXECUTE source;
  END IF;
 END LOOP;
END $$;

COMMIT;
