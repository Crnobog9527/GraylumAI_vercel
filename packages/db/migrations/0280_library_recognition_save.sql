-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-2d: save text the user's browser recognised from scanned PDF pages and Word images (Owner 2026-10-17:
-- browser PaddleOCR; no model call, no charge), and create Word image units at upload. Off unless
-- system_settings.library_scan_recognition_enabled is true. Additive and repeatable: a 'failed' unit status,
-- an anchor column for Word images, a Word publisher overload and service-role RPCs; no existing data changes.
-- Rollback: keep the switch off; the new functions and column are unused without it.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.library_recognition_units DROP CONSTRAINT IF EXISTS library_recognition_units_status_check;
ALTER TABLE public.library_recognition_units ADD CONSTRAINT library_recognition_units_status_check
 CHECK(status IN ('pending','running','complete','paused','over_limit','settling','failed'));
-- Word images only: how many extracted segments come before the image; recognised text goes right there.
ALTER TABLE public.library_recognition_units ADD COLUMN IF NOT EXISTS anchor integer;
ALTER TABLE public.library_recognition_units DROP CONSTRAINT IF EXISTS library_recognition_units_anchor_check;
ALTER TABLE public.library_recognition_units ADD CONSTRAINT library_recognition_units_anchor_check
 CHECK((unit_kind='word_image') = (anchor IS NOT NULL) AND (anchor IS NULL OR anchor BETWEEN 0 AND 10000));

CREATE OR REPLACE FUNCTION public.library_recognition_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM system_settings WHERE key='library_scan_recognition_enabled' AND value::jsonb='true'::jsonb)
$$;

-- Word publish with its images (offsets already turned into anchors by the service): the first 50 are recognised,
-- later ones are over the per-file limit (LIB_DOCS_PLAN 4.1/4.4). Text and segments follow the original publisher.
CREATE OR REPLACE FUNCTION public.library_word_publish(a uuid,did uuid,actual bigint,text_actual bigint,segments jsonb,images jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; i jsonb; n integer:=0; last_anchor integer:=0; count_segments integer;
BEGIN
 IF jsonb_typeof(images) IS DISTINCT FROM 'array' OR jsonb_array_length(images)>500 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 count_segments:=jsonb_array_length(segments);
 FOR i IN SELECT value FROM jsonb_array_elements(images) LOOP
  IF jsonb_typeof(i->'anchor') IS DISTINCT FROM 'number' OR (i->>'anchor') !~ '^(0|[1-9][0-9]{0,4})$'
   OR (i->>'anchor')::integer<last_anchor OR (i->>'anchor')::integer>count_segments THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
  last_anchor:=(i->>'anchor')::integer;
 END LOOP;
 result:=library_word_publish(a,did,actual,text_actual,segments);
 IF NOT EXISTS(SELECT 1 FROM library_recognition_units WHERE document_id=did) THEN
  FOR i IN SELECT value FROM jsonb_array_elements(images) LOOP
   n:=n+1;
   INSERT INTO library_recognition_units(document_id,actor_id,unit_kind,position,has_text,status,anchor)
   VALUES(did,a,'word_image',n,false,CASE WHEN n<=50 THEN 'pending' ELSE 'over_limit' END,(i->>'anchor')::integer);
  END LOOP;
 END IF;
 RETURN result;
END $$;

-- The actor's own ready PDF or Word document, locked; the caller already holds the actor lock.
CREATE OR REPLACE FUNCTION public.library_recognition_document(a uuid,did uuid,kind text) RETURNS library_documents
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d library_documents;
BEGIN
 SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=a FOR UPDATE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status<>'ready' THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF d.kind<>'document' OR kind IS NULL OR (kind,d.format) NOT IN (('pdf_page','pdf'),('word_image','docx')) THEN
  RAISE EXCEPTION 'LIBRARY_TYPE'; END IF;
 RETURN d;
END $$;

-- Ready documents that still have units waiting (pending or paused), oldest first, for the library page to
-- continue recognition when it opens. At most 20 documents and their first 50 waiting units each.
CREATE OR REPLACE FUNCTION public.library_recognition_pending(a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM library_actor(a);
 IF NOT library_recognition_enabled() THEN RETURN '[]'::jsonb; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('documentId',d.id,'format',d.format,'contentVersion',d.content_version,
   'positions',(SELECT jsonb_agg(position ORDER BY position) FROM (SELECT position FROM library_recognition_units u
     WHERE u.document_id=d.id AND u.status IN ('pending','paused') ORDER BY position LIMIT 50) w))
   ORDER BY d.created_at,d.id),'[]')
  FROM (SELECT * FROM library_documents d WHERE d.actor_id=a AND d.status='ready' AND d.deleted_at IS NULL
   AND d.kind='document' AND d.format IN ('pdf','docx') AND EXISTS(SELECT 1 FROM library_recognition_units u
    WHERE u.document_id=d.id AND u.status IN ('pending','paused')) ORDER BY d.created_at,d.id LIMIT 20) d);
END $$;

-- One unit's recognised segments, inserted in reading order: a PDF page after the earlier pages, a Word image at
-- its anchor. A unit is saved once: a repeated or concurrent save (another tab) finds it complete and changes
-- nothing. Not enough space pauses the unit instead of failing.
CREATE OR REPLACE FUNCTION public.library_recognition_save(a uuid,did uuid,kind text,pos integer,ver integer,segments jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d library_documents; u library_recognition_units; s jsonb; total bigint:=0; n integer; at_ordinal integer; idx integer:=0;
BEGIN
 PERFORM library_actor(a);
 IF NOT library_recognition_enabled() THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 d:=library_recognition_document(a,did,kind);
 SELECT * INTO u FROM library_recognition_units WHERE document_id=did AND unit_kind=kind AND position=pos FOR UPDATE;
 IF u.document_id IS NULL THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF u.status NOT IN ('pending','paused') THEN
  RETURN jsonb_build_object('saved',false,'status',u.status,'contentVersion',d.content_version); END IF;
 IF ver IS DISTINCT FROM d.content_version THEN RAISE EXCEPTION 'LIBRARY_VERSION_CHANGED'; END IF;
 IF jsonb_typeof(segments) IS DISTINCT FROM 'array' OR jsonb_array_length(segments) NOT BETWEEN 1 AND 200
  THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 n:=jsonb_array_length(segments);
 FOR s IN SELECT value FROM jsonb_array_elements(segments) LOOP
  IF jsonb_typeof(s->'body') IS DISTINCT FROM 'string' OR octet_length(s->>'body') NOT BETWEEN 1 AND 8192
   OR jsonb_typeof(s->'title') IS DISTINCT FROM 'string' OR octet_length(s->>'title')>512
   OR position(chr(12) in s->>'body')>0 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
  total:=total+octet_length(s->>'body');
 END LOOP;
 IF total>400000 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 -- A document holds at most 10,000 segments and 10,000,000 segment bytes (library_upload_reservations CHECK).
 -- A unit that cannot fit is marked failed, not left pending, so the page does not retry it forever.
 IF (SELECT count(*) FROM library_document_segments WHERE document_id=did)+n>10000
  OR (SELECT segment_hold FROM library_upload_reservations WHERE document_id=did)+total>10000000 THEN
  UPDATE library_recognition_units SET status='failed' WHERE document_id=did AND unit_kind=kind AND position=pos;
  RETURN jsonb_build_object('saved',false,'status','failed','contentVersion',d.content_version,'code','LIBRARY_TEXT_LIMIT');
 END IF;
 IF library_usage(a)+total>library_capacity(a) THEN
  UPDATE library_recognition_units SET status='paused' WHERE document_id=did AND unit_kind=kind AND position=pos;
  RETURN jsonb_build_object('saved',false,'status','paused','contentVersion',d.content_version,'code','LIBRARY_SPACE');
 END IF;
 IF kind='pdf_page' THEN
  SELECT count(*) INTO at_ordinal FROM library_document_segments WHERE document_id=did AND page_number<=pos;
 ELSE
  -- Before the extracted segment the image precedes (after any earlier image text already placed there).
  SELECT coalesce((SELECT ordinal FROM library_document_segments WHERE document_id=did AND source='extracted'
   ORDER BY ordinal OFFSET u.anchor LIMIT 1),(SELECT count(*) FROM library_document_segments WHERE document_id=did))
  INTO at_ordinal;
 END IF;
 -- Ordinals stay contiguous: later segments move up by n through a range no ordinal uses.
 UPDATE library_document_segments SET ordinal=ordinal+100000 WHERE document_id=did AND ordinal>=at_ordinal;
 FOR s IN SELECT value FROM jsonb_array_elements(segments) LOOP
  INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,page_number,source)
  VALUES(did,a,at_ordinal+idx,s->>'title',s->>'body',CASE WHEN kind='pdf_page' THEN pos END,'recognized'); idx:=idx+1;
 END LOOP;
 UPDATE library_document_segments SET ordinal=ordinal-100000+n WHERE document_id=did AND ordinal>=100000;
 UPDATE library_upload_reservations SET segment_hold=segment_hold+total WHERE document_id=did;
 UPDATE library_recognition_units SET status='complete' WHERE document_id=did AND unit_kind=kind AND position=pos;
 UPDATE library_documents SET content_version=content_version+1 WHERE id=did;
 RETURN jsonb_build_object('saved',true,'status','complete','contentVersion',d.content_version+1);
END $$;

-- The browser could not read this unit (unrenderable image, timeout): shown as failed, nothing stored.
CREATE OR REPLACE FUNCTION public.library_recognition_fail(a uuid,did uuid,kind text,pos integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u library_recognition_units;
BEGIN
 PERFORM library_actor(a);
 IF NOT library_recognition_enabled() THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 PERFORM library_recognition_document(a,did,kind);
 SELECT * INTO u FROM library_recognition_units WHERE document_id=did AND unit_kind=kind AND position=pos FOR UPDATE;
 IF u.document_id IS NULL THEN RAISE EXCEPTION 'LIBRARY_NOT_FOUND'; END IF;
 IF u.status IN ('pending','paused') THEN
  UPDATE library_recognition_units SET status='failed' WHERE document_id=did AND unit_kind=kind AND position=pos;
  RETURN jsonb_build_object('status','failed');
 END IF;
 RETURN jsonb_build_object('status',u.status);
END $$;

REVOKE ALL ON FUNCTION public.library_recognition_enabled(),public.library_recognition_document(uuid,uuid,text),
 public.library_recognition_pending(uuid),public.library_recognition_save(uuid,uuid,text,integer,integer,jsonb),
 public.library_recognition_fail(uuid,uuid,text,integer),public.library_word_publish(uuid,uuid,bigint,bigint,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.library_recognition_pending(uuid),public.library_recognition_save(uuid,uuid,text,integer,integer,jsonb),
 public.library_recognition_fail(uuid,uuid,text,integer),public.library_word_publish(uuid,uuid,bigint,bigint,jsonb,jsonb) TO service_role;
COMMIT;
