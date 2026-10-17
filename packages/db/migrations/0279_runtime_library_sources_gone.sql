-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-4b (LIB_DOCS_PLAN 6.1, 7; #981 acceptance): which of the given executions froze a library reference whose
-- document is now deleted or being deleted -- the same test as the 0262 runtime_execution entry check. A newer content
-- version is not a deletion (#1022 decision C): that round stays valid and is shown. Read-only (no locks, no writes):
-- the stream fence and runtime.view use it to stop showing a round at once, before library cleanup runs, without the
-- runtime_execution entry check (which may pause a running round). An execution without references is never returned,
-- so ordinary rounds are unaffected. Number 0279 assigned by control. Repeatable: CREATE OR REPLACE.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.runtime_library_sources_gone(p_actor_id uuid,p_execution_ids uuid[])
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_execution_ids IS NULL OR cardinality(p_execution_ids)>500 THEN RAISE EXCEPTION 'RUNTIME_VIEW_DENIED'; END IF;
 RETURN QUERY SELECT DISTINCT r.execution_id FROM runtime_library_references r
  LEFT JOIN library_documents d ON d.id=r.document_id AND d.actor_id=r.actor_id
  WHERE r.actor_id=p_actor_id AND r.execution_id=ANY(p_execution_ids)
   AND (d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status='deleting');
END $$;
REVOKE ALL ON FUNCTION public.runtime_library_sources_gone(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_library_sources_gone(uuid,uuid[]) TO service_role;
COMMIT;
