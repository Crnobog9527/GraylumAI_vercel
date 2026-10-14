/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- BILL2: dispatched PAYG calls whose cost never becomes known must not freeze credits forever.
-- (A) A complete pre-generation refusal (HTTP 400/401/403/422/429) joins the #627 rule: it is
--     only a pending refusal until a later lookup proves not_found or no_cost; then it settles at
--     zero cost exactly like a 402. 402 itself is unchanged. Controller 2026-10-14 (G1).
-- (B) Existing rule (V3-BILL-2 §unknown outcome, FUSION-REVIEW §3.3): once automatic recovery has
--     ended (its deadline passed), an administrator enters the verified provider cost (0 when the provider generated
--     nothing) with a reason; the call then settles once through the unchanged min(c,U) fallback.
-- (C) A read-only list of such calls for the daily reconciliation alert and the admin page.
-- No automatic release, no new charge formula; finalize itself is not modified.
BEGIN;

DO $$ DECLARE src text;a1 text;a2 text;a3 text;a4 text;a5 text;
BEGIN
 src:=pg_get_functiondef('public.bill2_record(uuid,uuid,uuid,jsonb)'::regprocedure);
 IF position('-- 0261 pre-generation refusals' IN src)=0 THEN
  a1:=$x$   OR p_evidence#>'{transport,httpStatus}' IS DISTINCT FROM '402'::jsonb$x$;
  a2:=$x$   OR rejection#>'{error,code}' IS DISTINCT FROM '402'::jsonb$x$;
  a3:=$x$   OR jsonb_typeof(rejection#>'{error,metadata}') IS DISTINCT FROM 'object'$x$;
  a4:=$x$   OR (rejection#>'{error,metadata}' ? 'remedy_hint' AND jsonb_typeof(rejection#>'{error,metadata,remedy_hint}')<>'string')$x$;
  a5:=$x$'limitSource',rejection#>>'{error,metadata,limit_source}');$x$;
  IF array_length(string_to_array(src,a1),1)<>2 OR array_length(string_to_array(src,a2),1)<>2
   OR array_length(string_to_array(src,a3),1)<>2 OR array_length(string_to_array(src,a4),1)<>2
   OR array_length(string_to_array(src,a5),1)<>2 THEN
   RAISE EXCEPTION 'BILL2_SOURCE_MISMATCH: bill2_record 0261'; END IF;
  src:=replace(src,a1,$x$   -- 0261 pre-generation refusals: 402 as before; 400/401/403/422/429 only as a pending
   -- refusal (a generation id), confirmed later by a not_found/no_cost lookup, never immediately.
   OR coalesce(p_evidence#>>'{transport,httpStatus}','') NOT IN ('400','401','402','403','422','429')
   OR (NOT pending_rejection AND p_evidence#>'{transport,httpStatus}' IS DISTINCT FROM '402'::jsonb)$x$);
  src:=replace(src,a2,$x$   OR rejection#>'{error,code}' IS DISTINCT FROM p_evidence#>'{transport,httpStatus}'$x$);
  -- The 402 metadata rules stay exact; other statuses accept only an optional metadata object,
  -- which is validated for shape and then dropped with the rest of the private body.
  src:=replace(src,a3,$x$   OR (p_evidence#>'{transport,httpStatus}'='402'::jsonb AND (jsonb_typeof(rejection#>'{error,metadata}') IS DISTINCT FROM 'object'$x$);
  src:=replace(src,a4,a4||$x$))
   OR (p_evidence#>'{transport,httpStatus}' IS DISTINCT FROM '402'::jsonb AND (rejection->'error') ? 'metadata'
    AND jsonb_typeof(rejection#>'{error,metadata}') IS DISTINCT FROM 'object')$x$);
  src:=replace(src,a5,$x$'limitSource',rejection#>>'{error,metadata,limit_source}')
    ||CASE WHEN p_evidence#>'{transport,httpStatus}' IS DISTINCT FROM '402'::jsonb
     THEN jsonb_build_object('rejectionStatus',(p_evidence#>>'{transport,httpStatus}')::integer) ELSE '{}'::jsonb END;$x$);
  EXECUTE src;
 END IF;
END $$;

-- A dispatched, unsettled PAYG call with no known cost whose automatic recovery has ended. Only the
-- deadline ends it: attempts are counted when a lookup starts and claims continue until the deadline.
-- After it bill2_recovery_claim grants no lookup; ten more minutes let one already started finish.
CREATE OR REPLACE FUNCTION public.bill2_payg_call_stuck(c bill2_calls,r bill2_runs) RETURNS boolean
LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT r.contract_version='bill2.v2' AND r.state='cost_pending' AND NOT r.conflict
  AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND c.selected_cost_usd IS NULL AND NOT c.provider_rejected
  AND clock_timestamp()>=coalesce(c.recovery_deadline,c.created_at+interval '24 hours')+interval '10 minutes'
$$;

CREATE OR REPLACE FUNCTION public.bill2_payg_stuck_calls(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE total bigint;calls jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'BILL2_STUCK_CALLS_DENIED';END IF;
 SELECT count(*) INTO total FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE bill2_payg_call_stuck(c,r);
 -- Content-free evidence only: statuses and reasons, never bodies or conversation text.
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'dispatchedAt'),'[]') INTO calls FROM (
  SELECT jsonb_build_object('callId',c.id,'runId',r.id,'actorId',r.actor_id,'model',c.model,'phase',c.payload->>'phase',
   'upperUsd',c.upper_usd,'reservedCredits',c.reserved_credits,'dispatchedAt',c.dispatched_at,
   'recoveryDeadline',c.recovery_deadline,'recoveryAttempts',c.recovery_attempts,'fusionVerdict',c.fusion_verdict,
   'receipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('source',rc.payload->>'source',
     'httpStatus',CASE WHEN rc.payload#>>'{transport,httpStatus}' ~ '^[1-5][0-9]{2}$' THEN (rc.payload#>>'{transport,httpStatus}')::integer END,
     'rejectedReason',rc.payload->>'rejectedReason','observedAt',rc.created_at) ORDER BY rc.created_at),'[]')
    FROM bill2_receipts rc WHERE rc.call_id=c.id)) x
  FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE bill2_payg_call_stuck(c,r)
  ORDER BY c.dispatched_at LIMIT p_limit) s;
 RETURN jsonb_build_object('total',total,'calls',calls);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_payg_admin_settle_call(p_admin_id uuid,p_request_id uuid,p_call_id uuid,
 p_verified_cost_usd numeric,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls;r bill2_runs;e runtime_executions;prior user_activity_logs;reason text:=btrim(coalesce(p_reason,''));
 before_credits bigint;after_credits bigint;before_state jsonb;result jsonb;terminal text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_admin_id AND role='admin' AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_DENIED' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_call_id IS NULL OR p_verified_cost_usd IS NULL OR p_verified_cost_usd<0
  OR p_verified_cost_usd>1000 OR scale(p_verified_cost_usd)>12 OR length(reason) NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_DENIED';END IF;
 -- Runtime writers lock session -> execution -> run; then the order of record/finalize: run, sorted
 -- model locks, call, receipts, and both profiles in id order (admin and account may differ).
 SELECT * INTO e FROM runtime_executions WHERE billing_run_id=(SELECT run_id FROM bill2_calls WHERE id=p_call_id);
 IF e.id IS NOT NULL THEN
  PERFORM id FROM runtime_sessions WHERE id=e.session_id FOR UPDATE;
  SELECT * INTO e FROM runtime_executions WHERE id=e.id FOR UPDATE;
 END IF;
 SELECT * INTO r FROM bill2_runs WHERE id=(SELECT run_id FROM bill2_calls WHERE id=p_call_id) FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 PERFORM id FROM bill2_receipts WHERE call_id=c.id ORDER BY id FOR UPDATE;
 -- FOR UPDATE in id order: finalize updates the account profile (possibly this admin); a shared lock
 -- would deadlock on upgrade, and an admin-first order would invert against another admin's settlement.
 PERFORM id FROM profiles WHERE id IN (p_admin_id,r.actor_id) ORDER BY id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_admin_id AND role='admin' AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO prior FROM user_activity_logs WHERE id=p_request_id;
 IF prior.id IS NOT NULL THEN
  IF prior.action<>'bill2_admin_settle_call' OR prior.admin_id IS DISTINCT FROM p_admin_id
   OR prior.details->>'callId' IS DISTINCT FROM c.id::text
   OR (prior.details->>'verifiedCostUsd')::numeric IS DISTINCT FROM p_verified_cost_usd
   OR prior.details->>'reason' IS DISTINCT FROM reason
  THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_CONFLICT';END IF;
  RETURN prior.details->'result';
 END IF;
 IF NOT bill2_payg_call_stuck(c,r) THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_NOT_READY';END IF;
 SELECT credits INTO before_credits FROM profiles WHERE id=r.actor_id;
 before_state:=jsonb_build_object('callState',c.state,'reservedCredits',c.reserved_credits,'runState',r.state,
  'runCharged',r.charged,'credits',before_credits);
 -- The verified cost is the known c of the existing rule; finalize settles it once via min(c,U).
 UPDATE bill2_calls SET selected_cost_usd=p_verified_cost_usd,state='responded' WHERE id=c.id;
 PERFORM bill2_finalize(r.actor_id,r.id);
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id;
 SELECT * INTO r FROM bill2_runs WHERE id=r.id;
 IF c.settled_at IS NULL THEN RAISE EXCEPTION 'BILL2_ADMIN_SETTLE_INCOMPLETE';END IF;
 -- A Runtime-bound run finishes its execution and releases the session, exactly as the p_finish branch
 -- of runtime_financial_recovery does for a settled run; an erased account is left to erasure.
 IF e.id IS NOT NULL AND r.state IN ('settled','refunded') AND NOT coalesce(bill2_erasure_closed(r.actor_id,coalesce(r.pre_deduct_id,r.id)),false) THEN
  terminal:=CASE WHEN e.result IS NULL THEN 'cancelled' ELSE 'completed' END;
  IF e.state IS DISTINCT FROM terminal THEN UPDATE runtime_executions SET state=terminal WHERE id=e.id RETURNING * INTO e;END IF;
  UPDATE runtime_sessions SET active_execution=NULL WHERE id=e.session_id AND active_execution=e.id;
 END IF;
 SELECT credits INTO after_credits FROM profiles WHERE id=r.actor_id;
 result:=jsonb_build_object('callId',c.id,'runId',r.id,'actorId',r.actor_id,'verifiedCostUsd',p_verified_cost_usd,
  'nominalCostUsd',c.nominal_cost_usd,'chargedDelta',c.charged_delta,'runState',r.state,'runCharged',r.charged,
  'actualRestore',r.actual_restore,'creditsBefore',before_credits,'creditsAfter',after_credits,'settledAt',c.settled_at,
  'executionId',e.id,'executionState',e.state,'auditId',p_request_id);
 INSERT INTO user_activity_logs(id,user_id,admin_id,action,action_type,details)
 VALUES(p_request_id,r.actor_id,p_admin_id,'bill2_admin_settle_call','admin',jsonb_build_object(
  'callId',c.id,'runId',r.id,'model',c.model,'verifiedCostUsd',p_verified_cost_usd,'reason',reason,
  'before',before_state,'result',result));
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.bill2_payg_call_stuck(bill2_calls,bill2_runs),public.bill2_payg_stuck_calls(integer),
 public.bill2_payg_admin_settle_call(uuid,uuid,uuid,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bill2_payg_stuck_calls(integer),
 public.bill2_payg_admin_settle_call(uuid,uuid,uuid,numeric,text) TO service_role;
COMMIT;
