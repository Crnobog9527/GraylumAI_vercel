-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-AUTO-CONTEXT: staging acceptance found that a retrieving free chat which listed the library ("library") before any
-- search hit got {"kind":"unavailable","reason":"source_deleted"}, and an index with no documents would make the model say
-- "the library is empty" although the user has documents (0302 listed only @ references and retrieved hits).
-- Fix, two parts:
--  (1) runtime_library_read('') in a retrieving execution (payload libraryRetrieval=true) adds the real directory of the
--      caller's ready documents that are not yet referenced: file names only (<=20, 160 characters each), directoryTotal and a
--      hint to use search:<words>. It freezes nothing, reads no body, and is not counted as a reference.
--  (2) runtime_library_visible: an execution frozen with libraryRetrieval may have an index with no references; every
--      existing reference must still be live. The directory is a point-in-time listing of file names, like a title copied
--      into an @ reference snapshot; erasure of a deleted document's file name from a stored listing is not tracked.
-- Repeatable, no table, no data. Rollback: re-run 0302's definitions of runtime_library_read and runtime_library_visible.
BEGIN;
DO $$ DECLARE src text;anchor text;
BEGIN
 src:=pg_get_functiondef('public.runtime_library_read(uuid,uuid,text)'::regprocedure);
 IF position('-- 0304 directory' IN src)=0 THEN
  anchor:=$x$  IF octet_length(to_jsonb(result::text)::text)>16384
   OR used+octet_length(to_jsonb(result::text)::text)>65536 THEN$x$;
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: runtime_library_read 0304'; END IF;
  src:=replace(src,anchor,$x$  -- 0304 directory: a retrieving free chat sees the real list of its ready documents (names only, nothing frozen).
  IF coalesce(e.payload->>'libraryRetrieval','')='true' THEN
   SELECT result||jsonb_build_object('directory',coalesce(jsonb_agg(jsonb_build_object('title',left(q.filename,160)) ORDER BY q.filename,q.id)
     FILTER (WHERE q.n<=20),'[]'::jsonb),'directoryTotal',count(*),
    'hint','Only these file names are listed. Use search:<words> to find and read a document; this list has no content.')
   INTO result FROM (SELECT x.id,x.filename,row_number() OVER (ORDER BY x.filename,x.id) n FROM library_documents x
    WHERE x.actor_id=p_actor_id AND x.deleted_at IS NULL AND x.status='ready'
     AND NOT EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=e.id AND r.document_id=x.id)) q;
  END IF;
$x$||anchor);
  EXECUTE src;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_library_visible(p_actor_id uuid,p_execution_id uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_result->>'kind'='library_index' THEN
  RETURN EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
   AND e.erased_at IS NULL AND e.content_deleted_at IS NULL)
   -- A retrieving free chat that has found nothing yet has no reference: its (empty) index is still visible (this was a bug:
   -- the empty index of 0302 was stored as source_deleted). An @-referencing execution still needs at least one reference.
   AND (EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=p_execution_id AND r.actor_id=p_actor_id)
    OR EXISTS(SELECT 1 FROM runtime_executions rx WHERE rx.id=p_execution_id AND rx.actor_id=p_actor_id
     AND coalesce(rx.payload->>'libraryRetrieval','')='true'))
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

REVOKE ALL ON FUNCTION public.runtime_library_visible(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_library_visible(uuid,uuid,jsonb) TO service_role;
COMMIT;
