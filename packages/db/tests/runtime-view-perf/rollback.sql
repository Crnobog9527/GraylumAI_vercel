-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Owner approval required for remote use. Restore functions only; retain all data.
BEGIN;
DO $$
BEGIN
 IF md5(pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure)) NOT IN ('769e56ff54272fc2ce0abe07a339ee5c','c9b0552bbe5cac3d5a1a9394b01ff227') THEN
  RAISE EXCEPTION 'RUNTIME_VIEW_PERF_ROLLBACK_MISMATCH';END IF;
 IF md5(pg_get_functiondef('public.runtime_history_available(uuid)'::regprocedure)) NOT IN ('fe9561da6f9a38b23968038ecce742cf','3de8f734b3e05bf3fcd131d9e4cb08c6') THEN
  RAISE EXCEPTION 'RUNTIME_VIEW_PERF_ROLLBACK_MISMATCH';END IF;
 IF md5(pg_get_functiondef('public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure)) NOT IN ('ee0b34456d760952a594bb4326208c30','1513a5cf6ac6cb1b26975036a37ed3b9') THEN
  RAISE EXCEPTION 'RUNTIME_VIEW_PERF_ROLLBACK_MISMATCH';END IF;
 IF md5(pg_get_functiondef('public.runtime_session_items(uuid,uuid,uuid,text,jsonb,integer,integer)'::regprocedure)) NOT IN ('8d942ec2ffb6f73d853e898349d703b4','39214d2faba91e9c4ae1113bdb10a5a2') THEN
  RAISE EXCEPTION 'RUNTIME_VIEW_PERF_ROLLBACK_MISMATCH';END IF;
 IF to_regprocedure('public.runtime_history_availability(uuid[])') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.runtime_history_availability(uuid[])')))<>'3c3f5f886f67f51df47187c930b95265' THEN
  RAISE EXCEPTION 'RUNTIME_VIEW_PERF_ROLLBACK_MISMATCH';END IF;
END $$;
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
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'request',CASE WHEN runtime_history_available(e.id) THEN (SELECT jsonb_strip_nulls(jsonb_build_object(
   'draftId',t.draft_id,'stepId',t.step_id,'purpose',t.purpose,'requestId',e.request_id,
   'input',e.payload->'request'->>'input','answerSource',e.payload#>'{request,answerSource}',
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
END $function$
;
CREATE OR REPLACE FUNCTION public.runtime_history_available(p_execution_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;b bill2_runs;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id;
 IF e.id IS NULL OR e.unavailable_reason IS NOT NULL THEN RETURN false;END IF;
 PERFORM runtime_billing_allowed(e.actor_id,b.payload,b.id);
 PERFORM runtime_context_allowed(e.actor_id,e.payload);

 RETURN true;
EXCEPTION WHEN raise_exception OR insufficient_privilege THEN RETURN false; -- Permission denial excludes history; transaction/storage errors must propagate.
END $function$
;
CREATE OR REPLACE FUNCTION public.runtime_admit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;history_candidates bigint[];source runtime_executions;prior_turn opc_turns;current_turn opc_turns;card jsonb;answer jsonb;idx integer;
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
 -- Only NEW admissions validate source freshness. Existing requests above and
 -- execution recovery retain their frozen inputs even after another turn exists.
 answer:=p_payload#>'{request,answerSource}';
 IF answer IS NOT NULL THEN
  BEGIN
   SELECT * INTO source FROM runtime_executions WHERE id=(answer->>'executionId')::uuid
    AND actor_id=p_actor_id AND session_id=s.id;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';
  END;
  SELECT * INTO prior_turn FROM opc_turns WHERE session_id=s.id AND request_id=source.request_id
   AND token::text=source.payload->>'opcTurnToken' AND purpose='mentor';
  SELECT * INTO current_turn FROM opc_turns WHERE session_id=s.id AND request_id=p_request_id
   AND token::text=p_payload->>'opcTurnToken' AND purpose='mentor';
  IF source.id IS NULL OR source.state IS DISTINCT FROM 'completed' OR NOT runtime_history_available(source.id)
   OR source.id IS DISTINCT FROM (SELECT id FROM runtime_executions WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)
   OR prior_turn.token IS NULL OR current_turn.token IS NULL
   OR prior_turn.draft_id IS DISTINCT FROM current_turn.draft_id
   OR prior_turn.round_id IS DISTINCT FROM current_turn.round_id
   OR prior_turn.step_id IS DISTINCT FROM current_turn.step_id
   OR NOT EXISTS(SELECT 1 FROM opc_drafts WHERE draft_id=current_turn.draft_id AND actor_id=p_actor_id
     AND session_id=s.id AND round_id=current_turn.round_id)
   OR coalesce(p_payload#>>'{request,selection,task}','') !~ '^opc-question:[a-z][a-z0-9_-]{0,63}$'
   OR source.payload#>>'{request,selection,task}' IS DISTINCT FROM p_payload#>>'{request,selection,task}'
   THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
  BEGIN card:=(source.result->>'body')::jsonb;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END;
  IF jsonb_typeof(card->'card')='object' AND NOT (card->'card' ? 'recommended') THEN
   card:=jsonb_set(card,'{card,recommended}','null'::jsonb);
  END IF;
  IF card->>'format' IS DISTINCT FROM 'agent-turn.v1' OR jsonb_typeof(card->'card') IS DISTINCT FROM 'object'
   OR card->'card' IS DISTINCT FROM p_payload#>'{answeredCard,card}'
   OR answer IS DISTINCT FROM (p_payload->'answeredCard')-'card'
   OR jsonb_typeof(card#>'{card,options}') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
  IF answer ? 'optionIndex' THEN
   IF jsonb_typeof(answer->'optionIndex') IS DISTINCT FROM 'number' OR (answer->>'optionIndex') !~ '^[0-4]$'
    THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
   idx:=(answer->>'optionIndex')::integer;
   IF idx>=jsonb_array_length(card#>'{card,options}')
    OR p_payload->>'input' IS DISTINCT FROM card#>>ARRAY['card','options',idx::text]
    OR p_payload#>>'{request,input}' IS DISTINCT FROM card#>>ARRAY['card','options',idx::text]
    THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
  ELSIF p_payload->>'input' IS DISTINCT FROM p_payload#>>'{request,input}' THEN
   RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';
  END IF;
 ELSIF p_payload ? 'answeredCard' THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';
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
END $function$
;
CREATE OR REPLACE FUNCTION public.runtime_session_items(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_action text, p_items jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT NULL::integer, p_batch integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b runtime_session_batches;n integer;answer jsonb;selected bigint[];
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
  SELECT coalesce(jsonb_agg(item ORDER BY revision),'[]') INTO answer FROM
   (SELECT jsonb_build_object('revision',revision,'item',item) item,revision FROM runtime_session_history h WHERE session_id=s.id AND revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT internal_control AND runtime_history_available(h.execution_id) ORDER BY revision DESC LIMIT p_limit) x;
  RETURN answer;
 ELSIF p_action='freeze' THEN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>1000 THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  SELECT coalesce(array_agg(v::bigint ORDER BY v::bigint),ARRAY[]::bigint[]) INTO selected FROM jsonb_array_elements_text(p_items) v;
  IF e.selected_history IS NOT NULL THEN
   IF e.selected_history IS DISTINCT FROM selected THEN RAISE EXCEPTION 'RUNTIME_HISTORY_CHANGED';END IF;
   RETURN to_jsonb(selected);
  END IF;
  IF cardinality(selected)>greatest(0,least(1000,coalesce((e.payload->>'historyItems')::int,0)))
   OR cardinality(selected)<>(SELECT count(DISTINCT v) FROM unnest(selected) v)
   OR NOT selected<@e.candidate_history
   OR cardinality(selected)<>(SELECT count(*) FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected) AND runtime_history_available(h.execution_id))
   OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=e.billing_run_id AND payload->>'phase'<>'skill_matching')
  THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  UPDATE runtime_executions SET selected_history=selected WHERE id=e.id;
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
END $function$
;

DROP FUNCTION IF EXISTS public.runtime_history_availability(uuid[]);
COMMIT;
