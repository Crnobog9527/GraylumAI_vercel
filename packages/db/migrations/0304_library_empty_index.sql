-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-AUTO-CONTEXT: staging acceptance found that a retrieving free chat which listed the library ("library") before any
-- search hit got {"kind":"unavailable","reason":"source_deleted"}, and an index with no documents would make the model say
-- "the library is empty" although the user has documents (0302 listed only @ references and retrieved hits).
-- Fix, two parts:
--  (1) runtime_library_read('') in a retrieving execution (payload libraryRetrieval=true) first registers the caller's first
--      ready documents (by file name, at most 10 in total) as 'retrieved' references, exactly like search hits (frozen at their
--      current version, doc-N, under the document lock), then lists them as before; it adds directoryTotal (how many ready
--      documents the user has) and a hint to use search:<words> for the rest. Because they are ordinary references,
--      deletion hides the stored listing, removes it from stored answers and replays (0302's visibility and cleanup).
--  (2) runtime_library_visible: an execution frozen with libraryRetrieval may have an index with no references (user with an
--      empty library); every existing reference must still be live.
-- Repeatable, no table, no data. Rollback: re-run 0302's definitions of runtime_library_read and runtime_library_visible.
BEGIN;
DO $$ DECLARE src text;a1 text;a2 text;
BEGIN
 src:=pg_get_functiondef('public.runtime_library_read(uuid,uuid,text)'::regprocedure);
 IF position('-- 0304 directory' IN src)=0 THEN
  a1:=$x$ IF coalesce(p_query,'')='' THEN
  PERFORM document.id FROM library_documents document$x$;
  a2:=$x$  IF octet_length(to_jsonb(result::text)::text)>16384
   OR used+octet_length(to_jsonb(result::text)::text)>65536 THEN$x$;
  IF array_length(string_to_array(src,a1),1)<>2 OR array_length(string_to_array(src,a2),1)<>2 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: runtime_library_read 0304'; END IF;
  src:=replace(src,a1,$x$ IF coalesce(p_query,'')='' THEN
  -- 0304 directory: a retrieving free chat lists its first ready documents (10 at most, like search hits: frozen, doc-N).
  IF coalesce(e.payload->>'libraryRetrieval','')='true' THEN
   -- Pick by file name, lock by id (the order every other path uses), so a bulk delete cannot deadlock with this.
   FOR hit IN SELECT x.id document_id,x.content_version FROM library_documents x
    WHERE x.id IN (SELECT y.id FROM library_documents y
      WHERE y.actor_id=p_actor_id AND y.kind='document' AND y.deleted_at IS NULL AND y.status='ready'
       AND NOT EXISTS(SELECT 1 FROM runtime_library_references r WHERE r.execution_id=e.id AND r.document_id=y.id)
      ORDER BY y.filename,y.id LIMIT greatest(0,10-(SELECT count(*) FROM runtime_library_references r WHERE r.execution_id=e.id)))
     AND x.deleted_at IS NULL AND x.status='ready'
    ORDER BY x.id FOR SHARE OF x LOOP
    SELECT coalesce(max(ordinal),0)+1 INTO next_ordinal FROM runtime_library_references WHERE execution_id=e.id;
    EXIT WHEN next_ordinal>29;
    INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal,origin)
     VALUES(e.id,p_actor_id,hit.document_id,hit.content_version,next_ordinal,'retrieved');
   END LOOP;
  END IF;
  PERFORM document.id FROM library_documents document$x$);
  src:=replace(src,a2,$x$  IF coalesce(e.payload->>'libraryRetrieval','')='true' THEN
   SELECT result||jsonb_build_object('directoryTotal',count(*),
    'hint','Up to 10 documents are listed above. Use search:<words> to find and read any other document.')
   INTO result FROM library_documents x WHERE x.actor_id=p_actor_id AND x.kind='document' AND x.deleted_at IS NULL AND x.status='ready';
  END IF;
$x$||a2);
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
