-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAYG-THRESHOLD-AUTO: no data/config writes; preserve frozen calls and settlement.
-- Apply before switching settings to typicalUsd. Legacy integer entries remain readable.
-- Recovery: restore legacy settings before restoring the predecessor function;
-- never rewrite existing calls, holds, receipts or ledger entries.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);
 source_md5:=md5(definition);
 IF source_md5='d911ef615331f19cd0d128b0b3558e01' THEN RETURN;END IF;
 IF source_md5<>'f12b6962b2883df773d984f3b187b1b4' THEN
  RAISE EXCEPTION 'PAYG_THRESHOLD_SOURCE_MISMATCH';
 END IF;
 definition:=$definition$CREATE OR REPLACE FUNCTION public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;w runtime_test_windows;n integer;used numeric;used_calls bigint;
 cfg jsonb;threshold jsonb;avail integer;quarantine bigint;g numeric;h integer;q record;u numeric;m_call numeric;l numeric;
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
 IF r.payload#>'{input,reportGeneration}' IS NOT NULL THEN
  PERFORM report_membership_check(a);
  IF p->>'phase' IS DISTINCT FROM 'report' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  IF (report_source(a,r.session_ref,(r.payload#>>'{input,reportGeneration,projectId}')::uuid,
    (r.payload#>>'{input,reportGeneration,roundId}')::uuid)->>'snapshotHash')
    IS DISTINCT FROM r.payload#>>'{input,reportGeneration,snapshotHash}' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
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
 -- The same frozen call multiplier is used for both L and G.
 m_call:=bill2_unit_multiplier(p->'billingUnit'->'multiplier');
 SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds' FOR SHARE;
 IF jsonb_typeof(cfg->'version') IS DISTINCT FROM 'string' OR btrim(cfg->>'version')=''
  OR jsonb_typeof(cfg->'thresholds') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
 END IF;
 SELECT x INTO threshold FROM jsonb_array_elements(cfg->'thresholds') x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase';
 IF (SELECT count(*) FROM jsonb_array_elements(cfg->'thresholds') x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase')<>1 THEN
  RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
 END IF;
 IF threshold ? 'typicalUsd' THEN
  -- Never fall back to legacy credits for an invalid or ambiguous new entry.
  IF threshold ? 'credits' OR jsonb_typeof(threshold->'typicalUsd') IS DISTINCT FROM 'string'
   OR coalesce(threshold->>'typicalUsd','') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' THEN
   RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
  END IF;
  l:=greatest(1,ceil((threshold->>'typicalUsd')::numeric*r.credits_per_usd*m_call));
  IF l>2147483647 THEN RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';END IF;
 ELSE
  -- Transitional reads retain the existing integer-credit meaning, without rescaling.
  IF coalesce(threshold->>'credits','') !~ '^[1-9][0-9]{0,8}$' THEN
   RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
  END IF;
  l:=(threshold->>'credits')::int;
 END IF;
 -- The balance already excludes all pre-deductions. Subtract only unavailable grant remainder.
 PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=a AND accounting_state<>'trusted') THEN
  RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';END IF;
 SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine
 FROM subscription_credit_grants g WHERE g.user_id=a AND g.status='granted' AND g.accounting_state='trusted'
 AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);
 avail:=greatest(avail-quarantine,0);
 IF avail<l THEN
  UPDATE bill2_runs SET paused_reason='insufficient_credits',version=version+1 WHERE id=rid;
  RETURN jsonb_build_object('id',NULL,'state','waiting_credits','dispatchToken',NULL);
 END IF;
 g:=ceil(u*r.credits_per_usd*m_call);h:=least(g,avail)::int;
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
  start_threshold=l::int,threshold_version=cfg->>'version' WHERE id=c.id;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
  idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
 VALUES(a,-h,'adjustment','Call reservation','adjustment','bill2_reserve','ai_task',rid::text,
 'bill2:'||c.id||':reserve',q.balance_before,q.balance_after,rid,c.id,
 jsonb_build_object('contractVersion','bill2.v2','preDeductId',q.pre_deduct_id,'G',g::text,'H',h,'A',avail,'L',l::int,'thresholdVersion',cfg->>'version'));
 UPDATE bill2_runs SET paused_reason=NULL,version=version+1 WHERE id=rid;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $function$
$definition$;
 IF md5(definition)<>'d911ef615331f19cd0d128b0b3558e01' THEN RAISE EXCEPTION 'PAYG_THRESHOLD_TARGET_MISMATCH';END IF;
 EXECUTE definition;
END $migration$;
COMMIT;
