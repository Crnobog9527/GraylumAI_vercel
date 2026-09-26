-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Separate the session execution slot from a stopped invocation's unresolved
-- financial reservation. No ledger, execution or history data is rewritten.
-- Existing service-role-only RPC signatures/grants are retained.
BEGIN;
CREATE OR REPLACE FUNCTION public.runtime_admit(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_payload jsonb,p_billing jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;history_candidates bigint[];
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_REQUEST_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF e.id IS NOT NULL THEN
  IF e.session_id<>s.id OR e.payload IS DISTINCT FROM p_payload
   OR (SELECT payload FROM bill2_runs WHERE id=e.billing_run_id) IS DISTINCT FROM p_billing THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
 END IF;
 IF s.scope->>'kind'='work_item' AND (p_payload->>'input' LIKE '[OPC_SCRIPT_V1]%' OR p_payload->>'input' LIKE '[OPC_VIDEO_PACKAGE_V1]%') AND opc_item_content_type((s.scope->>'workItemId')::uuid)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
 -- A stopped invocation may retain an unknown financial obligation. Its closed,
 -- cancelled BILL2 run cannot dispatch or append history. Under the existing
 -- session row lock, only replace the pointer; never settle or edit old evidence.
 IF s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution JOIN bill2_runs old_run
   ON old_run.id=old_execution.billing_run_id
   WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
    AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
    AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
    AND old_run.closed AND old_run.cancel_requested) THEN
  RAISE EXCEPTION 'RUNTIME_SESSION_BUSY';
 END IF;
 IF p_payload IS DISTINCT FROM p_billing->'input' THEN RAISE EXCEPTION 'RUNTIME_INPUT_BINDING_DENIED';END IF;
 IF p_payload->'scopeMaterial' IS NOT NULL AND p_payload->'scopeMaterial'->>'sessionId' IS DISTINCT FROM s.id::text THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_SCOPE';END IF;
 PERFORM runtime_context_allowed(p_actor_id,p_payload);
 IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 -- Share the original admission lock before checking for an existing BILL2 run.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 -- Never adopt an old isolated run, even with a matching public request ID.
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN RAISE EXCEPTION 'RUNTIME_LEGACY_RUN_DENIED';END IF;
 -- Freeze history membership and permission locks before bill2_prepare takes
 -- the profile balance lock. Dispatch takes revision permissions before profile.
 history_candidates:=ARRAY(
  SELECT revision FROM (SELECT h.revision,h.execution_id FROM runtime_session_history h
   WHERE h.session_id=s.id AND h.revision<=s.revision AND NOT h.internal_control
   ORDER BY h.revision DESC LIMIT CASE WHEN coalesce((p_payload->>'historyItems')::int,0)>0 THEN least(1000,(p_payload->>'historyItems')::int)+128 ELSE 0 END) bounded
  WHERE runtime_history_available(execution_id) ORDER BY revision);
 -- Runtime requires the administrator model binding; legacy unbound BILL2
 -- callers keep their existing package authorization contract.
 IF p_billing->>'revisionId' IS NOT NULL THEN
  PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
   AND skill_id=(p_billing->>'skillId')::uuid AND active AND model_id=(p_billing->>'modelId')::uuid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
 END IF;
 b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
 INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision)
 VALUES(p_actor_id,s.id,p_request_id,p_payload,(b->>'id')::uuid,s.revision) RETURNING * INTO e;
 UPDATE runtime_executions SET candidate_history=history_candidates WHERE id=e.id;
 UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
 UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_view(p_actor_id uuid,p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;items jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'request',CASE WHEN runtime_history_available(e.id) THEN (SELECT jsonb_strip_nulls(jsonb_build_object(
   'draftId',t.draft_id,'stepId',t.step_id,'purpose',t.purpose,'requestId',e.request_id,
   'input',e.payload->'request'->>'input',
   'questionId',CASE WHEN e.payload->'request'->'selection'->>'task' LIKE 'opc-question:%'
    THEN substring(e.payload->'request'->'selection'->>'task' from 14) END,
   'organizeAfter',CASE WHEN e.payload->'request'->'organizeAfter'='true'::jsonb THEN true END))
   FROM opc_turns t WHERE t.session_id=e.session_id AND t.request_id=e.request_id
    AND t.token::text=e.payload->>'opcTurnToken' AND t.purpose='mentor') ELSE NULL END,'createdAt',e.created_at,'state',e.state,
  'input',CASE WHEN runtime_history_available(e.id) THEN e.payload->>'input' ELSE NULL END,
  'body',CASE WHEN runtime_history_available(e.id) THEN e.result->>'body' ELSE NULL END,
  'primaryBody',CASE WHEN runtime_history_available(e.id) THEN e.primary_result->>'body' ELSE NULL END,
  'organizerComplete',e.result ? 'summary',
  'summary',CASE WHEN runtime_history_available(e.id) THEN e.result->>'summary' ELSE NULL END,
  'skillExecution',coalesce(e.payload->>'revisionId',(SELECT c->>'revisionId' FROM jsonb_array_elements(coalesce(e.payload->'matching'->'candidates','[]'::jsonb)) c WHERE c->>'key'=e.match_result->>'key' LIMIT 1)) IS NOT NULL,
  'needsTask',coalesce((SELECT (c->>'requiresTask')::boolean FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key'),false),
  'unavailableReason',CASE WHEN e.unavailable_reason IS NOT NULL THEN e.unavailable_reason
   WHEN runtime_history_available(e.id) AND NOT b.conflict
    AND (e.state='cancelled' OR (e.state='cost_pending' AND b.cancel_requested))
    AND EXISTS(
     SELECT 1 FROM bill2_calls c JOIN bill2_receipts r ON r.call_id=c.id
     WHERE c.run_id=b.id AND NOT r.conflict AND r.payload->>'source'='response'
      AND r.payload->>'evidenceKind' IS DISTINCT FROM 'transport_observation'
      AND r.payload->>'rejectedReason' IS NULL
      AND r.payload->>'model'=c.model AND r.payload->>'providerId'=c.provider_id
      AND r.payload#>>'{usage,sdkResponse,model}'=c.model
      AND CASE WHEN jsonb_typeof(r.payload#>'{usage,sdkResponse,choices}')='array'
       THEN jsonb_array_length(r.payload#>'{usage,sdkResponse,choices}') ELSE 0 END=1
      AND r.payload#>>'{usage,sdkResponse,choices,0,finish_reason}'='length'
      AND r.payload#>>'{usage,sdkResponse,choices,0,message,role}'='assistant'
      AND (r.payload#>'{usage,sdkResponse,choices,0,message,content}' IS NULL
       OR r.payload#>'{usage,sdkResponse,choices,0,message,content}'='null'::jsonb
       OR (jsonb_typeof(r.payload#>'{usage,sdkResponse,choices,0,message,content}')='string'
        AND (r.payload#>>'{usage,sdkResponse,choices,0,message,content}') !~ '[^[:space:]]'))
      AND (r.payload#>'{usage,sdkResponse,choices,0,message,tool_calls}' IS NULL
       OR r.payload#>'{usage,sdkResponse,choices,0,message,tool_calls}' IN ('null'::jsonb,'[]'::jsonb))
    ) THEN 'output_truncated' ELSE NULL END,
  'contentAvailable',runtime_history_available(e.id),'billing',bill2_public(b)) ORDER BY e.created_at,e.id),'[]') INTO items
 FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=s.id;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,'activeExecution',CASE WHEN EXISTS(SELECT 1 FROM runtime_executions old_execution JOIN bill2_runs old_run
   ON old_run.id=old_execution.billing_run_id
   WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
    AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
    AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
    AND old_run.closed AND old_run.cancel_requested) THEN NULL ELSE s.active_execution END,'executions',items);
END $$;
REVOKE ALL ON FUNCTION runtime_view(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_view(uuid,uuid) TO service_role;

COMMIT;
