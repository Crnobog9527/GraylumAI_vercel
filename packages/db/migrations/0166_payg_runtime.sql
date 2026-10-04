-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-PAYG PR-B1. Source: staging 1016f75f; local PostgreSQL catalog, no remote DB access.
-- Rollback by forward migration; retain checkpoint, call, receipt and ledger facts. Default remains v1.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure)) NOT IN ('f497b1c3d026b7182a98c15d4def9dba','6d3ae6342bf0eaaf1899da954203f658') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure)) NOT IN ('0e9af3688e33e3adc1d1400a3561b01e','a67839c4bbbe56e72cebf972a2d19ff5') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: bill2_payg_claim(uuid,uuid,integer,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure)) NOT IN ('3a41fc21404ee5b541760704a9f7a387','00ae50bf38b328b3f313d602817d4c02') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_recovery_claim(uuid,uuid,uuid)'::regprocedure)) NOT IN ('f32d401cae96f9a2758c7d5345375d5b','5a5f5a8082aee54fd283d9018d71fab1') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: bill2_recovery_claim(uuid,uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)'::regprocedure)) NOT IN ('e8d056e17c4dfc9d52b7770e8e34c6b3','4e806607bd727b1d2e558edf0f32cb2d') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)';END IF;
 IF md5(pg_get_functiondef('public.runtime_response(uuid,uuid,integer,text)'::regprocedure)) NOT IN ('086f4d7ca79938e11c9d7c06bf8cd06f','3e19e3ae910b4b0636dee4f70107e0d2') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: runtime_response(uuid,uuid,integer,text)';END IF;
 IF md5(pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure)) NOT IN ('9ddbd0ebb4d5972fe24fa4aab4ad61dd','78ce7eac3d1076781c18fd6536677357') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: bill2_payg_finalize(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.runtime_test_window_allowed(uuid,jsonb)'::regprocedure)) NOT IN ('ac72346ea6a895fc568247ac2cef3db6','4c8f063a42872f01e98185de61d13886') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: runtime_test_window_allowed(uuid,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.runtime_pending_financial_batch(uuid,integer)'::regprocedure)) NOT IN ('48965682aa5d34a4d5fafa0bed90c732','ef9b72eae775774021ef2b5e40be68a4') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: runtime_pending_financial_batch(uuid,integer)';END IF;
 IF md5(pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure)) NOT IN ('5671d0de602bf6e9c2ac4c7621fb5139','d08c7da6fe58eab7b19fab87fe87479a') THEN
  RAISE EXCEPTION 'PAYG_RUNTIME_SOURCE_MISMATCH: runtime_view(uuid,uuid)';END IF;
END $$;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS runtime_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS runtime_cursor bigint NOT NULL DEFAULT 0;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS runtime_checkpoint jsonb;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS runtime_dispatch_deadline timestamptz;
ALTER TABLE bill2_runs DROP CONSTRAINT IF EXISTS bill2_runtime_checkpoint_size;
ALTER TABLE bill2_runs ADD CONSTRAINT bill2_runtime_checkpoint_size CHECK(
 runtime_epoch>=0 AND runtime_cursor>=0 AND
 octet_length(jsonb_build_object('checkpoint',runtime_checkpoint,'pausedReason',paused_reason)::text)<=65536);
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS runtime_epoch bigint;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS runtime_retryable boolean NOT NULL DEFAULT false;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS supersedes_call_id uuid REFERENCES bill2_calls(id);
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS dispatch_deadline timestamptz;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS recovery_deadline timestamptz;
ALTER TABLE runtime_executions DROP CONSTRAINT runtime_executions_state_check;
ALTER TABLE runtime_executions ADD CONSTRAINT runtime_executions_state_check CHECK(
 state IN ('prepared','running','interrupted','completed','cancelled','cost_pending','waiting_credits','waiting_resume'));
CREATE OR REPLACE FUNCTION public.runtime_execution(p_actor_id uuid, p_execution_id uuid, p_action text, p_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b bill2_runs;live boolean:=false;v jsonb;next_seq integer;pending_call bill2_calls;
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
 IF p_action IN ('fail_before_dispatch','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN
  IF coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
   OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
   OR e.state IN ('prepared','waiting_credits','waiting_resume','cancelled')
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
  AND NOT b.closed AND NOT b.cancel_requested AND NOT b.conflict THEN
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
   IF b.runtime_checkpoint->>'sessionRevision' IS DISTINCT FROM s.revision::text
    OR b.runtime_checkpoint->>'materialRevision' IS DISTINCT FROM
      coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)::text
   THEN RAISE EXCEPTION 'RUNTIME_RESUME_SOURCE_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
    THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
   IF (SELECT count(*) FROM bill2_calls WHERE run_id=b.id)>=b.max_calls
    THEN RAISE EXCEPTION 'RUNTIME_CALL_LIMIT_REACHED';END IF;
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
  'cursor',b.runtime_cursor,'epoch',b.runtime_epoch,'remainingCalls',b.max_calls-(SELECT count(*) FROM bill2_calls WHERE run_id=b.id),
  'live',live,'cancelRequested',b.cancel_requested,'context',e.payload,'billing',b.payload,'result',e.result,'primaryResult',e.primary_result,'matchResult',e.match_result,'historyFrozen',e.selected_history IS NOT NULL,'historyOmitted',e.history_omitted,'unavailableReason',e.unavailable_reason);
END $function$

;
CREATE OR REPLACE FUNCTION public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb)
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
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=
  (CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_dispatch_deadline ELSE r.deadline END) THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 IF octet_length(p::text)>65536 THEN RAISE EXCEPTION 'BILL2_CALL_TOO_LARGE';END IF;
 PERFORM bill2_payg_validate_quote(r,p);
 IF r.session_ref IS NOT NULL AND r.runtime_checkpoint ? 'requestHash' AND seq=(r.runtime_checkpoint->>'sequence')::int AND
  (p->>'requestHash' IS DISTINCT FROM r.runtime_checkpoint->>'requestHash'
   OR p->>'phase' IS DISTINCT FROM r.runtime_checkpoint->>'phase')
 THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>'model'
  AND (x.budget_conflict OR x.metering_missing OR x.metering_exit)) THEN RAISE EXCEPTION 'BILL2_PAYG_METERING_BLOCKED';END IF;
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

;
CREATE OR REPLACE FUNCTION public.bill2_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_rotate boolean DEFAULT false, p_payload jsonb DEFAULT NULL::jsonb)
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

;
CREATE OR REPLACE FUNCTION public.bill2_recovery_claim(p_actor_id uuid, p_run_id uuid, p_call_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;candidate boolean;claimed_at timestamptz;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL OR c.provider_id IS NULL OR (c.selected_cost_usd IS NOT NULL AND (r.contract_version='bill2.v1' OR c.settled_at IS NOT NULL))
 OR clock_timestamp()>(CASE WHEN r.contract_version='bill2.v2' THEN coalesce(c.recovery_deadline,c.created_at+interval '24 hours') ELSE r.deadline+interval '24 hours' END) OR c.payload->>'lookupSupported' IS DISTINCT FROM 'true' OR r.conflict THEN RETURN NULL;END IF;
 SELECT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
  AND payload->>'evidenceKind'='provider_rejection_pending') INTO candidate;
 claimed_at:=clock_timestamp();
 IF c.rejection_recovery_at IS NOT NULL
  AND claimed_at<c.rejection_recovery_at+interval '60 seconds' THEN RETURN NULL;END IF;
 UPDATE bill2_calls SET recovery_attempts=recovery_attempts+1,
  rejection_recovery_at=claimed_at WHERE id=c.id;
 RETURN jsonb_build_object('id',c.id,'providerId',c.provider_id,'provider',c.provider,'account',c.account_namespace,'model',c.model,'protocol',c.payload->>'protocol')||CASE WHEN candidate THEN
  jsonb_build_object('rejectionRecovery',jsonb_build_object('attempt',c.recovery_attempts+1,'claimedAt',claimed_at))
  ELSE '{}'::jsonb END;
END $function$

;
CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;erasing boolean;restricted boolean;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id));
 -- Match the exact original call, including the retained one-shot proof after revocation.
 restricted:=NOT erasing AND EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id
  AND status IN ('disabled','banned') AND is_deleted='false')
  AND bill2_payg_financial_binding(r)
  AND EXISTS(SELECT 1 FROM bill2_calls WHERE id=p_call_id AND run_id=r.id
   AND token=p_token AND payload->>'requestHash'=p_request_hash
   AND (dispatched_at IS NOT NULL OR (dispatch_granted_at IS NOT NULL AND dispatch_revoked_at IS NOT NULL)));
 IF NOT erasing AND NOT restricted THEN PERFORM bill2_actor(p_actor_id);END IF;
 IF NOT erasing AND NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR p_token IS NULL OR c.token IS DISTINCT FROM p_token
  OR p_request_hash IS NULL OR c.payload->>'requestHash' IS DISTINCT FROM p_request_hash
  OR c.provider<>'openrouter' OR c.payload->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1'
 THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- Retain the original token for exact idempotent readback. Cancelled state
 -- permanently prevents rotate/dispatch; bill2_record rejects NULL dispatch.
 IF c.dispatch_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('revoked',true,'eligible',false);END IF;
 eligible:=NOT r.conflict AND c.state='dispatched' AND c.dispatched_at IS NOT NULL
  AND c.provider_id IS NULL AND c.selected_cost_usd IS NULL
  AND NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM bill2_provider_ids WHERE call_id=c.id);
 IF p_inspect THEN RETURN jsonb_build_object('revoked',false,'eligible',eligible);END IF;
 IF NOT eligible THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- The dispatch timestamp represented a permission grant, not observed HTTP.
 -- Preserve it before clearing the existing possible-dispatch accounting flag.
 UPDATE bill2_calls SET dispatch_granted_at=dispatched_at,dispatch_revoked_at=clock_timestamp(),dispatched_at=NULL,state='cancelled' WHERE id=c.id;

 IF r.contract_version='bill2.v2' AND r.session_ref IS NOT NULL AND NOT erasing AND NOT restricted
  AND NOT r.closed AND NOT r.cancel_requested THEN
  UPDATE bill2_calls SET runtime_retryable=true WHERE id=c.id;
 ELSE PERFORM bill2_cancel(p_actor_id,r.id);END IF;
 PERFORM bill2_finalize(p_actor_id,r.id);
 RETURN jsonb_build_object('revoked',true,'eligible',false);
END $function$

;
CREATE OR REPLACE FUNCTION public.runtime_response(p_actor_id uuid, p_execution_id uuid, p_sequence integer, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;c bill2_calls;raw text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id;
 IF e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_RESPONSE_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
 SELECT * INTO c FROM bill2_calls WHERE run_id=e.billing_run_id AND sequence=p_sequence;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 IF c.payload->>'requestHash' IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'RUNTIME_RESPONSE_CONFLICT';END IF;
 SELECT payload->>'rawBody' INTO raw FROM bill2_receipts WHERE call_id=c.id
  AND payload->>'source'='response' AND payload->>'evidenceKind' IS DISTINCT FROM 'transport_observation'
  AND payload->>'rejectedReason' IS NULL ORDER BY created_at LIMIT 1;
 RETURN jsonb_build_object('callId',c.id,'state',c.state,'rawBody',raw,'retryable',c.runtime_retryable AND c.state='cancelled' AND c.dispatched_at IS NULL AND c.settled_at IS NOT NULL);
END $function$

;
CREATE OR REPLACE FUNCTION public.bill2_payg_finalize(a uuid, rid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;rec record;usage jsonb;selected_usage jsonb;v numeric;n numeric;w numeric;delta numeric;
 bounded numeric;debit integer;cap numeric;bound numeric;before_balance integer;after_balance integer;restored integer;
 release_amount integer;q record;meta jsonb;spent uuid;source text;bad boolean;missing boolean;erasing boolean;pending boolean;
 prices jsonb;read_margin numeric;write_margin numeric;other_margin numeric;pt bigint;ct bigint;wt bigint;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 PERFORM id FROM bill2_calls WHERE run_id=rid ORDER BY id FOR UPDATE;
 PERFORM e.id FROM bill2_receipts e JOIN bill2_calls bc ON bc.id=e.call_id WHERE bc.run_id=rid ORDER BY e.id FOR UPDATE OF e;
 PERFORM id FROM profiles WHERE id=a FOR UPDATE;
 IF NOT bill2_payg_financial_binding(r) THEN RAISE EXCEPTION 'BILL2_FINANCIAL_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(a,rid);
 IF erasing AND NOT r.closed THEN
  PERFORM bill2_cancel(a,rid);SELECT * INTO r FROM bill2_runs WHERE id=rid;
 END IF;
 FOR c IN SELECT * FROM bill2_calls WHERE run_id=rid ORDER BY provider_rejected DESC,sequence LOOP
  n:=NULL;selected_usage:=NULL;bad:=false;source:='nominal';
  FOR rec IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
   AND payload->>'coverage'='request_total' AND payload->>'final'='true' ORDER BY created_at,id LOOP
   usage:=rec.payload->'usage';
   BEGIN
    v:=bill2_payg_nominal(c.payload->'payg'->'nominalPricing',usage);
    IF v IS NOT NULL THEN
     IF n IS NOT NULL AND (n<>v OR selected_usage->>'inputTokens' IS DISTINCT FROM usage->>'inputTokens'
      OR selected_usage->>'outputTokens' IS DISTINCT FROM usage->>'outputTokens'
      OR selected_usage->>'reasoningTokens' IS DISTINCT FROM usage->>'reasoningTokens') THEN bad:=true;END IF;
     n:=v;selected_usage:=usage;
    END IF;
   EXCEPTION WHEN OTHERS THEN bad:=true;
   END;
  END LOOP;
  -- Late data may reconstruct nominal value but can never rewrite a settled debit.
  IF c.settled_at IS NOT NULL THEN
   PERFORM bill2_payg_compensate(r,c);
   IF c.nominal_source='actual_fallback' AND n IS NOT NULL THEN UPDATE bill2_calls SET nominal_reconstructed_usd=n WHERE id=c.id;END IF;
   CONTINUE;
  END IF;
  IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=rid RETURNING * INTO r;EXIT;END IF;
  IF c.provider_rejected OR c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure') THEN
   IF c.dispatched_at IS NULL AND c.state<>'cancelled' THEN CONTINUE;END IF;
   n:=0;delta:=0;bounded:=0;debit:=0;cap:=0;bound:=0;source:=CASE WHEN c.dispatched_at IS NULL THEN 'not_dispatched' ELSE 'confirmed_failure' END;
  ELSE
   IF r.conflict OR c.selected_cost_usd IS NULL THEN EXIT;END IF;
   IF n IS NULL THEN
    IF c.recovery_attempts<3 AND clock_timestamp()<coalesce(c.recovery_deadline,c.created_at+interval '24 hours')
     AND c.payload->>'lookupSupported'='true' AND c.provider_id IS NOT NULL THEN EXIT;END IF;
    n:=least(c.selected_cost_usd,c.upper_usd);source:='actual_fallback';
    UPDATE bill2_calls SET metering_missing=true WHERE id=c.id;
   END IF;
   w:=r.weighted_nominal_usd;
   delta:=ceil((w+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))*r.credits_per_usd)-ceil(w*r.credits_per_usd);
   bounded:=ceil((w+least(n,c.upper_usd)*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))*r.credits_per_usd)-ceil(w*r.credits_per_usd);
   debit:=least(delta,c.reserved_credits)::int;cap:=greatest(bounded-c.reserved_credits,0);bound:=delta-debit-cap;
   UPDATE bill2_calls SET budget_conflict=budget_conflict OR n>upper_usd OR selected_cost_usd>upper_usd
    OR coalesce((selected_usage->>'inputTokens')::bigint>(payload->'payg'->>'promptTokensUpper')::bigint,false)
    OR coalesce((selected_usage->>'outputTokens')::bigint>(payload->>'outputLimit')::bigint,false),
    metering_exit=coalesce(payload->>'protocol'<>'fixture-cost-v1' AND
     ((selected_usage->>'inputTokens')::numeric*5>=(payload->'payg'->>'bytes')::numeric*4
      OR (selected_usage->>'inputTokens')::numeric*5>=(payload->'payg'->>'promptTokensUpper')::numeric*4),false),
    reconciliation_anomaly=CASE WHEN coalesce(selected_usage->>'cachedTokens','0') ~ '^(0|[1-9][0-9]{0,9})$'
     AND coalesce(selected_usage->>'cacheCreationTokens','0') ~ '^(0|[1-9][0-9]{0,9})$'
     THEN coalesce((selected_usage->>'cachedTokens')::bigint,0)+coalesce((selected_usage->>'cacheCreationTokens')::bigint,0)>coalesce((selected_usage->>'inputTokens')::bigint,0)
     ELSE true END
    WHERE id=c.id;
  END IF;
  read_margin:=NULL;write_margin:=NULL;other_margin:=NULL;
  IF source='nominal' AND selected_usage->>'inputTokens' IS NOT NULL THEN
   pt:=(selected_usage->>'inputTokens')::bigint;
   prices:=bill2_payg_prices(c.payload->'payg'->'nominalPricing',pt);
   ct:=CASE WHEN selected_usage->>'cachedTokens' ~ '^(0|[1-9][0-9]{0,9})$' THEN (selected_usage->>'cachedTokens')::bigint END;
   wt:=CASE WHEN selected_usage->>'cacheCreationTokens' ~ '^(0|[1-9][0-9]{0,9})$' THEN (selected_usage->>'cacheCreationTokens')::bigint END;
   IF NOT coalesce(ct+wt>pt,false) THEN
    IF ct<=pt AND prices ? 'cacheRead' THEN read_margin:=ct*(bill2_decimal(prices->'prompt')-bill2_decimal(prices->'cacheRead'))/1000000;END IF;
    IF wt<=pt AND prices ? 'cacheWrite' THEN write_margin:=wt*(bill2_decimal(prices->'prompt')-bill2_decimal(prices->'cacheWrite'))/1000000;END IF;
    other_margin:=n-c.selected_cost_usd-read_margin-write_margin;
   END IF;
  END IF;
  SELECT credits INTO before_balance FROM profiles WHERE id=a;
  meta:=jsonb_build_object('contractVersion','bill2.v2','runId',rid,'callId',c.id,'preDeductId',c.pre_deduct_id,
   'providerCostUsd',c.selected_cost_usd::text,'nominalCostUsd',n::text,'nominalSource',source,
   'theoreticalDelta',delta::text,'chargedDelta',debit,'platformCapCredits',cap::text,'platformBoundCredits',bound::text);
  IF c.dispatched_at IS NULL OR source='confirmed_failure' THEN
   SELECT * INTO q FROM bill2_legacy_refund(a,c.pre_deduct_id,'BILL2 undispatched call');restored:=q.refund_amount;
  ELSE
   SELECT * INTO q FROM bill2_legacy_settle(a,c.pre_deduct_id,debit,meta,NULL);restored:=q.difference;
  END IF;
  after_balance:=q.balance_after;release_amount:=restored+debit;
  IF restored<0 OR after_balance-before_balance<>restored OR release_amount>c.reserved_credits THEN RAISE EXCEPTION 'BILL2_SOURCE_CONSERVATION';END IF;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
   idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
  VALUES(a,release_amount,'adjustment','Call reservation release','adjustment','bill2_release','ai_task',rid::text,
   'bill2:'||c.id||':release',before_balance,before_balance::bigint+release_amount,rid,c.id,meta);
  IF c.dispatched_at IS NOT NULL AND source<>'confirmed_failure' THEN
   INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
   VALUES(a,-debit,'consumption','AI call consumption','spend','bill2_spend','ai_task',rid::text,
    'bill2:'||c.id||':spend',before_balance::bigint+release_amount,after_balance,rid,c.id,meta) RETURNING id INTO spent;
   UPDATE billing_history SET transaction_id=spent WHERE operation_type='settle' AND metadata->>'preDeductId'=c.pre_deduct_id::text;
   INSERT INTO token_stats(bill2_run_id,bill2_call_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
   VALUES(rid,c.id,a,c.model,(selected_usage->>'inputTokens')::int,(selected_usage->>'outputTokens')::int,
    NULL,NULL,NULL,c.selected_cost_usd,debit,meta);
   INSERT INTO ai_usage_logs(bill2_run_id,bill2_call_id,user_id,request_id,model_id,status,metadata)
   VALUES(rid,c.id,a,c.id::text,c.model,'success',meta);
  END IF;
  UPDATE bill2_calls SET nominal_cost_usd=n,nominal_source=source,theoretical_delta=delta,charged_delta=debit,
   platform_absorbed_cap_credits=cap,platform_absorbed_bound_credits=bound,settled_at=clock_timestamp(),
   platform_margin_cache_read_usd=read_margin,platform_margin_cache_write_usd=write_margin,platform_margin_other_usd=other_margin WHERE id=c.id;
  UPDATE bill2_runs SET nominal_cost_usd=nominal_cost_usd+n,
   weighted_nominal_usd=weighted_nominal_usd+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'),
   theoretical_credits=theoretical_credits+delta,charged=coalesce(bill2_runs.charged,0)+debit,
   platform_absorbed_credits=platform_absorbed_credits+cap+bound,actual_restore=coalesce(actual_restore,0)+restored,
   version=version+1 WHERE id=rid RETURNING * INTO r;
 END LOOP;
 SELECT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND settled_at IS NULL) INTO pending;
 UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)>0
  THEN NULL ELSE coalesce(sum(selected_cost_usd),0) END FROM bill2_calls WHERE run_id=rid),
  state=CASE WHEN closed AND NOT pending THEN CASE WHEN outcome<>'confirmed_failure' AND EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND dispatched_at IS NOT NULL AND NOT provider_rejected) THEN 'settled' ELSE 'refunded' END
   WHEN pending THEN 'cost_pending' ELSE 'prepared' END,
  charged=coalesce(bill2_runs.charged,0) WHERE id=rid RETURNING * INTO r;
 IF r.theoretical_credits<>coalesce(r.charged,0)+r.platform_absorbed_credits THEN RAISE EXCEPTION 'BILL2_PAYG_CONSERVATION';END IF;
 RETURN bill2_erasure_view(r,erasing);
END $function$

;
CREATE OR REPLACE FUNCTION public.runtime_test_window_allowed(a uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE w runtime_test_windows;entry jsonb;
BEGIN
 IF p->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF p ? 'testWindowId' THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED';END IF;
  RETURN;
 END IF;
 -- Take the exclusive window lock up front; admission later checks its budget.
 -- A share-to-update upgrade would deadlock simultaneous admissions.
 SELECT * INTO w FROM runtime_test_windows WHERE id=(p->>'testWindowId')::uuid FOR UPDATE;
 IF w.id IS NULL OR NOT w.enabled OR NOT(a=ANY(w.actor_ids)) OR clock_timestamp()>=w.expires_at
 OR p->'input'->>'version' IS DISTINCT FROM 'runtime.v1' OR p->'input'->>'network' IS DISTINCT FROM 'deny'
 OR coalesce(p->'input'->'tools','[]'::jsonb) @> '["search"]'::jsonb
 OR p->'rules'->>'version' IS DISTINCT FROM 'runtime-staging-v1'
 OR p->'rules'->>'quoteVersion' IS DISTINCT FROM w.id::text
 OR bill2_decimal(p->'rules'->'creditsPerUsd')<>w.credits_per_usd
 OR bill2_decimal(p->'rules'->'multiplier')<>w.multiplier
 OR (p->'limits'->>'deadline')::timestamptz>w.expires_at
 THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED' USING ERRCODE='42501';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'callPolicy') LOOP
  IF entry->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1' OR entry->>'provider' IS DISTINCT FROM 'openrouter'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.call_policies) allowed WHERE allowed=entry OR allowed=CASE WHEN p->>'contractVersion'='bill2.v2' THEN entry-'payg' ELSE entry END)
  THEN RAISE EXCEPTION 'RUNTIME_TEST_MODEL_DENIED' USING ERRCODE='42501';END IF;
 END LOOP;
END $function$

;
CREATE OR REPLACE FUNCTION public.runtime_pending_financial_batch(p_actor_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
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
   HAVING count(*)>0 OR (r.closed AND (e.state IN ('cost_pending','cancelled') OR e.result IS NOT NULL)
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

;
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
END $function$

;
COMMIT;
