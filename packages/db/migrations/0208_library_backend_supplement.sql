-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-2a supplement. No settings or bucket changes. Apply after assigned 0205-0207.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS library_documents_actor_created ON public.library_documents(actor_id,created_at DESC,id DESC);

-- Timestamp stays in the cursor (microseconds intact), so deleting its document does not invalidate a page.
CREATE OR REPLACE FUNCTION public.library_list_page(a uuid,after_created_at timestamptz DEFAULT NULL,after_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows jsonb; last_row jsonb; more boolean;
BEGIN
 PERFORM library_actor(a);
 IF (after_created_at IS NULL)<>(after_id IS NULL) OR (after_created_at IS NOT NULL AND NOT isfinite(after_created_at))
  THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id DESC),'[]') INTO rows
 FROM (SELECT id,kind,format,purpose,filename,status,original_bytes,text_bytes,content_version,created_at
  FROM library_documents WHERE actor_id=a
  AND (after_id IS NULL OR (created_at,id)<(after_created_at,after_id))
  ORDER BY created_at DESC,id DESC LIMIT 51) x;
 more:=jsonb_array_length(rows)>50;
 IF more THEN rows:=rows-50; END IF;
 last_row:=rows->(jsonb_array_length(rows)-1);
 RETURN jsonb_build_object('usedBytes',library_usage(a),'capacityBytes',library_capacity(a),
  'uploadEnabled',EXISTS(SELECT 1 FROM system_settings WHERE key='library_upload_enabled' AND value::jsonb='true'::jsonb),
  'documents',rows,'nextCursor',CASE WHEN more THEN
    jsonb_build_object('createdAt',last_row->'created_at','id',last_row->'id') ELSE NULL END);
END $$;

-- Compatibility for existing callers; new clients should echo nextCursor verbatim.
CREATE OR REPLACE FUNCTION public.library_list(a uuid,after_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE stamp timestamptz;
BEGIN
 PERFORM library_actor(a);
 IF after_id IS NOT NULL THEN
  SELECT created_at INTO stamp FROM library_documents WHERE actor_id=a AND id=after_id;
  IF stamp IS NULL THEN RAISE EXCEPTION 'LIBRARY_INVALID_CURSOR'; END IF;
 END IF;
 RETURN library_list_page(a,stamp,after_id);
END $$;

-- Directory contains metadata only; document cap is 10,000 segments, titles at most 512 UTF-8 bytes.
CREATE OR REPLACE FUNCTION public.library_directory(a uuid,did uuid,ver integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 d:=library_document_read(a,did);
 IF ver IS DISTINCT FROM (d->>'content_version')::integer THEN RAISE EXCEPTION 'LIBRARY_VERSION_CHANGED'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'title',title) ORDER BY ordinal),'[]')
  FROM library_document_segments WHERE document_id=did);
END $$;
CREATE OR REPLACE FUNCTION public.library_segments_range(a uuid,did uuid,ver integer,start_at integer DEFAULT 0,count_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 d:=library_document_read(a,did);
 IF ver IS DISTINCT FROM (d->>'content_version')::integer THEN RAISE EXCEPTION 'LIBRARY_VERSION_CHANGED'; END IF;
 IF start_at IS NULL OR start_at NOT BETWEEN 0 AND 9999 OR count_limit IS NULL OR count_limit NOT BETWEEN 1 AND 50
  THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.ordinal),'[]') FROM
  (SELECT ordinal,title,body,bytes,page_number,source FROM library_document_segments
   WHERE document_id=did AND ordinal>=start_at ORDER BY ordinal LIMIT count_limit) s);
END $$;
CREATE OR REPLACE FUNCTION public.library_segments(a uuid,did uuid,ver integer,start_at integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN library_segments_range(a,did,ver,start_at,1);
END $$;

CREATE OR REPLACE FUNCTION public.library_upload_begin(a uuid,r uuid,n text,f text,p text,declared bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; path text; hold bigint;
BEGIN
 PERFORM library_actor(a);
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE key='library_upload_enabled' AND value::jsonb='true'::jsonb)
  THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 IF r IS NULL OR n IS NULL OR octet_length(n) NOT BETWEEN 1 AND 1024 OR p IS NULL
  OR p NOT IN ('authored','reference') OR declared IS NULL OR declared NOT BETWEEN 1 AND 10000000
  OR f IS NULL OR f NOT IN ('txt','md','docx','jpeg','png','webp') THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 SELECT * INTO d FROM library_documents WHERE actor_id=a AND request_id=r;
 IF d.id IS NOT NULL THEN
  RETURN jsonb_build_object('documentId',d.id,'dispatch',false,'status',d.status); END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a)>=10000 THEN RAISE EXCEPTION 'LIBRARY_FILE_LIMIT'; END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a AND status IN ('uploading','processing'))>=4
  THEN RAISE EXCEPTION 'LIBRARY_INFLIGHT_LIMIT'; END IF;
 hold:=CASE WHEN f='docx' THEN 20000000 ELSE 10000000 END;
 IF library_usage(a)+hold>library_capacity(a) THEN RAISE EXCEPTION 'LIBRARY_SPACE'; END IF;
 INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename)
 VALUES(a,r,CASE WHEN f IN ('jpeg','png','webp') THEN 'image' ELSE 'document' END,f,p,n) RETURNING * INTO d;
 path:=a::text||'/'||d.id::text||'/original';
 -- Dispatch must finish within five minutes; SDK HTTP is bounded separately. Never reissue this grant.
 INSERT INTO library_upload_reservations(document_id,actor_id,original_hold,original_guard_until,original_path)
 VALUES(d.id,a,10000000,clock_timestamp()+interval '3 hours 5 minutes',path);
 IF f='docx' THEN
  UPDATE library_upload_reservations SET text_hold=10000000,text_path=a::text||'/'||d.id::text||'/text',
   text_guard_until=original_guard_until WHERE document_id=d.id;
 END IF;
 RETURN jsonb_build_object('documentId',d.id,'dispatch',true,'path',path,'textPath',CASE WHEN f='docx' THEN a::text||'/'||d.id::text||'/text' END,'status',d.status);
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
 RETURN to_jsonb(d)||jsonb_build_object('path',r.original_path,'guardUntil',r.original_guard_until,'textPath',r.text_path);
END $$;

-- Only the trusted service supplies validated UTF-8 segments; both objects remain fully held while writable.
CREATE OR REPLACE FUNCTION public.library_word_publish(a uuid,did uuid,actual bigint,text_actual bigint,segments jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; r library_upload_reservations; total bigint;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status NOT IN ('uploading','ready')
  THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF d.format IS DISTINCT FROM 'docx' THEN RAISE EXCEPTION 'LIBRARY_TYPE'; END IF;
 IF d.status='ready' THEN RETURN jsonb_build_object('documentId',did,'status','ready'); END IF;
 SELECT * INTO r FROM library_upload_reservations WHERE document_id=did;
 IF r.text_path IS NULL OR r.text_hold<>10000000 OR r.text_guard_until IS NULL
  OR text_actual IS NULL OR text_actual NOT BETWEEN 1 AND 10000000
  OR jsonb_typeof(segments) IS DISTINCT FROM 'array' OR jsonb_array_length(segments) NOT BETWEEN 1 AND 10000
  THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 SELECT sum(octet_length(s->>'body')) INTO total FROM jsonb_array_elements(segments) s;
 IF total IS DISTINCT FROM text_actual THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 RETURN library_publish(a,did,actual,segments);
END $$;

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
   OR (greatest(r.original_guard_until,r.text_guard_until)<clock_timestamp() AND (d.status='uploading'
    OR (d.status='ready' AND (r.original_hold<>d.original_bytes OR (r.text_path IS NOT NULL AND r.text_hold<>d.text_bytes))))))
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
   UPDATE library_upload_reservations SET original_hold=d.original_bytes,
    text_hold=CASE WHEN r.text_path IS NULL THEN 0 ELSE d.text_bytes END WHERE document_id=did;
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

-- Explicit permissions for every new RPC, including on repeat application.
REVOKE ALL ON FUNCTION public.library_list_page(uuid,timestamptz,uuid),public.library_directory(uuid,uuid,integer),
 public.library_segments_range(uuid,uuid,integer,integer,integer),public.library_word_publish(uuid,uuid,bigint,bigint,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.library_list_page(uuid,timestamptz,uuid),public.library_directory(uuid,uuid,integer),
 public.library_segments_range(uuid,uuid,integer,integer,integer),public.library_word_publish(uuid,uuid,bigint,bigint,jsonb)
 TO service_role;
COMMIT;
