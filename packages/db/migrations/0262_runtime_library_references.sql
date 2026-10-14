-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-4a (LIB_DOCS_PLAN sections 6, 6.1, 7): the agent reads library documents the user referenced.
-- Number 0262 assigned by control on 2026-10-14. Repeatable: IF NOT EXISTS, CREATE OR REPLACE, marked patches.
--
-- 1. A reference is frozen with the execution it belongs to: an AFTER INSERT trigger on runtime_executions,
--    so it commits or rolls back with the admission (a refused reference refuses the whole turn, unbilled).
--    It fires only when the frozen payload carries libraryReferences; every other admission skips it.
-- 2. read_source reads only those frozen documents at their frozen version, bounded per read and per execution.
--    Reads share-lock the document row and library_delete takes it exclusively, so a read and a deletion
--    are strictly ordered. Storing a read result re-checks the document under the same lock.
-- 3. After a deletion, cleanup removes the document's copies from finished executions that read it:
--    frozen reads, their session history and, once the billing run is closed, receipt bodies through the
--    existing financial projection. Amounts are never touched; answers already shown stay (D7).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.runtime_library_references (
 execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
 actor_id uuid NOT NULL REFERENCES public.profiles(id),
 -- No foreign key: the document row is removed after its deletion completes; this row then drives cleanup.
 document_id uuid NOT NULL,
 content_version integer NOT NULL CHECK(content_version>0),
 ordinal smallint NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
 -- Set once every copy of a deleted document in this execution is gone.
 propagated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(execution_id,document_id), UNIQUE(execution_id,ordinal)
);
CREATE INDEX IF NOT EXISTS runtime_library_references_document ON public.runtime_library_references(document_id);
CREATE INDEX IF NOT EXISTS runtime_library_references_pending ON public.runtime_library_references(actor_id)
 WHERE propagated_at IS NULL;
ALTER TABLE public.runtime_library_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_library_references FROM PUBLIC,anon,authenticated,service_role;

-- Up to five distinct documents, each the caller's own ready text document at its current version.
CREATE OR REPLACE FUNCTION public.runtime_library_references_freeze() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE refs jsonb:=NEW.payload->'libraryReferences'; item jsonb; n integer:=0; d library_documents; did uuid; ver integer;
BEGIN
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs) NOT BETWEEN 1 AND 5
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE jsonb_typeof(r) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(r))<>2 OR jsonb_typeof(r->'documentId') IS DISTINCT FROM 'string'
   OR (r->>'documentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(r->'version') IS DISTINCT FROM 'number' OR (r->>'version') !~ '^[1-9][0-9]{0,8}$')
  OR (SELECT count(DISTINCT lower(r->>'documentId')) FROM jsonb_array_elements(refs) r)<>jsonb_array_length(refs)
 THEN RAISE EXCEPTION 'LIB_REFERENCE_INVALID'; END IF;
 PERFORM bill2_actor(NEW.actor_id);
 -- Same row lock as library_document_read; library_delete holds it exclusively. Id order avoids deadlocks.
 PERFORM id FROM library_documents WHERE actor_id=NEW.actor_id
  AND id IN (SELECT (r->>'documentId')::uuid FROM jsonb_array_elements(refs) r) ORDER BY id FOR SHARE;
 FOR item IN SELECT value FROM jsonb_array_elements(refs) LOOP
  n:=n+1; did:=(item->>'documentId')::uuid; ver:=(item->>'version')::integer;
  SELECT * INTO d FROM library_documents WHERE id=did AND actor_id=NEW.actor_id;
  IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status IN ('deleting','failed') OR d.kind<>'document'
   THEN RAISE EXCEPTION 'LIB_REFERENCE_NOT_FOUND'; END IF;
  IF d.status<>'ready' OR NOT EXISTS(SELECT 1 FROM library_document_segments s WHERE s.document_id=did)
   THEN RAISE EXCEPTION 'LIB_REFERENCE_NOT_READY'; END IF;
  IF d.content_version<>ver THEN RAISE EXCEPTION 'LIB_REFERENCE_STALE'; END IF;
  INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal)
  VALUES(NEW.id,NEW.actor_id,did,ver,n);
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS runtime_library_references_freeze ON public.runtime_executions;
CREATE TRIGGER runtime_library_references_freeze AFTER INSERT ON public.runtime_executions
 FOR EACH ROW WHEN (NEW.payload ? 'libraryReferences') EXECUTE FUNCTION public.runtime_library_references_freeze();

-- One read for a running execution. query: '' lists the references; 'doc-N' or 'doc-N/page-P' lists 25
-- segment titles per page; 'doc-N/segment-S' returns one segment. A deleted or changed document answers
-- source_deleted / source_changed instead of content. At most 8 reads and 65,536 bytes per execution;
-- each result stays within 16,384 bytes even as an escaped string.
CREATE OR REPLACE FUNCTION public.runtime_library_read(p_actor_id uuid,p_execution_id uuid,p_query text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions; ref runtime_library_references; d library_documents; m text[]; result jsonb;
 page integer; total integer; used bigint; reads integer; cap integer; seg library_document_segments;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL OR e.state<>'running' OR e.erased_at IS NOT NULL OR e.content_deleted_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=e.id)
 THEN RAISE EXCEPTION 'LIB_REFERENCE_READ_DENIED'; END IF;
 IF coalesce(p_query,'')='' THEN
  SELECT jsonb_build_object('kind','library_index','documents',coalesce(jsonb_agg(jsonb_build_object(
    'ref','doc-'||r.ordinal,'documentId',r.document_id,'version',r.content_version,
    'title',CASE WHEN x.id IS NULL OR x.deleted_at IS NOT NULL OR x.status<>'ready' THEN NULL ELSE left(x.filename,160) END,
    'available',x.id IS NOT NULL AND x.deleted_at IS NULL AND x.status='ready' AND x.content_version=r.content_version,
    'segments',(SELECT count(*) FROM library_document_segments s WHERE s.document_id=x.id AND x.status='ready'))
   ORDER BY r.ordinal),'[]'))
  INTO result FROM runtime_library_references r LEFT JOIN library_documents x ON x.id=r.document_id AND x.actor_id=r.actor_id
  WHERE r.execution_id=e.id;
  RETURN result;
 END IF;
 m:=regexp_match(p_query,'^doc-([1-5])(?:/(page|segment)-([1-9][0-9]{0,4}))?$');
 IF m IS NULL THEN RETURN jsonb_build_object('kind','unavailable','reason','unknown_query'); END IF;
 SELECT * INTO ref FROM runtime_library_references WHERE execution_id=e.id AND ordinal=m[1]::smallint;
 IF ref.execution_id IS NULL THEN RETURN jsonb_build_object('kind','unavailable','reason','unknown_query'); END IF;
 SELECT count(*),coalesce(sum(octet_length(t.result::text)),0) INTO reads,used FROM runtime_tool_calls t
  WHERE t.execution_id=e.id AND t.name='read_source' AND t.result->>'kind' IN ('library_directory','library_segment');
 IF reads>=8 OR used>=65536 THEN RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
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
 IF octet_length(to_jsonb(result::text)::text)>16384 THEN RAISE EXCEPTION 'LIB_REFERENCE_RESULT_TOO_LARGE'; END IF;
 IF used+octet_length(result::text)>65536 THEN RETURN jsonb_build_object('kind','unavailable','reason','read_limit'); END IF;
 RETURN result;
END $$;

-- Before a frozen read is replayed: is its document still referenced, live and at the frozen version?
CREATE OR REPLACE FUNCTION public.runtime_library_visible(p_actor_id uuid,p_execution_id uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN EXISTS(SELECT 1 FROM runtime_executions e
  JOIN runtime_library_references r ON r.execution_id=e.id AND r.actor_id=e.actor_id
  JOIN library_documents d ON d.id=r.document_id AND d.actor_id=r.actor_id
  WHERE e.id=p_execution_id AND e.actor_id=p_actor_id AND e.erased_at IS NULL AND e.content_deleted_at IS NULL
   AND r.document_id::text=p_result->>'documentId' AND r.content_version::text=p_result->>'version'
   AND d.deleted_at IS NULL AND d.status='ready' AND d.content_version=r.content_version);
END $$;

-- Storing a document read re-checks its document under the read lock: a read that raced a committed deletion
-- (or a version change) is never saved, and a saved read is always found by the deletion cleanup below.
CREATE OR REPLACE FUNCTION public.runtime_library_tool_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a uuid; d library_documents;
BEGIN
 IF coalesce(NEW.result->>'kind','') NOT IN ('library_directory','library_segment') THEN RETURN NEW; END IF;
 SELECT actor_id INTO a FROM runtime_executions WHERE id=NEW.execution_id;
 SELECT * INTO d FROM library_documents WHERE id::text=NEW.result->>'documentId' AND actor_id=a FOR SHARE;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status<>'ready' OR d.content_version::text<>NEW.result->>'version'
  OR NOT EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=NEW.execution_id
   AND r.document_id=d.id AND r.content_version=d.content_version)
 THEN RAISE EXCEPTION 'LIB_REFERENCE_REVOKED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_library_tool_guard ON public.runtime_tool_calls;
CREATE TRIGGER runtime_library_tool_guard BEFORE INSERT OR UPDATE OF result ON public.runtime_tool_calls
 FOR EACH ROW WHEN (NEW.name='read_source' AND NEW.result IS NOT NULL) EXECUTE FUNCTION public.runtime_library_tool_guard();

-- Deletion cleanup (called by library cleanup; p_actor_id NULL = every account). For finished executions that
-- referenced a document now deleting or gone: erase their frozen document reads and non-user session history
-- through the existing erasure allow-lists, and once the billing run is closed project its receipts to their
-- financial fields with account_erasure_scrub_receipts. Running executions wait: their reads are already
-- refused. Amounts and the shown answer are untouched.
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
   IF e.state NOT IN ('completed','cancelled') THEN waiting:=waiting+1; CONTINUE; END IF;
   IF e.billing_run_id IS NOT NULL THEN
    SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE NOWAIT;
   END IF;
   UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp
    WHERE execution_id=e.id AND erased_at IS NULL AND name='read_source'
     AND result->>'kind' IN ('library_index','library_directory','library_segment');
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

-- Account erasure: the reference rows hold no content; prune them before their executions.
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n', E' CASE\n WHEN t=''runtime_library_references'' THEN RETURN (j->>''actor_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n', E' FOREACH t IN ARRAY ARRAY[\n  ''runtime_library_references'',\n')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- 0262 library references' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'LIBRARY_REFERENCE_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,needle,E' -- 0262 library references\n'||replacement);
  END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.runtime_library_references_freeze(),public.runtime_library_read(uuid,uuid,text),
 public.runtime_library_visible(uuid,uuid,jsonb),public.runtime_library_tool_guard(),
 public.runtime_library_propagate(uuid,integer),public.erasure_business_owner(text,jsonb),
 public.account_erasure_prune_business(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_library_read(uuid,uuid,text),public.runtime_library_visible(uuid,uuid,jsonb),
 public.runtime_library_propagate(uuid,integer) TO service_role;
COMMIT;
