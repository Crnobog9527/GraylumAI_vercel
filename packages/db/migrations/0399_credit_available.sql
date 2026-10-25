-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MAINT-P4 CREDIT-AVAIL (maintainability audit A4, 2026-10-25): one formula for the credits a user may spend.
--
-- Before: atomic_pre_deduct and bill2_payg_claim each computed "balance - quarantined grant remainder - held refund packs
--   - pending dispute holds" and each raised PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED on an untrusted grant. 0285 and
--   0308 had to patch both copies; a new kind of hold added to only one would let the other path spend it.
-- After: credit_available(user) is the only place that knows the review barrier and the holds; both functions call it.
--   A future hold is added there once.
--
-- The two copies differed only for a grant frozen by a payment dispute (dispute_frozen). credit_available keeps the
-- safe side of each:
--   * Review barrier: every grant of the user, frozen or not (bill2_payg_claim's rule). atomic_pre_deduct skipped frozen
--     grants; a frozen grant whose accounting is no longer trusted now stops it too (fail-closed). pay_dispute_freeze
--     only freezes trusted grants, so this needs a later accounting change on a frozen grant.
--   * Quarantine sum: frozen grants are skipped (atomic_pre_deduct's rule). Their remainder has already left the
--     balance (pay_dispute_freeze / pay_dispute_source_sync) or is counted by pay_dispute_pending_hold, so
--     bill2_payg_claim subtracted a frozen grant of a terminated subscription twice and paused calls the user could pay.
-- Everything else is unchanged: same exceptions at the same points, same result for every other balance.
--
-- credit_available returns balance minus holds without clamping (it can be negative); callers clamp exactly as before:
--   bill2_payg_claim: greatest(avail - holds, 0); atomic_pre_deduct: GREATEST(balance - period part - holds, 0).
-- It reads profiles.credits; both callers already hold that row's lock. STABLE: it locks and writes nothing.
--
-- Compatibility: signatures, results and grants of both functions are kept (CREATE OR REPLACE). Old application code
-- calls them the same way. Repeatable: a re-run finds the new definitions and replaces them with the same text.
-- Base check: a function whose current definition is neither the expected predecessor nor this file's result stops
-- the migration (a concurrent change would otherwise be overwritten).
-- Recovery: re-create the two predecessor bodies (packages/db/functions/billing/{atomic_pre_deduct,bill2_payg_claim}.sql
-- at the parent commit) and drop credit_available(uuid). No data changes.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE f record;
BEGIN
 FOR f IN SELECT * FROM (VALUES
  ('public.atomic_pre_deduct(uuid,integer,text,uuid)','@PRE_BEFORE@','@PRE_AFTER@'),
  ('public.bill2_payg_claim(uuid,uuid,integer,jsonb)','@CLAIM_BEFORE@','@CLAIM_AFTER@')) x(sig,before,after) LOOP
  IF md5(pg_get_functiondef(f.sig::regprocedure)) NOT IN (f.before,f.after) THEN
   RAISE EXCEPTION 'MAINT_P4_BASE_MISMATCH: %',f.sig;END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.credit_available(p_user uuid) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE balance integer;held bigint;
BEGIN
 -- An untrusted grant (review required) stops every spend until it is explicitly transitioned.
 IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=p_user AND accounting_state<>'trusted') THEN
  RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';END IF;
 SELECT credits INTO balance FROM profiles WHERE id=p_user;
 -- Remainder of quarantined grants (terminated subscription, first-purchase refund hold); no period filter.
 -- A dispute-frozen grant is not counted here: its remainder is out of the balance or in pay_dispute_pending_hold.
 SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO held
 FROM subscription_credit_grants g WHERE g.user_id=p_user AND NOT g.dispute_frozen AND g.status='granted'
  AND g.accounting_state='trusted' AND credit_grant_quarantined(g);
 -- Held refund packs and in-flight dispute holds. A new kind of hold is added here, and only here.
 held:=held+credit_package_refund_hold(p_user)+pay_dispute_pending_hold(p_user);
 RETURN (balance-held)::integer;
END $$;
REVOKE ALL ON FUNCTION public.credit_available(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.atomic_pre_deduct(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'AI 对话预扣'::text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(pre_deduct_id uuid, balance_before integer, balance_after integer, is_idempotent boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pre_deduct_id UUID;
  v_effective_subscription_id UUID;
  v_effective_membership JSONB;
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_existing_id UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_covering_count INTEGER := 0;
  v_missing_mirror_count INTEGER := 0;
  v_malformed_covering_count INTEGER := 0;
  v_unexpected_status_count INTEGER := 0;
  v_canonical_candidate_count INTEGER := 0;
  v_available INTEGER;
  v_to_period INTEGER := 0;
  v_to_other INTEGER;
BEGIN
 -- PAY-D1 current-source
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM billing_history
    WHERE user_id = p_user_id
      AND operation_type = 'pre_deduct'
      AND metadata->>'requestId' = p_request_id::TEXT
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT metadata->>'balance_before', metadata->>'balance_after'
      INTO v_balance_before, v_balance_after
      FROM billing_history
      WHERE id = v_existing_id;

      RETURN QUERY SELECT
        v_existing_id,
        COALESCE(v_balance_before::INTEGER, 0),
        COALESCE(v_balance_after::INTEGER, 0),
        TRUE;
      RETURN;
    END IF;
  END IF;

  SELECT credits INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- ARCH-FIX E3: a concurrent call with the same request committed while this one waited for the profile lock.
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM billing_history
    WHERE user_id = p_user_id AND operation_type = 'pre_deduct' AND metadata->>'requestId' = p_request_id::TEXT;
    IF v_existing_id IS NOT NULL THEN
      SELECT metadata->>'balance_before',metadata->>'balance_after' INTO v_balance_before,v_balance_after
      FROM billing_history WHERE id = v_existing_id;
      RETURN QUERY SELECT v_existing_id,COALESCE(v_balance_before::INTEGER,0),COALESCE(v_balance_after::INTEGER,0),TRUE;
      RETURN;
    END IF;
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION '预扣积分必须为正数: %', p_amount;
  END IF;

  IF v_balance_before < p_amount THEN
    RAISE EXCEPTION '积分不足: 需要 %, 当前 %', p_amount, v_balance_before;
  END IF;

  -- Current-grant census: period predicates are intentional here because
  -- these counters locate and validate the grant allocated by this request.
  SELECT
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND (us.id IS NULL OR us.credit_release_terminated_at IS NULL)
    ),
    count(*) FILTER (WHERE g.status = 'granted' AND us.id IS NULL),
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND g.accounting_state = 'trusted'
        AND us.id IS NOT NULL
        AND us.credit_release_terminated_at IS NULL
        AND NOT COALESCE(public.pay_waffo_canonical_grant(us,g), FALSE)
    ),
    count(*) FILTER (WHERE g.status IS NULL OR g.status NOT IN ('granted', 'reversed')),
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND g.accounting_state = 'trusted'
        AND us.id IS NOT NULL
        AND us.credit_release_terminated_at IS NULL
        AND COALESCE(public.pay_waffo_canonical_grant(us,g), FALSE)
    )
  INTO v_covering_count, v_missing_mirror_count, v_malformed_covering_count,
       v_unexpected_status_count, v_canonical_candidate_count
  FROM subscription_credit_grants AS g
  LEFT JOIN user_subscriptions AS us
    ON (us.id = g.subscription_id OR (g.subscription_id IS NULL AND us.stripe_subscription_id = g.stripe_subscription_id))
   AND us.user_id = p_user_id
  WHERE g.user_id = p_user_id AND NOT g.dispute_frozen
    AND g.period_start <= now()
    AND g.period_end > now();

  -- MAINT-P4: the review barrier and every hold (quarantined grants, held packs, pending disputes) come
  -- from credit_available, the one formula shared by every spend path.
  v_available := public.credit_available(p_user_id);

  -- PAY-STRIPE-MP upgrade overlap: allow only the paid upgrade's exact prior subscription.
  -- The census still validates EVERY current source. Malformed, frozen, terminated,
  -- untrusted and unrelated duplicate sources retain their existing protections.
  IF v_covering_count > 1 OR v_canonical_candidate_count > 1 THEN
    v_effective_membership := pay_common_membership_facts(p_user_id)->'internal_membership';
    IF v_effective_membership->>'mapping_state'='internal_paid' THEN
      v_effective_subscription_id := (v_effective_membership->>'id')::uuid;
    END IF;
    IF v_covering_count<>2 OR v_canonical_candidate_count<>2 OR NOT EXISTS (
      SELECT 1 FROM payment_orders upgrade
      JOIN user_subscriptions prior ON prior.id=upgrade.method_prior_subscription AND prior.user_id=upgrade.user_id
      JOIN subscription_credit_grants old_grant ON old_grant.subscription_id=prior.id AND old_grant.user_id=prior.user_id
      JOIN subscription_credit_grants new_grant ON new_grant.subscription_id=upgrade.subscription_id
        AND new_grant.user_id=upgrade.user_id
      WHERE upgrade.user_id=p_user_id AND upgrade.subscription_id=v_effective_subscription_id
        AND upgrade.method_transition='upgrade' AND upgrade.purchase_membership_level='gold'
        AND upgrade.status='completed' AND upgrade.payment_status='paid' AND upgrade.fulfilled_at IS NOT NULL
        AND upgrade.method_review_reason IS NULL AND NOT pay_dispute_order_frozen(upgrade.id)
        AND (prior.cancel_at_period_end='true' OR prior.method_cancel_requested_at IS NOT NULL)
        AND old_grant.stripe_subscription_id IS NULL AND new_grant.stripe_subscription_id IS NULL
        AND old_grant.status='granted' AND new_grant.status='granted'
        AND old_grant.accounting_state='trusted' AND new_grant.accounting_state='trusted'
        AND NOT old_grant.dispute_frozen AND NOT new_grant.dispute_frozen
        AND old_grant.period_start<=now() AND old_grant.period_end>now()
        AND new_grant.period_start<=now() AND new_grant.period_end>now()
    ) THEN
      RAISE EXCEPTION 'PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: %',
        GREATEST(v_covering_count, v_canonical_candidate_count);
    END IF;
  END IF;

  IF v_missing_mirror_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_SUBSCRIPTION_MIRROR_MISSING';
  END IF;

  IF v_malformed_covering_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_NONCANONICAL_GRANT_WINDOW';
  END IF;

  IF v_unexpected_status_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_UNEXPECTED_GRANT_STATUS';
  END IF;

  IF v_covering_count > 0 AND v_canonical_candidate_count = 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_NONCANONICAL_GRANT_WINDOW';
  END IF;

  SELECT g.id, g.grant_period_key, g.credits_granted, g.consumed_amount
  INTO v_charged_grant_id, v_period_key, v_grant_granted, v_grant_consumed
  FROM subscription_credit_grants AS g
  JOIN user_subscriptions AS us
    ON (us.id = g.subscription_id OR (g.subscription_id IS NULL AND us.stripe_subscription_id = g.stripe_subscription_id))
   AND us.user_id = p_user_id
  WHERE g.user_id = p_user_id AND NOT g.dispute_frozen
    AND g.status = 'granted'
    AND g.accounting_state = 'trusted'
    AND g.period_start <= now()
    AND g.period_end > now()
    AND us.credit_release_terminated_at IS NULL
    AND COALESCE(public.pay_waffo_canonical_grant(us,g), FALSE)
    AND (v_effective_subscription_id IS NULL OR g.subscription_id=v_effective_subscription_id)
  FOR UPDATE OF g;

  v_to_other := p_amount;
  IF v_charged_grant_id IS NOT NULL THEN
    v_to_period := LEAST(p_amount, GREATEST(v_grant_granted - v_grant_consumed, 0));
    v_to_other := p_amount - v_to_period;
  END IF;

  IF v_to_other > GREATEST(v_available - v_to_period, 0) THEN
    RAISE EXCEPTION 'PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED';
  END IF;

  v_balance_after := v_balance_before - p_amount;
  UPDATE profiles SET credits = v_balance_after WHERE id = p_user_id;

  IF v_charged_grant_id IS NOT NULL AND v_to_period > 0 THEN
    UPDATE subscription_credit_grants
    SET consumed_amount = consumed_amount + v_to_period,
        updated_at = now()
    WHERE id = v_charged_grant_id
      AND accounting_state = 'trusted';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';
    END IF;
  END IF;

  INSERT INTO billing_history (user_id, operation_type, amount, reason, metadata)
  VALUES (
    p_user_id,
    'pre_deduct',
    -p_amount,
    p_reason,
    jsonb_build_object(
      'balance_before', v_balance_before,
      'balance_after', v_balance_after,
      'timestamp', now()::TEXT,
      'requestId', p_request_id,
      'chargedGrantId', v_charged_grant_id,
      'chargedPeriodKey', v_period_key,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other
    )
  )
  RETURNING id INTO v_pre_deduct_id;

  PERFORM credit_source_apply(p_user_id, v_pre_deduct_id, v_to_other, 'reserve'); -- PR-D0 credit sources
  RETURN QUERY SELECT v_pre_deduct_id, v_balance_before, v_balance_after, FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;w runtime_test_windows;n integer;used numeric;used_calls bigint;
 cfg jsonb;threshold jsonb;avail integer;g numeric;h integer;q record;u numeric;m_call numeric;l numeric;
BEGIN
 -- 0326 Fusion run archive guard
 -- 0324 archived business guard
 PERFORM opc_assert_business_writable(a,jsonb_build_object('runId',rid));
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 -- DB-100 C2 payload read once: fetch and decompress the TOAST value here, not at every r.payload use.
 -- A run payload is always a JSON object (bill2_prepare); || '{}' returns it unchanged.
 r.payload:=r.payload||'{}'::jsonb;
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
 IF (fusion_purpose(p) OR r.fusion_group_id IS NOT NULL) AND (r.fusion_group_id IS NULL
  OR current_setting('graylum.fusion_group_claim',true) IS DISTINCT FROM r.fusion_group_id::text) THEN
  RAISE EXCEPTION 'FUSION_GROUP_CLAIM_REQUIRED';END IF;
 IF r.payload#>'{input,reportGeneration}' IS NOT NULL THEN
  PERFORM report_membership_check(a);
  IF p->>'phase' IS DISTINCT FROM 'report' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  IF (report_source(a,r.session_ref,(r.payload#>>'{input,reportGeneration,projectId}')::uuid,
    (r.payload#>>'{input,reportGeneration,roundId}')::uuid)->>'snapshotHash')
    IS DISTINCT FROM r.payload#>>'{input,reportGeneration,snapshotHash}' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  -- 0268 benchmark claim
  PERFORM research_benchmark_report_current(a,r.session_ref,r.payload#>'{input,reportGeneration}');
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
 -- 0255 tool quote
 IF p->>'protocol'='research-tool-v1' THEN PERFORM bill2_payg_validate_tool_quote(r,p);
 ELSE PERFORM bill2_payg_validate_quote(r,p);END IF;
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
 IF r.fusion_group_id IS NOT NULL AND current_setting('graylum.fusion_group_claim',true)=r.fusion_group_id::text THEN
  cfg:=jsonb_build_object('version','fusion-group-bound');l:=greatest(1,ceil(u*r.credits_per_usd*m_call));
 ELSE
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
 END IF;
 -- The balance already excludes all pre-deductions. Subtract only unavailable grant remainder.
 PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
 avail:=greatest(credit_available(a),0); -- MAINT-P4 one formula: review barrier and every hold
 IF avail<l THEN
  UPDATE bill2_runs SET paused_reason='insufficient_credits',version=version+1 WHERE id=rid;
  RETURN jsonb_build_object('id',NULL,'state','waiting_credits','dispatchToken',NULL);
 END IF;
 g:=ceil(u*r.credits_per_usd*m_call);h:=least(g,avail)::int;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd)
 VALUES(rid,seq,p,p->>'provider',p->>'account',p->>'model',u) RETURNING * INTO c;
  -- DB-PERF 0362 late metering check: a block committed by a writer holding (201,1) exclusively
  -- is visible here; a writer that comes later waits for this claim to commit.
  PERFORM pg_advisory_xact_lock_shared(201,1);
  IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>'model' AND x.id<>c.id
   AND (x.budget_conflict OR x.metering_missing OR x.metering_exit) AND x.metering_review_audit_id IS NULL)
  THEN RAISE EXCEPTION 'BILL2_PAYG_METERING_BLOCKED';END IF;
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
END $function$;

COMMIT;
