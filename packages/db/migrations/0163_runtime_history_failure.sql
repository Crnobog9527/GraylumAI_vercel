-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Keep the existing locks, actor/scope checks, cancellation and settlement.
-- No new RPC/grants or client-controlled reason. The service-only RPC accepts
-- just the history diagnostic; existing callers omit p_result as before.
-- Applying twice replaces the identical definition. Rollback via a new migration
-- restoring 0106 runtime_execution and 0158 session_items/view; retain private reasons.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- One execution-local diagnostic bit: not revocation and not model context.
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS history_omitted boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION public.runtime_execution(p_actor_id uuid,p_execution_id uuid,p_action text,p_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;b bill2_runs;live boolean:=false;v jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 IF e.unavailable_reason IS NOT NULL AND p_action IN ('begin','read') THEN
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,'live',false,'cancelRequested',true,'result',NULL,'unavailableReason',e.unavailable_reason);
 END IF;
 IF NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'RUNTIME_CONTEXT_REVOKED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,b.payload,b.id);
 IF p_action='begin' THEN
  IF e.state='prepared' AND s.active_execution=e.id THEN
   UPDATE runtime_executions SET state='running' WHERE id=e.id RETURNING * INTO e;live:=true;
  END IF;
 ELSIF p_action='fail_before_dispatch' THEN
  IF p_result IS NOT NULL AND p_result IS DISTINCT FROM '{"unavailable_reason":"provider_history"}'::jsonb THEN
   RAISE EXCEPTION 'RUNTIME_FAILURE_REASON_DENIED';
  END IF;
  IF e.state IN ('prepared','running','interrupted') AND NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND dispatched_at IS NOT NULL) THEN
   v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
   -- The reason is set atomically only on a proven pre-dispatch cancellation.
   -- This column revokes this failed execution's content, never earlier turns.
   UPDATE runtime_executions SET state='cancelled',
    unavailable_reason=coalesce(e.unavailable_reason,p_result->>'unavailable_reason')
   WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id;
  END IF;
 ELSIF p_action='interrupt' THEN
  IF e.state='running' THEN UPDATE runtime_executions SET state='interrupted' WHERE id=e.id RETURNING * INTO e;END IF;
 ELSIF p_action='checkpoint_match' THEN
  IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested
   OR e.state NOT IN ('running','interrupted') OR NOT (e.payload ? 'matching')
   OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR NOT (p_result ? 'key')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k<>'key')
   OR (p_result->'key'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->'key'=p_result->'key'))
   OR NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id AND batch=0)
  THEN RAISE EXCEPTION 'RUNTIME_MATCH_DENIED';END IF;
  IF e.match_result IS NOT NULL AND e.match_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_MATCH_CONFLICT';END IF;
  UPDATE runtime_executions SET match_result=p_result WHERE id=e.id RETURNING * INTO e;
 ELSIF p_action='check_latest' THEN
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN
   v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
   UPDATE runtime_executions SET unavailable_reason='latest_unavailable',state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'cancelled' ELSE 'cost_pending' END WHERE id=e.id RETURNING * INTO e;
   IF e.state='cancelled' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
   RETURN jsonb_build_object('state',e.state,'unavailable',true);
  END IF;
 ELSIF p_action='checkpoint_primary' THEN
  IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested
   OR e.state NOT IN ('running','interrupted') OR NOT (e.payload ? 'attachedOrganizer')
   OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'body') IS DISTINCT FROM 'string'
   OR length(p_result->>'body')=0 OR octet_length(p_result::text)>262144
   OR jsonb_typeof(p_result->'lastSequence') IS DISTINCT FROM 'number'
   OR coalesce(p_result->>'lastSequence','') !~ '^[1-9][0-9]*$'
   OR (p_result->>'lastSequence')::int<1
   OR (p_result->>'lastSequence')::int>(SELECT count(*) FROM bill2_calls WHERE run_id=b.id)
   OR NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id)
  THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_DENIED';END IF;
  IF e.primary_result IS NOT NULL AND e.primary_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  UPDATE runtime_executions SET primary_result=p_result WHERE id=e.id RETURNING * INTO e;
 ELSIF p_action='complete' THEN
  IF b.cancel_requested THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_CANCELLED';END IF;
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN RAISE EXCEPTION 'RUNTIME_LATEST_UNAVAILABLE';END IF;
  IF e.primary_result IS NOT NULL AND e.primary_result->>'body' IS DISTINCT FROM p_result->>'body' THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  IF e.payload ? 'attachedOrganizer' AND (e.primary_result IS NULL OR jsonb_typeof(p_result->'summary') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
  IF e.state='completed' THEN
   IF e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
  ELSE
   IF s.active_execution IS DISTINCT FROM e.id OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'kind' IS DISTINCT FROM 'usable_result' THEN RAISE EXCEPTION 'RUNTIME_RESULT_DENIED';END IF;
   IF NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_PENDING';END IF;
   v:=bill2_close(p_actor_id,b.id,'delivered',p_result);
   v:=bill2_finalize(p_actor_id,b.id);
   IF e.result IS NOT NULL AND e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
   UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'completed' ELSE 'cost_pending' END,result=p_result WHERE id=e.id RETURNING * INTO e;
   IF e.state='completed' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
  END IF;
 ELSIF p_action<>'read' THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,
  'live',live,'cancelRequested',b.cancel_requested,'context',e.payload,'billing',b.payload,'result',e.result,'primaryResult',e.primary_result,'matchResult',e.match_result,'historyFrozen',e.selected_history IS NOT NULL,'historyOmitted',e.history_omitted,'unavailableReason',e.unavailable_reason);
END $$;

-- Definitions carried forward from 0158; existing grants are retained.
CREATE OR REPLACE FUNCTION public.runtime_session_items(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_action text, p_items jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT NULL::integer, p_batch integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b runtime_session_batches;n integer;answer jsonb;selected bigint[];omitted_notice boolean:=false;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=s.id AND actor_id=p_actor_id;
 IF s.id IS NULL OR e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SESSION_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
 IF p_action='read' THEN
  IF p_limit<0 THEN RAISE EXCEPTION 'RUNTIME_SESSION_LIMIT';END IF;
  -- Freeze the SDK's initial history for replay; this execution's own batches
  -- are replayed by the host, never injected again as previous-turn history.
  WITH candidates AS MATERIALIZED (
   SELECT h.revision,h.execution_id,h.item FROM runtime_session_history h
   WHERE h.session_id=s.id AND h.revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT h.internal_control
  ), availability AS MATERIALIZED (
   SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM candidates))
  )
  SELECT coalesce(jsonb_agg(item ORDER BY revision),'[]') INTO answer FROM (
   SELECT jsonb_build_object('revision',revision,'item',item) item,revision
   FROM candidates JOIN availability USING(execution_id) WHERE available ORDER BY revision DESC LIMIT p_limit
  ) x;
  RETURN answer;
 ELSIF p_action='freeze' THEN
  -- New service callers can attach one fixed diagnostic to the existing freeze.
  -- Old array callers and replay keep their original wire contract.
  IF jsonb_typeof(p_items)='object' THEN
   IF p_items->'historyOmitted' IS DISTINCT FROM 'true'::jsonb
    OR NOT (p_items ? 'revisions')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_items) k WHERE k NOT IN ('revisions','historyOmitted'))
   THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
   omitted_notice:=true;p_items:=p_items->'revisions';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>1000 THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  SELECT coalesce(array_agg(v::bigint ORDER BY v::bigint),ARRAY[]::bigint[]) INTO selected FROM jsonb_array_elements_text(p_items) v;
  IF e.selected_history IS NOT NULL THEN
   IF e.selected_history IS DISTINCT FROM selected OR (omitted_notice AND NOT e.history_omitted) THEN RAISE EXCEPTION 'RUNTIME_HISTORY_CHANGED';END IF;
   RETURN to_jsonb(selected);
  END IF;
  IF cardinality(selected)>greatest(0,least(1000,coalesce((e.payload->>'historyItems')::int,0)))
   OR cardinality(selected)<>(SELECT count(DISTINCT v) FROM unnest(selected) v)
   OR NOT selected<@e.candidate_history
   OR cardinality(selected)<>(WITH candidates AS MATERIALIZED (
    SELECT h.execution_id FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected)
   ), availability AS MATERIALIZED (
    SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM candidates))
   ) SELECT count(*) FROM candidates JOIN availability USING(execution_id) WHERE available)
   OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=e.billing_run_id AND payload->>'phase'<>'skill_matching')
  THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  IF omitted_notice AND (cardinality(selected)=0 OR cardinality(selected)>=cardinality(e.candidate_history)
   OR s.active_execution IS DISTINCT FROM e.id OR e.state<>'running'
   OR EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (closed OR cancel_requested)))
  THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  -- Membership and notice commit together, before any primary model call.
  UPDATE runtime_executions SET selected_history=selected,history_omitted=omitted_notice WHERE id=e.id;
  INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
   SELECT DISTINCT e.id,h.execution_id FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected);
  RETURN to_jsonb(selected);
 ELSIF p_action='append' THEN
  IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (cancel_requested OR closed)) THEN RAISE EXCEPTION 'RUNTIME_SESSION_CLOSED';END IF;
  IF s.active_execution IS DISTINCT FROM e.id OR e.state IN ('completed','cancelled') THEN RAISE EXCEPTION 'RUNTIME_SESSION_CLOSED';END IF;
  IF p_batch IS NULL OR p_batch<0 OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>128 THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH';END IF;
  SELECT * INTO b FROM runtime_session_batches WHERE execution_id=e.id AND batch=p_batch;
  IF b.execution_id IS NOT NULL THEN
   IF b.items IS DISTINCT FROM p_items THEN RAISE EXCEPTION 'RUNTIME_SESSION_CONFLICT';END IF;
   RETURN 'null'::jsonb;
  END IF;
  IF p_batch<>(SELECT count(*) FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH_ORDER';END IF;
  n:=jsonb_array_length(p_items);
  INSERT INTO runtime_session_batches VALUES(s.id,e.id,p_batch,p_items,s.revision,s.revision+n);
  INSERT INTO runtime_session_history(session_id,revision,execution_id,item,internal_control)
   SELECT s.id,s.revision+ordinality,e.id,value,(e.payload ? 'matching' AND p_batch=0) FROM jsonb_array_elements(p_items) WITH ORDINALITY;
  UPDATE runtime_sessions SET revision=revision+n WHERE id=s.id;
  RETURN 'null'::jsonb;
 END IF;
 RAISE EXCEPTION 'RUNTIME_SESSION_ACTION';
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_view(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;items jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 WITH availability AS MATERIALIZED (
  SELECT execution_id id,available FROM runtime_history_availability(ARRAY(
   SELECT e.id FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=s.id))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'request',CASE WHEN availability.available THEN (SELECT jsonb_strip_nulls(jsonb_build_object(
   'draftId',t.draft_id,'stepId',t.step_id,'purpose',t.purpose,'requestId',e.request_id,
   'input',e.payload->'request'->>'input','answerSource',e.payload#>'{request,answerSource}',
   'questionId',CASE WHEN e.payload->'request'->'selection'->>'task' LIKE 'opc-question:%'
    THEN substring(e.payload->'request'->'selection'->>'task' from 14) END,
   'organizeAfter',CASE WHEN e.payload->'request'->'organizeAfter'='true'::jsonb THEN true END))
   FROM opc_turns t WHERE t.session_id=e.session_id AND t.request_id=e.request_id
    AND t.token::text=e.payload->>'opcTurnToken' AND t.purpose='mentor') ELSE NULL END,'createdAt',e.created_at,'state',e.state,
  'input',CASE WHEN availability.available THEN e.payload->>'input' ELSE NULL END,
  'body',CASE WHEN availability.available THEN e.result->>'body' ELSE NULL END,
  'primaryBody',CASE WHEN availability.available THEN e.primary_result->>'body' ELSE NULL END,
  'organizerComplete',e.result ? 'summary',
  'summary',CASE WHEN availability.available THEN e.result->>'summary' ELSE NULL END,
  'skillExecution',coalesce(e.payload->>'revisionId',(SELECT c->>'revisionId' FROM jsonb_array_elements(coalesce(e.payload->'matching'->'candidates','[]'::jsonb)) c WHERE c->>'key'=e.match_result->>'key' LIMIT 1)) IS NOT NULL,
  'needsTask',coalesce((SELECT (c->>'requiresTask')::boolean FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key'),false),
  'historyOmitted',availability.available AND e.history_omitted,
  'unavailableReason',CASE WHEN e.unavailable_reason IS NOT NULL THEN e.unavailable_reason
   WHEN availability.available AND NOT b.conflict
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
  'contentAvailable',availability.available,'billing',bill2_public(b)) ORDER BY e.created_at,e.id),'[]') INTO items
 FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id
 JOIN availability ON availability.id=e.id WHERE e.session_id=s.id;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,'activeExecution',CASE WHEN EXISTS(SELECT 1 FROM runtime_executions old_execution JOIN bill2_runs old_run
   ON old_run.id=old_execution.billing_run_id
   WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
    AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
    AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
    AND old_run.closed AND old_run.cancel_requested) THEN NULL ELSE s.active_execution END,'executions',items);
END $function$;

COMMIT;
