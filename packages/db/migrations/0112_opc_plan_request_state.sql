/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Owner-locked correction: a local retained record cannot prove whether an
-- earlier first-week generation request was ever admitted or dispatched, and it
-- certainly cannot prove a zero cost. Expose only that request's own
-- server-side identity and lifecycle so the page can offer its recovery entry
-- without claiming a cancellation the server never recorded.
--
-- Additive and backward compatible: one new read-only helper, no table, no
-- signature change, no write and no model/provider hook. It returns identity and
-- state only; never a body, receipt, credential or private scope material.
BEGIN;
CREATE OR REPLACE FUNCTION opc_plan_request_state(p_actor_id uuid,p_draft_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;e runtime_executions;m runtime_scope_material;t opc_turns;b bill2_runs;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'OPC_INPUT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=d.session_id AND request_id=p_request_id;
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND session_id=d.session_id AND request_id=p_request_id;
 SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=p_request_id;
 IF e.billing_run_id IS NOT NULL THEN SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id;END IF;
 RETURN jsonb_build_object(
  'requestId',p_request_id,
  'sessionId',d.session_id,
  -- `admitted` is only true when the server itself recorded this request id.
  'admitted',(m.request_id IS NOT NULL OR e.id IS NOT NULL),
  'materialRevision',m.revision,
  'materialRevoked',coalesce(m.revoked,false),
  'turnPurpose',t.purpose,
  'executionId',e.id,
  'state',e.state,
  'hasResult',(e.result IS NOT NULL),
  'financialClosed',coalesce(b.closed,false));
END $$;
REVOKE ALL ON FUNCTION opc_plan_request_state(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_plan_request_state(uuid,uuid,uuid) TO service_role;
COMMIT;
