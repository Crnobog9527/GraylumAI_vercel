-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-100 C5 (number assigned by control; provisional until then): the access half of runtime_view on its own. A
-- conversation refresh that the host can answer from memory (the session is idle and nothing was written since the
-- last read) still asks this first, so "may this user see this session" is decided by the database on every refresh.
-- It runs the same three checks as the start of runtime_view (active account, session owned by the actor, scope
-- allowed) and raises the same RUNTIME_SCOPE_DENIED, but reads no execution, payload or billing row.
-- Returns {sessionId, activeExecution}. Read only. Repeatable: CREATE OR REPLACE. Rollback: DROP FUNCTION.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.runtime_view_access(p_actor_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 RETURN jsonb_build_object('sessionId',s.id,'activeExecution',s.active_execution);
END $$;
REVOKE ALL ON FUNCTION public.runtime_view_access(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_view_access(uuid,uuid) TO service_role;
COMMIT;
