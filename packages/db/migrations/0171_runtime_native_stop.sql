-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C2 stop intent and receipt-derived completion. No remote database use.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='33b75218ba3751ab8a2b31a1b133b796' THEN RETURN;END IF;
 IF source_md5<>'fb0a164b29dfd4ae43f7c9059473c053' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.runtime_execution(p_actor_id uuid, p_execution_id uuid, p_action text, p_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b bill2_runs;live boolean:=false;v jsonb;next_seq integer;pending_call bill2_calls;stop_text text;primary_text text;stop_envelope boolean;stop_items jsonb;
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
 -- C2: stop intent is immutable; do not store progress or another copy of provider text.
 IF p_action='stop' THEN
  IF e.payload->>'nativeOutput' IS DISTINCT FROM 'native-output-v1'
   OR b.payload->>'operation'='plan'
   OR (e.payload->>'providerRequestFormat' IS DISTINCT FROM 'agent-turn-v5-stream'
    AND e.payload->>'envelopeOrder' IS DISTINCT FROM 'message-first-v1') THEN RETURN runtime_cancel(p_actor_id,e.id);END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_result->'stopAt') IS DISTINCT FROM 'number'
   OR coalesce(p_result->>'stopAt','') !~ '^[0-9]{1,10}$'
   OR (p_result->>'stopAt')::bigint>2147483647
   OR (p_result ? 'source' AND p_result->>'source' NOT IN ('assistant','message','final'))
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('stopAt','source'))
  THEN RAISE EXCEPTION 'RUNTIME_STOP_DENIED';END IF;
  IF e.state IN ('completed','cancelled') OR e.result IS NOT NULL THEN RETURN jsonb_build_object('state',e.state);END IF;
  IF b.cancel_requested OR b.closed OR b.conflict THEN RAISE EXCEPTION 'RUNTIME_RESUME_CLOSED';END IF;
  IF s.active_execution IS NOT NULL AND s.active_execution<>e.id THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
  IF b.paused_reason IS DISTINCT FROM 'user_stop' THEN
   UPDATE bill2_runs SET paused_reason='user_stop',runtime_dispatch_deadline=NULL,
    runtime_checkpoint=coalesce(runtime_checkpoint,'{}'::jsonb)||jsonb_build_object('stop',p_result),version=version+1
    WHERE id=b.id RETURNING * INTO b;
   UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid(),runtime_retryable=false
    WHERE run_id=b.id AND state='prepared' AND dispatched_at IS NULL AND settled_at IS NULL;
   -- Only per-call settlement/release here. The run remains open for the host result.
   IF b.contract_version='bill2.v2' THEN PERFORM bill2_finalize(p_actor_id,b.id);END IF;
   UPDATE runtime_executions SET state='interrupted' WHERE id=e.id;
   UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
  END IF;
  RETURN jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id
   AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL
   AND (b.contract_version='bill2.v2' OR c.selected_cost_usd IS NULL) AND NOT EXISTS(SELECT 1 FROM bill2_receipts rec WHERE rec.call_id=c.id
    AND rec.payload->>'source'='response' AND rec.payload->>'rawBody' IS NOT NULL
    AND rec.payload->>'evidenceKind' IS DISTINCT FROM 'transport_observation' AND rec.payload->>'rejectedReason' IS NULL))
   THEN 'stopping' ELSE 'stopped_pending_result' END);
 END IF;
 IF b.paused_reason='user_stop' AND p_action IN ('payg_wait','payg_resume','checkpoint_primary','checkpoint_match','check_latest',
  'fail_before_dispatch','interrupt','owner_cancel','owner_session','owner_tool') THEN
  RAISE EXCEPTION 'RUNTIME_STOP_REQUESTED';
 END IF;
 IF p_action='stop_pending' THEN
  IF b.paused_reason IS DISTINCT FROM 'user_stop' THEN RAISE EXCEPTION 'RUNTIME_STOP_DENIED';END IF;
  IF e.state NOT IN ('completed','cancelled') THEN
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
  END IF;
  RETURN jsonb_build_object('state',e.state);
 END IF;
 IF p_action IN ('fail_before_dispatch','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN
  IF coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
   OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
   OR (e.state IN ('prepared','waiting_credits','waiting_resume','cancelled') AND b.paused_reason IS DISTINCT FROM 'user_stop')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','value'))
  THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
  p_result:=nullif(p_result->'value','null'::jsonb);
 END IF;
 -- These three bounded delegates hold the same Session/execution/run locks as
 -- resume. No asynchronous check-then-write gap, new RPC family or new authority.
 IF p_action IN ('owner_cancel','owner_session','owner_tool') THEN
  IF b.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
  IF p_action='owner_cancel' THEN
   RETURN runtime_cancel(p_actor_id,e.id);
  ELSIF p_action='owner_session' THEN
   IF coalesce(p_result->>'action','') NOT IN ('freeze','append') THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
   RETURN runtime_session_items(p_actor_id,s.id,e.id,p_result->>'action',nullif(p_result->'items','null'::jsonb),
    (p_result->>'limit')::int,(p_result->>'batch')::int);
  ELSE
   IF coalesce(p_result->>'action','') NOT IN ('claim','complete') THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
   RETURN runtime_tool(p_actor_id,e.id,p_result->>'callId',p_result->>'name',p_result->'arguments',
    p_result->>'action',nullif(p_result->'result','null'::jsonb));
  END IF;
 END IF;

 IF b.contract_version='bill2.v2' AND p_action IN ('begin','read')
  AND e.state IN ('running','interrupted') AND b.runtime_dispatch_deadline<=clock_timestamp()
  AND NOT b.closed AND NOT b.cancel_requested AND NOT b.conflict AND b.paused_reason IS DISTINCT FROM 'user_stop' THEN
  SELECT * INTO pending_call FROM bill2_calls WHERE run_id=b.id AND state='prepared' AND dispatched_at IS NULL
   AND settled_at IS NULL ORDER BY sequence DESC LIMIT 1 FOR UPDATE;
  IF pending_call.id IS NOT NULL AND pending_call.runtime_epoch=b.runtime_epoch AND pending_call.dispatch_deadline<=clock_timestamp() THEN
   UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid(),runtime_retryable=true WHERE id=pending_call.id;
   PERFORM bill2_finalize(p_actor_id,b.id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL) THEN
   SELECT count(*)+1 INTO next_seq FROM bill2_calls WHERE run_id=b.id;
    UPDATE bill2_runs SET runtime_cursor=runtime_cursor+1,paused_reason='http_budget',runtime_dispatch_deadline=NULL,
     runtime_checkpoint=jsonb_strip_nulls(jsonb_build_object('sequence',next_seq,'requestHash',pending_call.payload->>'requestHash',
      'phase',pending_call.payload->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)))
     WHERE id=b.id RETURNING * INTO b;
    UPDATE runtime_executions SET state='waiting_resume' WHERE id=e.id RETURNING * INTO e;
    UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  END IF;
 END IF;
 IF b.contract_version='bill2.v2' AND p_action IN ('payg_wait','payg_resume') THEN
  IF b.closed OR b.cancel_requested OR b.conflict THEN RAISE EXCEPTION 'RUNTIME_RESUME_CLOSED';END IF;
  IF p_action='payg_wait' THEN
   IF e.state<>'running' OR s.active_execution IS DISTINCT FROM e.id
    OR coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
    OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
    OR p_result->>'state' IS NULL OR p_result->>'state' NOT IN ('waiting_credits','waiting_resume')
    OR coalesce(p_result->>'sequence','') !~ '^[1-9][0-9]*$'
    OR coalesce(p_result->>'requestHash','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_result->>'phase','')='' OR length(p_result->>'phase')>64
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','state','sequence','requestHash','phase'))
   THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_DENIED';END IF;
   SELECT * INTO pending_call FROM bill2_calls WHERE run_id=b.id AND sequence=(p_result->>'sequence')::int FOR UPDATE;
   IF pending_call.id IS NOT NULL THEN
    IF p_result->>'state'<>'waiting_resume' OR pending_call.dispatched_at IS NOT NULL
     OR NOT ((pending_call.state='prepared' AND pending_call.settled_at IS NULL) OR (pending_call.state='cancelled' AND pending_call.runtime_retryable AND pending_call.settled_at IS NOT NULL))
     OR pending_call.runtime_epoch<>b.runtime_epoch
     OR pending_call.payload->>'requestHash' IS DISTINCT FROM p_result->>'requestHash'
     OR pending_call.payload->>'phase' IS DISTINCT FROM p_result->>'phase'
    THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
    UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid(),runtime_retryable=true WHERE id=pending_call.id;
    PERFORM bill2_finalize(p_actor_id,b.id);
   END IF;
   SELECT count(*)+1 INTO next_seq FROM bill2_calls WHERE run_id=b.id;
   IF (p_result->>'sequence')::int<>(next_seq-CASE WHEN pending_call.id IS NOT NULL THEN 1 ELSE 0 END)
    OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
   THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
   UPDATE bill2_runs SET runtime_cursor=runtime_cursor+1,
    paused_reason=CASE WHEN p_result->>'state'='waiting_credits' THEN 'insufficient_credits' ELSE 'http_budget' END,
    runtime_checkpoint=jsonb_build_object('sequence',next_seq,'requestHash',p_result->>'requestHash',
      'phase',p_result->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)),
    runtime_dispatch_deadline=NULL WHERE id=b.id RETURNING * INTO b;
   UPDATE runtime_executions SET state=p_result->>'state' WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   IF e.state NOT IN ('waiting_credits','waiting_resume') OR s.active_execution IS NOT NULL
    OR coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
    OR coalesce(p_result->>'cursor','') !~ '^[1-9][0-9]*$'
    OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
    OR (p_result->>'cursor')::bigint IS DISTINCT FROM b.runtime_cursor
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','cursor'))
   THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
   -- Exhausted pre-transport cancellation cannot mint another call. Use the
   -- existing cancellation/financial authority under the original cursor/epoch CAS.
   IF (SELECT count(*) FROM bill2_calls WHERE run_id=b.id)>=b.max_calls THEN
    IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
     THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
    PERFORM runtime_cancel(p_actor_id,e.id);
    RETURN runtime_execution(p_actor_id,e.id,'read',NULL);
   END IF;
   IF b.runtime_checkpoint->>'sessionRevision' IS DISTINCT FROM s.revision::text
    OR b.runtime_checkpoint->>'materialRevision' IS DISTINCT FROM
      coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)::text
   THEN RAISE EXCEPTION 'RUNTIME_RESUME_SOURCE_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
    THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
   PERFORM runtime_test_window_allowed(p_actor_id,b.payload);
   UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,paused_reason=NULL,
    runtime_dispatch_deadline=clock_timestamp()+interval '265 seconds' WHERE id=b.id RETURNING * INTO b;
   UPDATE runtime_executions SET state='running' WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
   live:=true;
  END IF;
 ELSIF p_action='begin' THEN
  IF e.state='prepared' AND s.active_execution=e.id THEN
   UPDATE runtime_executions SET state='running' WHERE id=e.id RETURNING * INTO e;live:=true;
   IF b.contract_version='bill2.v2' THEN
    UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,
     runtime_dispatch_deadline=clock_timestamp()+interval '265 seconds' WHERE id=b.id RETURNING * INTO b;
   END IF;
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
  IF b.paused_reason='user_stop' THEN
   IF e.state IN ('completed','cancelled') THEN
    IF e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
    RETURN jsonb_build_object('state',e.state);
   END IF;
   IF p_result IS NULL THEN
    -- Host proved §4.2(e) from durable receipts; dispatched holds follow BILL2 rules.
    RETURN runtime_cancel(p_actor_id,e.id);
   END IF;
   IF p_result->'stopped' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'RUNTIME_STOP_RESULT_REQUIRED';END IF;
   IF jsonb_typeof(p_result->'body') IS DISTINCT FROM 'string'
    OR p_result->>'completeness' IS NULL OR p_result->>'completeness' NOT IN ('complete','stopped','length_limit')
    THEN RAISE EXCEPTION 'RUNTIME_STOP_RESULT_DENIED';END IF;
   stop_envelope:=e.payload->>'providerRequestFormat' IN ('agent-turn-v5-stream','serial-tools-v4-stream');
   stop_text:=p_result->>'body';primary_text:=e.primary_result->>'body';
   IF stop_envelope THEN
    BEGIN
     IF jsonb_typeof(stop_text::jsonb->'message') IS DISTINCT FROM 'string'
      OR (primary_text IS NOT NULL AND jsonb_typeof(primary_text::jsonb->'message') IS DISTINCT FROM 'string')
      THEN RAISE EXCEPTION 'RUNTIME_STOP_RESULT_DENIED';END IF;
     stop_text:=stop_text::jsonb->>'message';primary_text:=primary_text::jsonb->>'message';
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RUNTIME_STOP_RESULT_DENIED';END;
   END IF;
   IF char_length(stop_text)=0 OR char_length(stop_text)>(b.runtime_checkpoint#>>'{stop,stopAt}')::int
    THEN RAISE EXCEPTION 'RUNTIME_STOP_POSITION_EXCEEDED';END IF;
   IF primary_text IS NOT NULL AND left(primary_text,char_length(stop_text))<>stop_text
    THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
   IF e.payload ? 'attachedOrganizer' AND (jsonb_typeof(p_result->'summary') IS DISTINCT FROM 'string'
    OR ((p_result->'organized'='false'::jsonb AND p_result->>'summary'='')
     OR (p_result->'organized'='true'::jsonb AND length(btrim(p_result->>'summary'))>0 AND e.primary_result IS NOT NULL)) IS DISTINCT FROM true)
    THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
  END IF;
  IF b.cancel_requested THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_CANCELLED';END IF;
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN RAISE EXCEPTION 'RUNTIME_LATEST_UNAVAILABLE';END IF;
  IF b.paused_reason IS DISTINCT FROM 'user_stop' AND e.primary_result IS NOT NULL AND e.primary_result->>'body' IS DISTINCT FROM p_result->>'body' THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  IF b.paused_reason IS DISTINCT FROM 'user_stop' AND e.payload ? 'attachedOrganizer' AND (e.primary_result IS NULL OR jsonb_typeof(p_result->'summary') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
  IF e.state='completed' THEN
   IF e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
  ELSE
   IF s.active_execution IS DISTINCT FROM e.id OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'kind' IS DISTINCT FROM 'usable_result' THEN RAISE EXCEPTION 'RUNTIME_RESULT_DENIED';END IF;
   IF b.paused_reason='user_stop' AND e.result IS NULL THEN
    UPDATE runtime_session_history SET internal_control=true WHERE execution_id=e.id;
    stop_items:=jsonb_build_array(jsonb_build_object('role','user','content',e.payload->>'input'),
     jsonb_build_object('role','assistant','content',CASE WHEN e.payload->>'providerRequestFormat'='agent-turn-v5-stream'
      THEN stop_text ELSE p_result->>'body' END));
    PERFORM runtime_session_items(p_actor_id,s.id,e.id,'append',stop_items,NULL,
     (SELECT count(*)::int FROM runtime_session_batches WHERE execution_id=e.id));
   END IF;
   IF NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_PENDING';END IF;
   v:=bill2_close(p_actor_id,b.id,'delivered',p_result);
   v:=bill2_finalize(p_actor_id,b.id);
   IF e.result IS NOT NULL AND e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
   UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'completed' ELSE 'cost_pending' END,result=p_result WHERE id=e.id RETURNING * INTO e;
   IF e.state='completed' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
  END IF;
 ELSIF p_action<>'read' THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,
  'cursor',b.runtime_cursor,'epoch',b.runtime_epoch,'remainingCalls',b.max_calls-(SELECT count(*) FROM bill2_calls WHERE run_id=b.id),
  'pausedReason',b.paused_reason,'stop',b.runtime_checkpoint->'stop',
  'stopCalls',CASE WHEN b.paused_reason='user_stop' THEN (SELECT coalesce(jsonb_agg(jsonb_build_object(
   'sequence',c.sequence,'requestHash',c.payload->>'requestHash','phase',c.payload->>'phase',
   'dispatched',c.dispatched_at IS NOT NULL,'settled',c.settled_at IS NOT NULL OR (b.contract_version<>'bill2.v2' AND c.selected_cost_usd IS NOT NULL)) ORDER BY c.sequence),'[]'::jsonb)
   FROM bill2_calls c WHERE c.run_id=b.id) END,
  'live',live,'cancelRequested',b.cancel_requested,'context',e.payload,'billing',b.payload,'result',e.result,'primaryResult',e.primary_result,'matchResult',e.match_result,'historyFrozen',e.selected_history IS NOT NULL,'historyOmitted',e.history_omitted,'unavailableReason',e.unavailable_reason);
END $function$
$definition$;
 IF md5(definition)<>'33b75218ba3751ab8a2b31a1b133b796' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.bill2_claim(uuid,uuid,integer,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='92170d4a143013c4a833d9be54a73823' THEN RETURN;END IF;
 IF source_md5<>'4af4832f8be4acf51af5fc6a6648ea9a' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: bill2_claim(uuid,uuid,integer,jsonb)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid, p_run_id uuid, p_sequence integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;n integer;used numeric;upper_cost numeric;weighted boolean;wused numeric;m_call numeric;
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id AND contract_version='bill2.v2') THEN RETURN bill2_payg_claim(p_actor_id,p_run_id,p_sequence,p_payload); END IF;
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);PERFORM runtime_test_window_allowed(p_actor_id,r.payload);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.paused_reason='user_stop' THEN RAISE EXCEPTION 'RUNTIME_STOP_REQUESTED';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=r.id AND sequence=p_sequence;
 IF c.id IS NOT NULL THEN IF c.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);END IF;
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0) INTO n,used FROM bill2_calls WHERE run_id=r.id;
 upper_cost:=bill2_decimal(p_payload->'upperUsd');
 -- BILL-UNIT: a run whose rules carry billingUnit freezes m_i per call; the old single-m branch is unchanged.
 weighted:=coalesce(jsonb_typeof(r.payload->'rules'->'billingUnit')='object',false);
 IF weighted THEN
  m_call:=bill2_unit_multiplier(p_payload->'billingUnit'->'multiplier');
  SELECT coalesce(sum(CASE WHEN state='cancelled' THEN 0 ELSE coalesce(selected_cost_usd,upper_usd)*bill2_unit_multiplier(payload->'billingUnit'->'multiplier') END),0)
  INTO wused FROM bill2_calls WHERE run_id=r.id;
 END IF;
 IF p_sequence IS DISTINCT FROM n+1 OR n>=r.max_calls OR upper_cost<=0 OR used+upper_cost>r.budget_usd OR (CASE WHEN weighted THEN ceil((wused+upper_cost*m_call)*r.credits_per_usd)>r.reserved ELSE ceil((used+upper_cost)*r.credits_per_usd*r.multiplier)>r.reserved END)
 OR (CASE WHEN weighted THEN bill2_decimal(r.payload->'rules'->'billingUnit'->'creditsPerUsd') IS DISTINCT FROM r.credits_per_usd OR m_call>r.multiplier ELSE false END)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'callPolicy') policy WHERE policy->>'provider'=p_payload->>'provider' AND policy->>'account'=p_payload->>'account' AND policy->>'model'=p_payload->>'model' AND policy->>'protocol'=p_payload->>'protocol' AND (p_payload->>'inputLimit')::int<=(policy->>'inputLimit')::int AND (p_payload->>'outputLimit')::int<=(policy->>'outputLimit')::int AND upper_cost<=bill2_decimal(policy->'upperUsd') AND policy->'lookupSupported'=p_payload->'lookupSupported' AND policy->'providerLimits' IS NOT DISTINCT FROM p_payload->'providerLimits' AND (NOT weighted OR (policy->>'modelId'=p_payload->'billingUnit'->>'modelId' AND policy->'multiplier'=p_payload->'billingUnit'->'multiplier')))
 OR coalesce(length(p_payload->>'provider'),0)=0 OR coalesce(length(p_payload->>'account'),0)=0 OR coalesce(length(p_payload->>'model'),0)=0
 OR coalesce(p_payload->>'requestHash','') !~ '^[a-f0-9]{64}$' OR p_payload->>'protocol' IS DISTINCT FROM (CASE WHEN r.payload->>'mode'='staging_test' THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END)
 OR (p_payload->>'inputLimit') IS NULL OR (p_payload->>'inputLimit')::integer<=0 OR (p_payload->>'outputLimit') IS NULL OR (p_payload->>'outputLimit')::integer<=0
 OR p_payload->>'automaticRetry' IS DISTINCT FROM 'false' OR p_payload->>'hiddenTools' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd) VALUES(r.id,p_sequence,p_payload,p_payload->>'provider',p_payload->>'account',p_payload->>'model',upper_cost) RETURNING * INTO c;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $function$
$definition$;
 IF md5(definition)<>'92170d4a143013c4a833d9be54a73823' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='4708e5d1d85c24581b0aa5ea990c0080' THEN RETURN;END IF;
 IF source_md5<>'ca126fb624fb5b755471f9e26dfc37db' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: bill2_payg_claim(uuid,uuid,integer,jsonb)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;w runtime_test_windows;n integer;used numeric;used_calls bigint;
 cfg jsonb;threshold jsonb;avail integer;quarantine bigint;g numeric;h integer;q record;u numeric;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 PERFORM runtime_billing_allowed(a,r.payload,r.id);
 -- Match prepare/dispatch: profile before test window, then grants. The window
 -- permission check itself takes FOR UPDATE, so lock the profile before calling it.
 SELECT credits INTO avail FROM profiles WHERE id=a AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED';END IF;
 PERFORM runtime_test_window_allowed(a,r.payload);
 IF NOT coalesce(bill2_scope_allowed(a,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=rid AND sequence=seq;
 IF c.id IS NOT NULL THEN
  IF c.payload IS DISTINCT FROM p THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);
 END IF;
 IF r.session_ref IS NOT NULL AND (coalesce(p->>'runtimeEpoch','') !~ '^[1-9][0-9]*$'
  OR (p->>'runtimeEpoch')::bigint IS DISTINCT FROM r.runtime_epoch
  OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
    WHERE e.billing_run_id=r.id AND e.state='running' AND s.active_execution=e.id)
  OR r.runtime_dispatch_deadline IS NULL) THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
 IF r.paused_reason='user_stop' THEN RAISE EXCEPTION 'RUNTIME_STOP_REQUESTED';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=
  (CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_dispatch_deadline ELSE r.deadline END) THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 IF octet_length(p::text)>65536 THEN RAISE EXCEPTION 'BILL2_CALL_TOO_LARGE';END IF;
 PERFORM bill2_payg_validate_quote(r,p);
 IF r.session_ref IS NOT NULL AND r.runtime_checkpoint ? 'requestHash' AND seq=(r.runtime_checkpoint->>'sequence')::int AND
  (p->>'requestHash' IS DISTINCT FROM r.runtime_checkpoint->>'requestHash'
   OR p->>'phase' IS DISTINCT FROM r.runtime_checkpoint->>'phase')
 THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>'model'
  AND (x.budget_conflict OR x.metering_missing OR x.metering_exit) AND x.metering_review_audit_id IS NULL) THEN RAISE EXCEPTION 'BILL2_PAYG_METERING_BLOCKED';END IF;
 IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND settled_at IS NULL) THEN RAISE EXCEPTION 'BILL2_CALL_PENDING';END IF;
 u:=bill2_decimal(p->'upperUsd');
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0)
 INTO n,used FROM bill2_calls WHERE run_id=rid;
 IF seq IS DISTINCT FROM n+1 OR n>=r.max_calls OR used+u>r.budget_usd THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 IF r.test_window_id IS NOT NULL THEN
  SELECT * INTO w FROM runtime_test_windows WHERE id=r.test_window_id FOR UPDATE;
  SELECT coalesce(sum(CASE WHEN x.contract_version='bill2.v2' THEN coalesce(calls.cost,0)
   WHEN x.closed AND NOT x.conflict AND x.provider_cost_usd IS NOT NULL THEN greatest(x.provider_cost_usd,coalesce(calls.cost,0))
   ELSE greatest(x.budget_usd,coalesce(calls.cost,0)) END),0),
   coalesce(sum(CASE WHEN x.contract_version='bill2.v2' OR x.closed THEN coalesce(calls.n,0) ELSE x.max_calls END),0)
  INTO used,used_calls FROM bill2_runs x LEFT JOIN LATERAL(
   SELECT count(*) n,sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END) cost
   FROM bill2_calls WHERE run_id=x.id) calls ON true WHERE x.test_window_id=w.id;
  IF used+u>w.max_cost_usd OR used_calls+1>w.max_calls THEN RAISE EXCEPTION 'RUNTIME_TEST_BUDGET_EXHAUSTED';END IF;
 END IF;
 SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds' FOR SHARE;
 SELECT x INTO threshold FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cfg->'thresholds')='array' THEN cfg->'thresholds' ELSE '[]'::jsonb END) x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase';
 IF coalesce(cfg->>'version','')='' OR coalesce(threshold->>'credits','') !~ '^[1-9][0-9]{0,8}$'
 OR (SELECT count(*) FROM jsonb_array_elements(cfg->'thresholds') x WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase')<>1
 THEN RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';END IF;
 -- The balance already excludes all pre-deductions. Subtract only unavailable grant remainder.
 PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=a AND accounting_state<>'trusted') THEN
  RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';END IF;
 SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine
 FROM subscription_credit_grants g WHERE g.user_id=a AND g.status='granted' AND g.accounting_state='trusted'
 AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);
 avail:=greatest(avail-quarantine,0);
 IF avail<(threshold->>'credits')::int THEN
  UPDATE bill2_runs SET paused_reason='insufficient_credits',version=version+1 WHERE id=rid;
  RETURN jsonb_build_object('id',NULL,'state','waiting_credits','dispatchToken',NULL);
 END IF;
 g:=ceil(u*r.credits_per_usd*bill2_unit_multiplier(p->'billingUnit'->'multiplier'));h:=least(g,avail)::int;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd)
 VALUES(rid,seq,p,p->>'provider',p->>'account',p->>'model',u) RETURNING * INTO c;
 SELECT * INTO q FROM atomic_pre_deduct(a,h,'BILL2 call reservation',c.id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_calls SET pre_deduct_id=q.pre_deduct_id,reserved_credits=h,available_credits=avail,
  runtime_epoch=CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_epoch ELSE NULL END,
  dispatch_deadline=coalesce(r.runtime_dispatch_deadline,r.deadline),
  recovery_deadline=coalesce(r.runtime_dispatch_deadline,r.deadline)+interval '24 hours',
  supersedes_call_id=(SELECT id FROM bill2_calls WHERE run_id=r.id AND sequence=seq-1 AND runtime_retryable
   AND state='cancelled' AND dispatched_at IS NULL AND settled_at IS NOT NULL
   AND payload->>'requestHash'=p->>'requestHash' AND payload->>'phase'=p->>'phase'),
  start_threshold=(threshold->>'credits')::int,threshold_version=cfg->>'version' WHERE id=c.id;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
  idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
 VALUES(a,-h,'adjustment','Call reservation','adjustment','bill2_reserve','ai_task',rid::text,
 'bill2:'||c.id||':reserve',q.balance_before,q.balance_after,rid,c.id,
 jsonb_build_object('contractVersion','bill2.v2','preDeductId',q.pre_deduct_id,'G',g::text,'H',h,'A',avail,'L',threshold->'credits','thresholdVersion',cfg->>'version'));
 UPDATE bill2_runs SET paused_reason=NULL,version=version+1 WHERE id=rid;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $function$
$definition$;
 IF md5(definition)<>'4708e5d1d85c24581b0aa5ea990c0080' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='fdba11e6df13dbb2bf3eeaf5ea2441ed' THEN RETURN;END IF;
 IF source_md5<>'00ae50bf38b328b3f313d602817d4c02' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.bill2_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_rotate boolean DEFAULT false, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_DENIED';END IF;
 IF r.contract_version='bill2.v2' AND (c.pre_deduct_id IS NULL OR c.settled_at IS NOT NULL OR EXISTS(SELECT 1 FROM bill2_calls x WHERE x.run_id=r.id AND (x.budget_conflict OR x.metering_missing OR x.metering_exit))) THEN RETURN jsonb_build_object('dispatch',false);END IF;
 IF r.contract_version='bill2.v2' AND r.session_ref IS NOT NULL AND
  (c.runtime_epoch IS DISTINCT FROM r.runtime_epoch OR r.runtime_dispatch_deadline IS NULL
   OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
    WHERE e.billing_run_id=r.id AND e.state='running' AND s.active_execution=e.id))
 THEN RETURN jsonb_build_object('dispatch',false);END IF;
 IF r.paused_reason='user_stop' THEN RETURN jsonb_build_object('dispatch',false);END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=
  (CASE WHEN r.contract_version='bill2.v2' THEN coalesce(c.dispatch_deadline,r.deadline) ELSE r.deadline END) OR c.state<>'prepared' OR (NOT p_rotate AND c.token IS DISTINCT FROM p_token) THEN RETURN jsonb_build_object('dispatch',false);END IF;
 -- Final permission check serializes a concurrent account suspension before any HTTP grant.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 IF p_rotate THEN IF p_payload IS DISTINCT FROM c.payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF; UPDATE bill2_calls SET token=gen_random_uuid() WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('dispatch',false,'dispatchToken',c.token);END IF;
 UPDATE bill2_calls SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=c.id;
 UPDATE bill2_runs SET state='dispatched',version=version+1 WHERE id=r.id;
 RETURN jsonb_build_object('dispatch',true);
END $function$
$definition$;
 IF md5(definition)<>'fdba11e6df13dbb2bf3eeaf5ea2441ed' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='bc60c8e82b1f58419246504dc7fcd0ca' THEN RETURN;END IF;
 IF source_md5<>'1518394dfc8a5478186e3db382697e79' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: runtime_view(uuid,uuid)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.runtime_view(p_actor_id uuid, p_session_id uuid)
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
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'cursor',b.runtime_cursor,'epoch',b.runtime_epoch,'remainingCalls',b.max_calls-(SELECT count(*) FROM bill2_calls c WHERE c.run_id=b.id),'request',CASE WHEN availability.available THEN (SELECT jsonb_strip_nulls(jsonb_build_object(
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
  'organizerComplete',e.result ? 'summary','code',CASE e.state WHEN 'waiting_credits' THEN 'RUNTIME_WAITING_CREDITS' WHEN 'waiting_resume' THEN 'RUNTIME_WAITING_RESUME' END,
  'summary',CASE WHEN availability.available THEN e.result->>'summary' ELSE NULL END,
  'skillExecution',coalesce(e.payload->>'revisionId',(SELECT c->>'revisionId' FROM jsonb_array_elements(coalesce(e.payload->'matching'->'candidates','[]'::jsonb)) c WHERE c->>'key'=e.match_result->>'key' LIMIT 1)) IS NOT NULL,
  'needsTask',coalesce((SELECT (c->>'requiresTask')::boolean FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key'),false),
  'historyOmitted',availability.available AND e.history_omitted,
  'unavailableReason',CASE WHEN e.unavailable_reason IS NOT NULL THEN e.unavailable_reason
   WHEN availability.available AND e.state='cancelled'
    AND b.closed AND b.state IN ('settled','refunded') AND NOT b.conflict AND b.charged=0
    AND EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND c.provider_rejected)
    AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id
     AND c.dispatched_at IS NOT NULL AND NOT c.provider_rejected)
    THEN 'provider_rejected'
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
  'contentAvailable',availability.available,'billing',bill2_public(b))
  || CASE WHEN availability.available THEN jsonb_strip_nulls(jsonb_build_object(
   'completeness',CASE WHEN e.result->>'completeness' IN ('complete','length_limit','stopped') THEN e.result->'completeness' END,
   'stopped',CASE WHEN e.result->'stopped'='true'::jsonb THEN true END,
   'organized',CASE WHEN jsonb_typeof(e.result->'organized')='boolean' THEN e.result->'organized' END,
   'summaryOmitted',CASE WHEN jsonb_typeof(e.result->'summaryOmitted')='boolean' THEN e.result->'summaryOmitted' END,
   'messageFirst',CASE WHEN jsonb_typeof(e.result->'messageFirst')='boolean' THEN e.result->'messageFirst' END,
   'envelopeCompact',CASE WHEN jsonb_typeof(e.result->'envelopeCompact')='boolean' THEN e.result->'envelopeCompact' END
  )) ELSE '{}'::jsonb END ORDER BY e.created_at,e.id),'[]') INTO items
 FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id
 JOIN availability ON availability.id=e.id WHERE e.session_id=s.id;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,'activeExecution',CASE WHEN EXISTS(SELECT 1 FROM runtime_executions old_execution JOIN bill2_runs old_run
   ON old_run.id=old_execution.billing_run_id
   WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
    AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
    AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
    AND old_run.closed AND old_run.cancel_requested) THEN NULL ELSE s.active_execution END,'executions',items);
END $function$
$definition$;
 IF md5(definition)<>'bc60c8e82b1f58419246504dc7fcd0ca' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='037d9c0d55bcb9f39921f0cbe36a9048' THEN RETURN;END IF;
 IF source_md5<>'8b4ef3b787caf790ab5510c61dd07883' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: runtime_financial_recovery(uuid,uuid,boolean)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;erasing boolean;terminal text;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(b.pre_deduct_id,b.id));
 IF NOT erasing AND b.paused_reason='user_stop' AND e.result IS NULL AND runtime_history_available(e.id) THEN
  -- Only the receipt reconstruction host can decide whether stopped content is usable.
  RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state','cost_pending','billing',bill2_public(b));
 END IF;
 IF NOT erasing AND e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending')
 AND NOT EXISTS(SELECT 1 FROM runtime_test_windows w WHERE w.id=b.test_window_id
  AND (NOT w.enabled OR clock_timestamp()>=w.expires_at OR NOT(p_actor_id=ANY(w.actor_ids)))) THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  -- A winning financial outcome is authoritative even after execution content is gone.
  IF NOT erasing THEN
   IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
   ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  ELSIF b.state NOT IN ('settled','refunded') THEN
   IF NOT b.closed OR b.outcome IS NULL OR b.outcome='unknown' THEN
    IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
    ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
   END IF;
  END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   terminal:=CASE WHEN NOT erasing THEN CASE WHEN e.result IS NULL THEN 'cancelled' ELSE 'completed' END
     WHEN v->>'state'='settled' AND v->>'outcome'='delivered' THEN 'completed' ELSE 'cancelled' END;
   -- Already-erased terminal rows remain immutable; no redundant UPDATE or content write.
   IF e.state IS DISTINCT FROM terminal THEN
    UPDATE runtime_executions SET state=terminal WHERE id=e.id RETURNING * INTO e;
   END IF;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
   IF erasing THEN
    UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
   END IF;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 IF erasing THEN v:=(v-'scope')||'{"accountClosed":true}'::jsonb;END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $function$
$definition$;
 IF md5(definition)<>'037d9c0d55bcb9f39921f0cbe36a9048' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_pending_financial_batch(uuid,integer)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='c69b5746050fa186c5b413c1ff1ace5d' THEN RETURN;END IF;
 IF source_md5<>'ef9b72eae775774021ef2b5e40be68a4' THEN RAISE EXCEPTION 'NATIVE_STOP_SOURCE_MISMATCH: runtime_pending_financial_batch(uuid,integer)';END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.runtime_pending_financial_batch(p_actor_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
  RAISE EXCEPTION 'RUNTIME_RECOVERY_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY last_lookup NULLS FIRST,run_id),'[]'::jsonb) INTO result
 FROM (
  SELECT r.id run_id, pending.last_lookup,
   jsonb_build_object('actorId',r.actor_id,'executionId',e.id,'runId',r.id,
    'userStop',coalesce((r.paused_reason='user_stop' AND e.result IS NULL AND runtime_history_available(e.id) AND NOT bill2_erasure_closed(r.actor_id,coalesce(r.pre_deduct_id,r.id))),false),
    'finishAllowed',(e.state IN ('cost_pending','cancelled') OR e.result IS NOT NULL),
    'recoveryPolicy',jsonb_build_object('id',r.test_window_id,'expiresAt',r.deadline,
     'creditsPerUsd',r.credits_per_usd::text,'multiplier',r.multiplier::text,
     'callPolicies',r.payload->'callPolicy')) item
  FROM bill2_runs r
  JOIN runtime_executions e ON e.billing_run_id=r.id AND e.actor_id=r.actor_id
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=r.actor_id AND r.session_ref=s.id
  CROSS JOIN LATERAL (
   SELECT min(c.rejection_recovery_at) last_lookup FROM bill2_calls c
   WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL AND c.provider_id IS NOT NULL
    AND c.payload->>'lookupSupported'='true'
    AND (c.selected_cost_usd IS NULL OR (r.contract_version='bill2.v2' AND c.settled_at IS NULL))
    AND clock_timestamp()<=CASE WHEN r.contract_version='bill2.v2'
     THEN coalesce(c.recovery_deadline,c.created_at+interval '24 hours') ELSE r.deadline+interval '24 hours' END
    AND (c.rejection_recovery_at IS NULL OR c.rejection_recovery_at<=clock_timestamp()-interval '60 seconds')
   HAVING (r.paused_reason='user_stop' AND e.result IS NULL AND runtime_history_available(e.id) AND NOT bill2_erasure_closed(r.actor_id,coalesce(r.pre_deduct_id,r.id))) OR count(*)>0 OR (r.closed AND (e.state IN ('cost_pending','cancelled') OR e.result IS NOT NULL)
    AND NOT EXISTS(
    SELECT 1 FROM bill2_calls unknown_call WHERE unknown_call.run_id=r.id
     AND unknown_call.dispatched_at IS NOT NULL AND unknown_call.selected_cost_usd IS NULL)
    AND CASE WHEN r.contract_version='bill2.v2' THEN EXISTS(
     SELECT 1 FROM bill2_calls recent_call WHERE recent_call.run_id=r.id
      AND clock_timestamp()<=coalesce(recent_call.recovery_deadline,recent_call.created_at+interval '24 hours'))
     ELSE clock_timestamp()<=r.deadline+interval '24 hours' END)
  ) pending
  WHERE (p_actor_id IS NULL OR r.actor_id=p_actor_id) AND NOT r.conflict
   AND r.state NOT IN ('settled','refunded')
  ORDER BY pending.last_lookup NULLS FIRST,r.id LIMIT p_limit
 ) chosen;
 RETURN result;
END $function$
$definition$;
 IF md5(definition)<>'c69b5746050fa186c5b413c1ff1ace5d' THEN RAISE EXCEPTION 'NATIVE_STOP_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
COMMIT;
