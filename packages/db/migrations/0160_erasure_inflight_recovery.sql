-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE in-flight recovery; provisional 0160 while 0159 belongs to B1.
-- Source definitions: staging 2259e8953bbfc60371ce891e0e847f6b5624c72d, file-built locally.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.bill2_read(uuid,uuid)'::regprocedure)) NOT IN ('b7a41ced1962f8ba453f67f4a2542e50','703cec867c8de958080e2e7f38c5a919') THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_SOURCE_MISMATCH: bill2_read(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.account_erasure_note_error(uuid,text)'::regprocedure)) NOT IN ('cedefb39681c338d4c63d8a048845143','f09bddd3e08a84be72b1a7bd4455d871') THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_SOURCE_MISMATCH: account_erasure_note_error(uuid,text)';END IF;
 IF md5(pg_get_functiondef('public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure)) NOT IN ('d24b8d6aa4eac6ccae0269dd52a73c7d','0d366951817eb3218256c81d060ee026') THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_SOURCE_MISMATCH: runtime_financial_recovery(uuid,uuid,boolean)';END IF;
 IF md5(pg_get_functiondef('public.runtime_receipt_saved(uuid,uuid,uuid,uuid,jsonb)'::regprocedure)) NOT IN ('77aecd183ab18cb5f15ae352eab3e1dd','4fab7f2e8586255417f0404fae55f6c7') THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_SOURCE_MISMATCH: runtime_receipt_saved(uuid,uuid,uuid,uuid,jsonb)';END IF;
 IF to_regprocedure('public.account_erasure_financial_batch(integer,uuid,uuid)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.account_erasure_financial_batch(integer,uuid,uuid)'))) <> '9b930e32526b059e57eea56092b7819b' THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_SOURCE_MISMATCH: account_erasure_financial_batch(integer,uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)'::regprocedure)) NOT IN ('df0b57cbf4ad7cbb890afb056925f951','59bb3d3fea517e5638fc78241c192bf8') THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_SOURCE_MISMATCH: bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_read(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;erasing boolean;restricted boolean;BEGIN SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 -- A financial read for the original disabled/banned actor is not business admission.
 restricted:=NOT erasing AND EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id
  AND status IN ('disabled','banned') AND is_deleted='false')
  AND r.contract_version='bill2.v1'
  AND EXISTS(SELECT 1 FROM billing_history WHERE id=r.pre_deduct_id
   AND user_id=p_actor_id AND operation_type='pre_deduct')
  AND EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=r.id
   AND (dispatched_at IS NOT NULL OR (dispatch_granted_at IS NOT NULL AND dispatch_revoked_at IS NOT NULL)));
 IF NOT erasing AND NOT restricted THEN PERFORM bill2_actor(p_actor_id);END IF;
 RETURN (CASE WHEN restricted THEN bill2_public(r)-'scope' ELSE bill2_erasure_view(r,erasing) END)||jsonb_build_object('executionId',(SELECT e.id FROM runtime_executions e
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=p_actor_id
  WHERE e.billing_run_id=r.id AND e.actor_id=p_actor_id AND r.session_ref=s.id), 'calls',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'state',state,'providerId',provider_id,'costUsd',selected_cost_usd::text,'recoveryAttempts',recovery_attempts) ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=r.id));END $function$;
CREATE OR REPLACE FUNCTION public.account_erasure_note_error(p_profile_id uuid, p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE billing boolean:=p_code LIKE 'BILLING_%';pending boolean;
BEGIN
 IF billing AND p_code NOT IN ('BILLING_PENDING','BILLING_NO_PROVIDER_ID','BILLING_EXPIRED',
  'BILLING_ATTEMPTS_EXHAUSTED','BILLING_CONFLICT','BILLING_LOOKUP_UNSUPPORTED',
  'BILLING_CREDENTIAL_UNAVAILABLE','BILLING_RECOVERY_FAILED','BILLING_CLEAR') THEN
  RAISE EXCEPTION 'ERASURE_BILLING_CODE_INVALID' USING ERRCODE='22023';
 END IF;
 IF billing THEN
  IF NOT EXISTS(SELECT 1 FROM profiles p JOIN account_erasure_requests a ON a.profile_id=p.id
   WHERE p.id=p_profile_id AND p.status='deleted' AND p.is_deleted='true') THEN
   RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT EXISTS(SELECT 1 FROM bill2_runs r WHERE r.actor_id=p_profile_id
   AND (NOT r.closed OR r.state NOT IN ('settled','refunded')
    OR EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
     WHERE e.billing_run_id=r.id AND e.actor_id=p_profile_id
     AND (e.state NOT IN ('completed','cancelled') OR s.active_execution=e.id)))) INTO pending;
  IF p_code='BILLING_CLEAR' AND pending THEN
   RAISE EXCEPTION 'ERASURE_BILLING_STILL_PENDING';
  END IF;
 END IF;
 UPDATE account_erasure_requests SET
  stage=CASE WHEN billing AND pending THEN 'billing_pending'
   WHEN billing AND stage='billing_pending' THEN 'closed' ELSE stage END,
  -- Finance progress must not hide an outstanding Auth ban failure.
  last_error_code=CASE WHEN billing AND last_error_code='AUTH_BAN_FAILED' THEN last_error_code
   WHEN p_code='BILLING_CLEAR' THEN NULL ELSE p_code END,
  retry_count=retry_count+1,stage_updated_at=clock_timestamp()
 WHERE profile_id=p_profile_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_ERASURE_REQUEST_MISSING' USING ERRCODE='P0002';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
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
 erasing:=bill2_erasure_closed(p_actor_id,b.pre_deduct_id);
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
END $function$;
CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;erasing boolean;restricted boolean;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 -- Match the exact original call, including the retained one-shot proof after revocation.
 restricted:=NOT erasing AND EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id
  AND status IN ('disabled','banned') AND is_deleted='false')
  AND r.contract_version='bill2.v1'
  AND EXISTS(SELECT 1 FROM billing_history WHERE id=r.pre_deduct_id
   AND user_id=p_actor_id AND operation_type='pre_deduct')
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
 PERFORM bill2_cancel(p_actor_id,r.id);
 PERFORM bill2_finalize(p_actor_id,r.id);
 RETURN jsonb_build_object('revoked',true,'eligible',false);
END $function$;
CREATE OR REPLACE FUNCTION public.runtime_receipt_saved(p_actor_id uuid, p_execution_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
  JOIN bill2_calls c ON c.run_id=r.id WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
  AND r.actor_id=p_actor_id AND r.id=p_run_id AND r.session_ref=e.session_id AND c.id=p_call_id)
 THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 RETURN EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=p_call_id AND payload_hash=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex'));
END $function$;
-- Read only discovery: the erasure request and original financial binding remain the authority.
-- Unknown/exhausted rows remain in the report even when no automatic work is possible.
CREATE OR REPLACE FUNCTION public.account_erasure_financial_batch(
 p_limit integer DEFAULT 20, p_profile_id uuid DEFAULT NULL, p_after_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_erasure_requests a
  JOIN profiles p ON p.id=a.profile_id WHERE p.id=p_profile_id
  AND p.status='deleted' AND p.is_deleted='true') THEN
  RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
 END IF;
 WITH candidates AS MATERIALIZED (
  SELECT r.*, e.id execution_id,e.state execution_state,s.active_execution,
   a.confirmed_at,a.stage_updated_at,
   CASE
    WHEN r.conflict THEN 'BILLING_CONFLICT'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.provider_id IS NULL) THEN 'BILLING_NO_PROVIDER_ID'
    WHEN r.deadline+interval '24 hours'<clock_timestamp() THEN 'BILLING_EXPIRED'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.recovery_attempts>=3) THEN 'BILLING_ATTEMPTS_EXHAUSTED'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.payload->>'lookupSupported' IS DISTINCT FROM 'true')
     THEN 'BILLING_LOOKUP_UNSUPPORTED'
    ELSE 'BILLING_PENDING' END reason,
   (NOT r.closed OR e.state NOT IN ('completed','cancelled','cost_pending') OR s.active_execution=e.id
    OR (r.state IN ('settled','refunded') AND e.state NOT IN ('completed','cancelled'))
    OR (r.state NOT IN ('settled','refunded') AND NOT r.conflict AND
     (NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id
       AND c.dispatched_at IS NOT NULL AND c.selected_cost_usd IS NULL)
      OR (r.deadline+interval '24 hours'>=clock_timestamp() AND EXISTS(
       SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
       AND c.selected_cost_usd IS NULL AND c.provider_id IS NOT NULL AND c.recovery_attempts<3
       AND c.payload->>'lookupSupported'='true'))))) needs_work
  FROM account_erasure_requests a JOIN profiles p ON p.id=a.profile_id
  JOIN bill2_runs r ON r.actor_id=p.id
  JOIN runtime_executions e ON e.billing_run_id=r.id AND e.actor_id=p.id
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=p.id AND r.session_ref=s.id
  WHERE p.status='deleted' AND p.is_deleted='true'
   AND bill2_erasure_closed(p.id,r.pre_deduct_id)
   AND (p_profile_id IS NULL OR p.id=p_profile_id)
   AND (r.state NOT IN ('settled','refunded') OR NOT r.closed
    OR e.state NOT IN ('completed','cancelled') OR s.active_execution=e.id)
 ), chosen AS (
  SELECT actor_id FROM candidates WHERE needs_work
  ORDER BY stage_updated_at,actor_id,id LIMIT 1
 ), page AS MATERIALIZED (
  SELECT c.* FROM candidates c JOIN chosen a USING(actor_id)
  WHERE c.needs_work AND (p_after_run_id IS NULL OR c.id>p_after_run_id)
  ORDER BY c.id LIMIT p_limit
 )
 SELECT jsonb_build_object(
  'selectedActorId',(SELECT actor_id FROM chosen),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'actorId',actor_id,'executionId',execution_id,'runId',id,'sessionId',session_ref,
   'state',state,'executionState',execution_state,'closed',closed,'reason',reason,
   'confirmedAt',confirmed_at,
   'recoveryPolicy',jsonb_build_object('id',test_window_id,'expiresAt',deadline,
    'creditsPerUsd',credits_per_usd::text,'multiplier',multiplier::text,
    'callPolicies',(SELECT jsonb_agg(jsonb_build_object(
     'modelId',v->>'modelId','provider',v->>'provider','account',v->>'account','model',v->>'model',
     'protocol',v->>'protocol','upperUsd',v->>'upperUsd','inputLimit',v->'inputLimit',
     'outputLimit',v->'outputLimit','automaticRetry',v->'automaticRetry',
     'hiddenTools',v->'hiddenTools','lookupSupported',v->'lookupSupported'))
     FROM jsonb_array_elements(payload->'callPolicy') v))) ORDER BY id) FROM page),'[]'::jsonb),
  'nextRunId',CASE WHEN (SELECT count(*) FROM page)=p_limit
   THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END,
  'totalPending',(SELECT count(*) FROM candidates),
  'oldestPendingAt',(SELECT min(confirmed_at) FROM candidates),
  'reasons',coalesce((SELECT jsonb_object_agg(reason,n) FROM
    (SELECT reason,count(*) n FROM candidates GROUP BY reason) counts),'{}'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_financial_batch(integer,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.account_erasure_financial_batch(integer,uuid,uuid) TO service_role;

COMMIT;
