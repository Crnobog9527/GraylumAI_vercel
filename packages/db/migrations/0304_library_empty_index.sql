-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-AUTO-CONTEXT: staging acceptance found that a retrieving free chat which listed the library ("library") before any
-- search hit got {"kind":"unavailable","reason":"source_deleted"}: runtime_library_read('') answers an index with no documents,
-- and runtime_library_visible (0302) required at least one reference for any library_index, so the tool guard replaced the
-- result with source_deleted and the model told the user it could not read the library.
-- Fix: an execution frozen with libraryRetrieval may have an empty index; every existing reference must still be live.
-- Repeatable (CREATE OR REPLACE), no table, no data. Rollback: re-run 0302's definition of runtime_library_visible.
BEGIN;
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
