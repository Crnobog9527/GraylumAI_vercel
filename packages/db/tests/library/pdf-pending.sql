-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Draft migration pending control assignment. Local fixture only; never deployed.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.library_upload_begin(a uuid,r uuid,n text,f text,p text,declared bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; path text; hold bigint;
BEGIN
 PERFORM library_actor(a);
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE key='library_upload_enabled' AND value::jsonb='true'::jsonb)
  THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 IF r IS NULL OR n IS NULL OR octet_length(n) NOT BETWEEN 1 AND 1024 OR p IS NULL
  OR p NOT IN ('authored','reference') OR declared IS NULL OR declared NOT BETWEEN 1 AND 10000000
  OR f IS NULL OR f NOT IN ('txt','md','docx','pdf','jpeg','png','webp') THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 SELECT * INTO d FROM library_documents WHERE actor_id=a AND request_id=r;
 IF d.id IS NOT NULL THEN
  RETURN jsonb_build_object('documentId',d.id,'dispatch',false,'status',d.status); END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a)>=10000 THEN RAISE EXCEPTION 'LIBRARY_FILE_LIMIT'; END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a AND status IN ('uploading','processing'))>=4
  THEN RAISE EXCEPTION 'LIBRARY_INFLIGHT_LIMIT'; END IF;
 hold:=CASE WHEN f IN ('docx','pdf') THEN 20000000 ELSE 10000000 END;
 IF library_usage(a)+hold>library_capacity(a) THEN RAISE EXCEPTION 'LIBRARY_SPACE'; END IF;
 INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename)
 VALUES(a,r,CASE WHEN f IN ('jpeg','png','webp') THEN 'image' ELSE 'document' END,f,p,n) RETURNING * INTO d;
 path:=a::text||'/'||d.id::text||'/original';
 -- Dispatch must finish within five minutes; SDK HTTP is bounded separately. Never reissue this grant.
 INSERT INTO library_upload_reservations(document_id,actor_id,original_hold,original_guard_until,original_path)
 VALUES(d.id,a,10000000,clock_timestamp()+interval '3 hours 5 minutes',path);
 IF f IN ('docx','pdf') THEN
  UPDATE library_upload_reservations SET text_hold=10000000,text_path=a::text||'/'||d.id::text||'/text',
   text_guard_until=NULL WHERE document_id=d.id;
 END IF;
 RETURN jsonb_build_object('documentId',d.id,'dispatch',true,'path',path,'textPath',CASE WHEN f IN ('docx','pdf') THEN a::text||'/'||d.id::text||'/text' END,'status',d.status);
END $$;

CREATE OR REPLACE FUNCTION public.library_pdf_text_begin(a uuid,did uuid,actual bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; r library_upload_reservations;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status NOT IN ('uploading','ready')
  THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF d.format IS DISTINCT FROM 'pdf' THEN RAISE EXCEPTION 'LIBRARY_TYPE'; END IF;
 SELECT * INTO r FROM library_upload_reservations WHERE document_id=did FOR UPDATE;
 IF d.status='ready' OR r.text_guard_until IS NOT NULL THEN
  RETURN jsonb_build_object('documentId',did,'status',d.status,'dispatch',false); END IF;
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE key='library_upload_enabled' AND value::jsonb='true'::jsonb)
  THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 IF actual IS NULL OR actual NOT BETWEEN 1 AND 10000000 OR r.text_path IS NULL OR r.text_hold<>10000000
  THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 UPDATE library_documents SET original_bytes=actual WHERE id=did;
 UPDATE library_upload_reservations SET text_guard_until=clock_timestamp()+interval '3 hours 5 minutes'
  WHERE document_id=did;
 RETURN jsonb_build_object('documentId',did,'status',d.status,'dispatch',true,'path',r.text_path);
END $$;

-- Service validates text slots; publish pages, segments and all accounting under the same actor/document locks.
CREATE OR REPLACE FUNCTION public.library_pdf_publish(a uuid,did uuid,actual bigint,text_actual bigint,segments jsonb,pages jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; r library_upload_reservations; s jsonb; p jsonb; total bigint:=0; idx integer:=0;
 count_pages integer; pn integer; last_page integer:=0; result jsonb;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status NOT IN ('uploading','ready')
  THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF d.format IS DISTINCT FROM 'pdf' THEN RAISE EXCEPTION 'LIBRARY_TYPE'; END IF;
 IF d.status='ready' THEN RETURN jsonb_build_object('documentId',did,'status','ready'); END IF;
 SELECT * INTO r FROM library_upload_reservations WHERE document_id=did FOR UPDATE;
 IF r.text_path IS NULL OR r.text_hold<>10000000 OR r.text_guard_until IS NULL
  OR actual IS NULL OR actual NOT BETWEEN 1 AND 10000000
  OR text_actual IS NULL OR text_actual NOT BETWEEN 0 AND 10000000
  OR jsonb_typeof(segments) IS DISTINCT FROM 'array' OR jsonb_array_length(segments)>10000
  OR jsonb_typeof(pages) IS DISTINCT FROM 'array' OR jsonb_array_length(pages) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 count_pages:=jsonb_array_length(pages);
 FOR p IN SELECT value FROM jsonb_array_elements(pages) LOOP
  idx:=idx+1;
  IF p->'page_number' IS DISTINCT FROM to_jsonb(idx) OR p->>'status' IS NULL
   OR p->>'status' NOT IN ('text','scanned','blank') THEN RAISE EXCEPTION 'LIBRARY_PAGES'; END IF;
 END LOOP;
 FOR s IN SELECT value FROM jsonb_array_elements(segments) LOOP
  IF jsonb_typeof(s->'body') IS DISTINCT FROM 'string' OR octet_length(s->>'body') NOT BETWEEN 1 AND 8192
   OR jsonb_typeof(s->'title') IS DISTINCT FROM 'string' OR octet_length(s->>'title')>512
   OR jsonb_typeof(s->'page_number') IS DISTINCT FROM 'number'
   THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
  pn:=(s->>'page_number')::integer;
  IF s->'page_number' IS DISTINCT FROM to_jsonb(pn) OR pn NOT BETWEEN 1 AND count_pages
   OR pn<last_page OR pages->(pn-1)->>'status' IS DISTINCT FROM 'text'
   OR position(chr(12) in s->>'body')>0 THEN RAISE EXCEPTION 'LIBRARY_PAGES'; END IF;
  last_page:=pn; total:=total+octet_length(s->>'body');
 END LOOP;
 IF total+count_pages-1<>text_actual THEN RAISE EXCEPTION 'LIBRARY_PAGES'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(pages) LOOP
  IF p->>'status'='text' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(segments) entry
    WHERE entry->'page_number'=p->'page_number') THEN RAISE EXCEPTION 'LIBRARY_PAGES'; END IF;
 END LOOP;
 -- Existing publisher checks quota and reserves segment bytes separately from both writable object holds.
 result:=library_publish(a,did,actual,segments);
 UPDATE library_document_segments ds SET page_number=(segments->ds.ordinal->>'page_number')::integer
  WHERE ds.document_id=did;
 -- text hold is the actual object size, including the form feeds omitted from segment bodies.
 UPDATE library_documents SET text_bytes=text_actual WHERE id=did;
 INSERT INTO library_recognition_units(document_id,actor_id,unit_kind,position,has_text,status)
 SELECT did,a,'pdf_page',(entry->>'page_number')::integer,entry->>'status'='text',
  CASE WHEN entry->>'status'='scanned' THEN 'pending' ELSE 'complete' END
 FROM jsonb_array_elements(pages) entry;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.library_pdf_text_begin(uuid,uuid,bigint),
 public.library_pdf_publish(uuid,uuid,bigint,bigint,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.library_pdf_text_begin(uuid,uuid,bigint),
 public.library_pdf_publish(uuid,uuid,bigint,bigint,jsonb,jsonb) TO service_role;
COMMIT;
