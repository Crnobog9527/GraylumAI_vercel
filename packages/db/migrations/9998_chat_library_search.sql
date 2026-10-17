-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-AUTO-CONTEXT A1 (docs/launch/tasks/CHAT-AUTO-CONTEXT.md; Owner 2026-10-17, MASTER_PLAN 2.1): free conversations
-- search the user's own library. Repeatable: IF NOT EXISTS, CREATE OR REPLACE. No new table.
--
-- 1. pg_trgm trigram indexes on segment body, segment title and file name: ILIKE '%word%' (Chinese and English alike,
--    no tokenizer) uses them; the search never scans a table by hand.
-- 2. runtime_library_references.origin ('reference' = @ by the user, 'retrieved' = found by a search) and ordinal up to 29.
-- 3. runtime_library_read understands query 'search:<words>' (at most 3 per execution, inside the 8 reads and 65,536
--    bytes of 0262), freezes hit documents at their current version, and reads doc-1 … doc-29. It also answers when the
--    execution froze no @ reference but carries payload libraryRetrieval=true (set at admission by A2 behind the
--    system setting chat_library_retrieval_enabled).
-- 4. A saved search result is rechecked under the document lock (a document deleted or changed between search and save
--    makes the stored result 'unavailable/source_deleted', never the excerpt), is replayed only while its documents are
--    live, and is removed by the existing deletion cleanup with the other library reads.
-- Rollback: re-run 0262's definitions of runtime_library_read, runtime_library_visible, runtime_library_tool_guard and
-- runtime_library_propagate; indexes and the origin column can stay (nothing reads them).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE INDEX IF NOT EXISTS library_segments_body_trgm ON public.library_document_segments USING gin (body extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS library_segments_title_trgm ON public.library_document_segments USING gin (title extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS library_documents_filename_trgm ON public.library_documents USING gin (filename extensions.gin_trgm_ops);

ALTER TABLE public.runtime_library_references ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'reference'
 CHECK (origin IN ('reference','retrieved'));
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.runtime_library_references'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%ordinal%' LOOP
  EXECUTE format('ALTER TABLE public.runtime_library_references DROP CONSTRAINT %I',c.conname);
 END LOOP;
 ALTER TABLE public.runtime_library_references ADD CONSTRAINT runtime_library_references_ordinal_check CHECK (ordinal BETWEEN 1 AND 29);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_library_read(p_actor_id uuid,p_execution_id uuid,p_query text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions; ref runtime_library_references; d library_documents; m text[]; result jsonb;
 page integer; total integer; used bigint; reads integer; cap integer; seg library_document_segments;
 terms text[]; searches integer; next_ordinal integer; hit record; hits jsonb:='[]'; picked uuid[]:='{}'; note text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL OR e.state<>'running' OR e.erased_at IS NOT NULL OR e.content_deleted_at IS NOT NULL
  OR (NOT EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=e.id)
   AND coalesce(e.payload->>'libraryRetrieval','') IS DISTINCT FROM 'true')
 THEN RAISE EXCEPTION 'LIB_REFERENCE_READ_DENIED'; END IF;
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(t.result::text)::text)),0) INTO reads,used FROM runtime_tool_calls t
  WHERE t.execution_id=e.id AND t.name='read_source' AND t.result->>'kind' IN ('library_index','library_directory','library_segment','library_search');
 IF reads>=8 OR used>=65536 THEN RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
 IF coalesce(p_query,'')='' THEN
  PERFORM document.id FROM library_documents document
   JOIN runtime_library_references r ON r.document_id=document.id AND r.actor_id=document.actor_id
   WHERE r.execution_id=e.id ORDER BY document.id FOR SHARE OF document;
  SELECT jsonb_build_object('kind','library_index','documents',coalesce(jsonb_agg(jsonb_build_object(
    'ref','doc-'||r.ordinal,'documentId',r.document_id,'version',r.content_version,
    'title',CASE WHEN x.id IS NULL OR x.deleted_at IS NOT NULL OR x.status<>'ready' THEN NULL ELSE left(x.filename,160) END,
    'available',x.id IS NOT NULL AND x.deleted_at IS NULL AND x.status='ready' AND x.content_version=r.content_version,
    'segments',(SELECT count(*) FROM library_document_segments s WHERE s.document_id=x.id AND x.status='ready'))
   ORDER BY r.ordinal),'[]'))
  INTO result FROM runtime_library_references r LEFT JOIN library_documents x ON x.id=r.document_id AND x.actor_id=r.actor_id
  WHERE r.execution_id=e.id;
  IF octet_length(to_jsonb(result::text)::text)>16384
   OR used+octet_length(to_jsonb(result::text)::text)>65536 THEN
   RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
  RETURN result;
 END IF;

 -- CHAT-AUTO-CONTEXT A1: 'search:<words>' finds the caller's own ready documents by trigram match on words (up to 5, each
 -- 1-40 characters) in body, segment title and file name, freezes every hit document at its current version into this
 -- execution (origin 'retrieved', doc-6 … doc-29 beside the @ references) and returns short excerpts. Words shorter than 3
 -- characters match only titles and file names. At most 3 searches count toward the 8 reads and 65,536 bytes of 0262.
 IF p_query LIKE 'search:%' THEN
  IF coalesce(e.payload->>'libraryRetrieval','') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LIB_REFERENCE_READ_DENIED'; END IF;
  SELECT count(*) INTO searches FROM runtime_tool_calls t WHERE t.execution_id=e.id AND t.name='read_source' AND t.result->>'kind'='library_search';
  IF searches>=3 THEN RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
  SELECT coalesce(array_agg(DISTINCT w),'{}') INTO terms FROM (
   SELECT btrim(x) w FROM unnest(regexp_split_to_array(substr(p_query,8),'[\s,，、;；]+')) x) q WHERE w<>'';
  IF cardinality(terms) NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM unnest(terms) w WHERE char_length(w) NOT BETWEEN 1 AND 40)
  THEN RETURN jsonb_build_object('kind','unavailable','reason','unknown_query'); END IF;
  -- Top 8 segments (at most 3 per document) by how many words they match.
  FOR hit IN SELECT * FROM (
    SELECT sg.document_id,sg.ordinal,sg.title,sg.page_number,ld.filename,ld.content_version,mt.score,mt.pos,sg.body,
     row_number() OVER (PARTITION BY sg.document_id ORDER BY mt.score DESC,sg.ordinal) per_doc
    FROM library_document_segments sg
    JOIN library_documents ld ON ld.id=sg.document_id AND ld.actor_id=sg.actor_id
    CROSS JOIN LATERAL (SELECT count(*)::int score,min(nullif(position(lower(w) IN lower(sg.body)),0)) pos FROM unnest(terms) w
      WHERE (char_length(w)>=3 AND sg.body ILIKE '%'||replace(replace(replace(w,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%')
       OR sg.title ILIKE '%'||replace(replace(replace(w,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%'
       OR coalesce(ld.filename,'') ILIKE '%'||replace(replace(replace(w,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%') mt
    WHERE sg.actor_id=p_actor_id AND ld.kind='document' AND ld.status='ready' AND ld.deleted_at IS NULL AND mt.score>0) ranked
   WHERE per_doc<=3 ORDER BY score DESC,document_id,ordinal LIMIT 8 LOOP
   picked:=picked||hit.document_id;
  END LOOP;
  -- Lock hit documents in id order (library_delete holds the same row exclusively), then freeze them.
  PERFORM id FROM library_documents WHERE actor_id=p_actor_id AND id=ANY(picked) ORDER BY id FOR SHARE;
  FOR hit IN SELECT * FROM (
    SELECT sg.document_id,sg.ordinal,sg.title,sg.page_number,ld.filename,ld.content_version,mt.score,mt.pos,sg.body,
     row_number() OVER (PARTITION BY sg.document_id ORDER BY mt.score DESC,sg.ordinal) per_doc
    FROM library_document_segments sg
    JOIN library_documents ld ON ld.id=sg.document_id AND ld.actor_id=sg.actor_id
    CROSS JOIN LATERAL (SELECT count(*)::int score,min(nullif(position(lower(w) IN lower(sg.body)),0)) pos FROM unnest(terms) w
      WHERE (char_length(w)>=3 AND sg.body ILIKE '%'||replace(replace(replace(w,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%')
       OR sg.title ILIKE '%'||replace(replace(replace(w,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%'
       OR coalesce(ld.filename,'') ILIKE '%'||replace(replace(replace(w,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%') mt
    WHERE sg.actor_id=p_actor_id AND ld.kind='document' AND ld.status='ready' AND ld.deleted_at IS NULL AND mt.score>0
     AND sg.document_id=ANY(picked)) ranked
   WHERE per_doc<=3 ORDER BY score DESC,document_id,ordinal LIMIT 8 LOOP
   SELECT * INTO ref FROM runtime_library_references WHERE execution_id=e.id AND document_id=hit.document_id;
   IF ref.execution_id IS NULL THEN
    SELECT coalesce(max(ordinal),0)+1 INTO next_ordinal FROM runtime_library_references WHERE execution_id=e.id;
    IF next_ordinal>29 THEN CONTINUE; END IF;
    INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal,origin)
     VALUES(e.id,p_actor_id,hit.document_id,hit.content_version,next_ordinal,'retrieved') RETURNING * INTO ref;
   ELSIF ref.content_version<>hit.content_version THEN CONTINUE;
   END IF;
   hits:=hits||jsonb_build_array(jsonb_build_object('ref','doc-'||ref.ordinal,'documentId',ref.document_id,'version',ref.content_version,
    'title',left(coalesce(hit.filename,''),160),'segment',hit.ordinal+1,'segmentTitle',left(hit.title,160),'pageNumber',hit.page_number,
    'excerpt',substr(hit.body,greatest(1,coalesce(hit.pos,1)-80),240)));
  END LOOP;
  -- Keep the result small: drop the weakest hits until it fits 6,000 bytes.
  result:=jsonb_build_object('kind','library_search','terms',to_jsonb(terms),'hits',hits);
  WHILE octet_length(to_jsonb(result::text)::text)>6000 AND jsonb_array_length(result->'hits')>1 LOOP
   result:=jsonb_set(result,'{hits}',(result->'hits')-(jsonb_array_length(result->'hits')-1));
  END LOOP;
  IF used+octet_length(to_jsonb(result::text)::text)>65536 THEN RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
  RETURN result;
 END IF;
 m:=regexp_match(p_query,'^doc-([1-9]|1[0-9]|2[0-9])(?:/(page|segment)-([1-9][0-9]{0,4}))?$');
 IF m IS NULL THEN RETURN jsonb_build_object('kind','unavailable','reason','unknown_query'); END IF;
 SELECT * INTO ref FROM runtime_library_references WHERE execution_id=e.id AND ordinal=m[1]::smallint;
 IF ref.execution_id IS NULL THEN RETURN jsonb_build_object('kind','unavailable','reason','unknown_query'); END IF;

 SELECT * INTO d FROM library_documents WHERE id=ref.document_id AND actor_id=p_actor_id FOR SHARE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status<>'ready' THEN
  RETURN jsonb_build_object('kind','unavailable','reason','source_deleted','ref','doc-'||ref.ordinal); END IF;
 IF d.content_version<>ref.content_version THEN
  RETURN jsonb_build_object('kind','unavailable','reason','source_changed','ref','doc-'||ref.ordinal); END IF;
 IF m[2] IS NULL OR m[2]='page' THEN
  page:=coalesce(m[3]::integer,1);
  SELECT count(*) INTO total FROM library_document_segments WHERE document_id=d.id;
  SELECT jsonb_build_object('kind','library_directory','ref','doc-'||ref.ordinal,'documentId',d.id,
   'version',d.content_version,'page',page,'pages',greatest(1,(total+24)/25),'total',total,
   'entries',coalesce(jsonb_agg(jsonb_build_object('segment',s.ordinal+1,'title',left(s.title,160),
    'pageNumber',s.page_number) ORDER BY s.ordinal),'[]'))
  INTO result FROM (SELECT * FROM library_document_segments WHERE document_id=d.id
   ORDER BY ordinal OFFSET (page-1)*25 LIMIT 25) s;
 ELSE
  SELECT * INTO seg FROM library_document_segments WHERE document_id=d.id AND ordinal=m[3]::integer-1;
  IF seg.document_id IS NULL THEN RETURN jsonb_build_object('kind','unavailable','reason','unknown_query'); END IF;
  -- Segments are at most 8,192 bytes; heavily escaped text is shortened so the result stays bounded.
  FOREACH cap IN ARRAY ARRAY[8192,4000,2000] LOOP
   result:=jsonb_build_object('kind','library_segment','ref','doc-'||ref.ordinal,'documentId',d.id,
    'version',d.content_version,'segment',seg.ordinal+1,'title',left(seg.title,160),'pageNumber',seg.page_number,
    'body',left(seg.body,cap),'truncated',char_length(seg.body)>cap);
   EXIT WHEN octet_length(to_jsonb(result::text)::text)<=16384;
  END LOOP;
 END IF;
 IF octet_length(to_jsonb(result::text)::text)>16384 THEN
  RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
 IF used+octet_length(to_jsonb(result::text)::text)>65536 THEN RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_library_visible(p_actor_id uuid,p_execution_id uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_result->>'kind'='library_index' THEN
  RETURN EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
   AND e.erased_at IS NULL AND e.content_deleted_at IS NULL)
   AND EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=p_execution_id AND r.actor_id=p_actor_id)
   AND NOT EXISTS(SELECT 1 FROM runtime_library_references r LEFT JOIN library_documents d
    ON d.id=r.document_id AND d.actor_id=r.actor_id
    WHERE r.execution_id=p_execution_id AND (r.actor_id<>p_actor_id OR d.id IS NULL OR d.deleted_at IS NOT NULL
     OR d.status<>'ready' OR d.content_version<>r.content_version));
 END IF;
 IF p_result->>'kind'='library_search' THEN
  RETURN EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
   AND e.erased_at IS NULL AND e.content_deleted_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_result->'hits','[]'::jsonb)) h
    WHERE NOT EXISTS(SELECT 1 FROM runtime_library_references r JOIN library_documents d ON d.id=r.document_id AND d.actor_id=r.actor_id
     WHERE r.execution_id=p_execution_id AND r.actor_id=p_actor_id AND r.document_id::text=h->>'documentId'
      AND r.content_version::text=h->>'version' AND d.deleted_at IS NULL AND d.status='ready' AND d.content_version=r.content_version));
 END IF;
 RETURN EXISTS(SELECT 1 FROM runtime_executions e
  JOIN runtime_library_references r ON r.execution_id=e.id AND r.actor_id=e.actor_id
  JOIN library_documents d ON d.id=r.document_id AND d.actor_id=r.actor_id
  WHERE e.id=p_execution_id AND e.actor_id=p_actor_id AND e.erased_at IS NULL AND e.content_deleted_at IS NULL
   AND r.document_id::text=p_result->>'documentId' AND r.content_version::text=p_result->>'version'
   AND d.deleted_at IS NULL AND d.status='ready' AND d.content_version=r.content_version);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_library_tool_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a uuid; d library_documents; reads integer; used bigint;
BEGIN
 IF coalesce(NEW.result->>'kind','') NOT IN ('library_index','library_directory','library_segment','library_search') THEN RETURN NEW; END IF;
 -- runtime_tool already owns this lock; also serialize direct trigger writes on the same execution.
 SELECT actor_id INTO a FROM runtime_executions WHERE id=NEW.execution_id FOR NO KEY UPDATE;
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(t.result::text)::text)),0) INTO reads,used
  FROM runtime_tool_calls t WHERE t.execution_id=NEW.execution_id AND t.call_id<>NEW.call_id
   AND t.name='read_source' AND t.result->>'kind' IN ('library_index','library_directory','library_segment','library_search');
 IF reads>=8 OR octet_length(to_jsonb(NEW.result::text)::text)>16384
  OR used+octet_length(to_jsonb(NEW.result::text)::text)>65536 THEN
  NEW.result:=jsonb_build_object('kind','unavailable','reason','read_limit');RETURN NEW;
 END IF;
 IF NEW.result->>'kind'='library_search' THEN
  -- Lock every hit document, then recheck: a deletion or version change that won the race is never stored.
  PERFORM x.id FROM library_documents x WHERE x.actor_id=a AND x.id IN (
   SELECT (h->>'documentId')::uuid FROM jsonb_array_elements(coalesce(NEW.result->'hits','[]')) h) ORDER BY x.id FOR SHARE OF x;
  IF NOT runtime_library_visible(a,NEW.execution_id,NEW.result) THEN
   NEW.result:=jsonb_build_object('kind','unavailable','reason','source_deleted');
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.result->>'kind'='library_index' THEN
  PERFORM x.id FROM library_documents x JOIN runtime_library_references r ON r.document_id=x.id AND r.actor_id=x.actor_id
   WHERE r.execution_id=NEW.execution_id ORDER BY x.id FOR SHARE OF x;
  IF NOT runtime_library_visible(a,NEW.execution_id,NEW.result) THEN
   NEW.result:=jsonb_build_object('kind','unavailable','reason','source_deleted');
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO d FROM library_documents WHERE id::text=NEW.result->>'documentId' AND actor_id=a FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=NEW.execution_id
  AND r.document_id::text=NEW.result->>'documentId' AND r.content_version::text=NEW.result->>'version')
 THEN RAISE EXCEPTION 'LIB_REFERENCE_REVOKED'; END IF;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status<>'ready' OR d.content_version::text<>NEW.result->>'version' THEN
  NEW.result:=jsonb_build_object('kind','unavailable','reason','source_deleted');
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_library_propagate(p_actor_id uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target record; e runtime_executions; b bill2_runs; stamp timestamptz:=clock_timestamp(); scrub jsonb;
 done integer:=0; waiting integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 FOR target IN SELECT DISTINCT r.execution_id FROM runtime_library_references r
  WHERE r.propagated_at IS NULL AND (p_actor_id IS NULL OR r.actor_id=p_actor_id)
   AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.id=r.document_id AND d.deleted_at IS NULL AND d.status<>'deleting')
  ORDER BY r.execution_id LIMIT p_limit LOOP
  -- Lock order of content_erasure_confirm: profile (share), execution, billing run; never wait, retry later.
  BEGIN
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
   PERFORM id FROM profiles WHERE id=e.actor_id FOR SHARE NOWAIT;
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id FOR UPDATE NOWAIT;
   -- Content erasure of the answer or conversation already removed every copy in this execution.
   IF e.erased_at IS NOT NULL OR e.content_deleted_at IS NOT NULL THEN
    UPDATE runtime_library_references SET propagated_at=stamp WHERE execution_id=e.id AND propagated_at IS NULL;
    done:=done+1; CONTINUE;
   END IF;
   IF e.state NOT IN ('completed','cancelled') THEN
    UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted') WHERE id=e.id;
    waiting:=waiting+1; CONTINUE;
   END IF;
   IF e.billing_run_id IS NOT NULL THEN
    SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE NOWAIT;
   END IF;
   UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp
    WHERE execution_id=e.id AND erased_at IS NULL AND name='read_source'
     AND result->>'kind' IN ('library_index','library_directory','library_segment','library_search');
   UPDATE runtime_session_history SET item=NULL,erased_at=stamp
    WHERE execution_id=e.id AND erased_at IS NULL AND item->>'role' IS DISTINCT FROM 'user';
   UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=e.id AND erased_at IS NULL;
   IF e.billing_run_id IS NOT NULL THEN
    IF NOT b.closed THEN waiting:=waiting+1; CONTINUE; END IF;
    -- The 0201 content marker on the closed run is the existing authority to project its receipts to money
    -- fields. It marks receipt copies only: the execution keeps its shown answer and no amount changes.
    UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=b.id AND content_deleted_at IS NULL;
    IF NOT coalesce(content_erasure_financial_allowed(e.actor_id,coalesce(b.pre_deduct_id,b.id)),false) THEN
     waiting:=waiting+1; CONTINUE;
    END IF;
    scrub:=account_erasure_scrub_receipts(e.actor_id,b.id,100);
    -- Rows that cannot be projected stay for the existing manual financial review.
    IF (scrub->>'remaining')::bigint>(scrub->>'manualReview')::bigint THEN waiting:=waiting+1; CONTINUE; END IF;
   END IF;
   UPDATE runtime_library_references SET propagated_at=stamp WHERE execution_id=e.id AND propagated_at IS NULL;
   done:=done+1;
  EXCEPTION WHEN lock_not_available THEN
   waiting:=waiting+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('processed',done,'waiting',waiting);
END $$;


REVOKE ALL ON FUNCTION public.runtime_library_read(uuid,uuid,text),public.runtime_library_visible(uuid,uuid,jsonb),
 public.runtime_library_tool_guard(),public.runtime_library_propagate(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_library_read(uuid,uuid,text),public.runtime_library_visible(uuid,uuid,jsonb),
 public.runtime_library_propagate(uuid,integer) TO service_role;
COMMIT;
