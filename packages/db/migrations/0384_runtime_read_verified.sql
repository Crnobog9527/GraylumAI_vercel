/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- DB-100 line Q (C3). Number 0384 assigned by the controller.
-- Owner 2026-10-25: "同一轮回复里读数据不重复查删除、写之前照查". During one running reply the two read RPCs
-- runtime_response (before and after every model call) and runtime_session_items 'read' walked the execution's whole
-- frozen history lineage again (runtime_billing_allowed: every ancestor's permission chain under FOR SHARE locks),
-- although the same reply had just checked it: runtime_admit froze the candidate history only after checking it, and
-- runtime_execution checks the whole lineage on every action, including the 'begin' / 'payg_resume' that put the
-- execution into its running window. The locks also made these reads commit like writes.
--
-- Boundary: a read skips the lineage walk only while runtime_read_verified holds: the execution is 'running', is its
-- session's active execution, its v2 run is open and not paused, and the dispatch window that the checked
-- 'begin' / 'payg_resume' wrote (265 s) has not passed. Outside that window both reads run exactly as before.
-- Every read still checks, every time: the account (bill2_actor), the actor owning the execution and the session,
-- the session scope (bill2_scope_allowed), and deletion of the conversation or of this execution
-- (content_erasure_runtime_check, D7). The fast history read also drops any history turn that was itself deleted or
-- marked unavailable. What a read may now miss until the next write is a deeper change found only by walking the
-- lineage (for example a library source or Skill revision revoked mid-reply). Every write path is unchanged:
-- runtime_session_items 'freeze' / 'append', runtime_execution, bill2_* all still run runtime_billing_allowed, so the
-- next write of the same reply after such a change is refused. runtime_session_context is not changed: it runs before
-- the execution exists, so no check of this reply precedes it.
--
-- Repeatable: each body is patched only when its marker is absent; the helper uses CREATE OR REPLACE.
-- Compatibility: signatures, results and error codes are unchanged; old code calls the same RPCs.
-- Rollback: restore the two original lines shown in the replacements below (by the same text patch) and drop
-- runtime_read_verified; no data changes.
BEGIN;

-- No locks, no writes: plain reads of the three rows the reply already owns.
CREATE OR REPLACE FUNCTION public.runtime_read_verified(a uuid,eid uuid) RETURNS boolean
LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM runtime_executions e
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=a
  JOIN bill2_runs b ON b.id=e.billing_run_id AND b.actor_id=a
  WHERE e.id=eid AND e.actor_id=a AND e.state='running' AND s.active_execution=e.id
   AND e.unavailable_reason IS NULL AND e.erased_at IS NULL AND e.content_deleted_at IS NULL
   AND s.erased_at IS NULL AND s.content_deleted_at IS NULL
   AND b.contract_version='bill2.v2' AND NOT b.closed AND NOT b.cancel_requested AND NOT b.conflict
   AND b.paused_reason IS NULL AND b.runtime_dispatch_deadline>clock_timestamp())
$$;
REVOKE ALL ON FUNCTION public.runtime_read_verified(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$ DECLARE d text;a1 text;
BEGIN
 d:=pg_get_functiondef('public.runtime_response(uuid,uuid,integer,text)'::regprocedure);
 IF position('-- DB-100 C3 read check' IN d)=0 THEN
  a1:=$a$ PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
$a$;
  IF array_length(string_to_array(d,a1),1)<>2 THEN RAISE EXCEPTION 'DB100_READ_CHECK_SOURCE_MISMATCH: runtime_response';END IF;
  EXECUTE replace(d,a1,$b$ -- DB-100 C3 read check (0384): this running reply already checked its lineage.
 IF NOT runtime_read_verified(p_actor_id,e.id) THEN
  PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
 END IF;
$b$);
 END IF;

 d:=pg_get_functiondef('public.runtime_session_items(uuid,uuid,uuid,text,jsonb,integer,integer)'::regprocedure);
 IF position('-- DB-100 C3 read check' IN d)=0 THEN
  a1:=$a$ PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
$a$;
  IF array_length(string_to_array(d,a1),1)<>2 THEN RAISE EXCEPTION 'DB100_READ_CHECK_SOURCE_MISMATCH: runtime_session_items';END IF;
  -- Same answer as the 'read' branch below for history admit checked: no session lock, no lineage walk;
  -- a turn deleted or marked unavailable since then is still left out.
  EXECUTE replace(d,a1,$b$ PERFORM bill2_actor(p_actor_id);
 -- DB-100 C3 read check (0384): this running reply already checked its lineage and admit its history.
 IF p_action='read' AND runtime_read_verified(p_actor_id,p_execution_id) THEN
  SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
  SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=s.id AND actor_id=p_actor_id;
  IF s.id IS NULL OR e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SESSION_DENIED';END IF;
  IF p_limit<0 THEN RAISE EXCEPTION 'RUNTIME_SESSION_LIMIT';END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY revision),'[]') INTO answer FROM (
   SELECT jsonb_build_object('revision',h.revision,'item',h.item) item,h.revision
   FROM runtime_session_history h JOIN runtime_executions x ON x.id=h.execution_id
   WHERE h.session_id=s.id AND h.revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT h.internal_control
    AND x.actor_id=p_actor_id AND x.unavailable_reason IS NULL AND x.erased_at IS NULL AND x.content_deleted_at IS NULL
   ORDER BY h.revision DESC LIMIT p_limit
  ) x;
  RETURN answer;
 END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
$b$);
 END IF;
END $patch$;
COMMIT;
