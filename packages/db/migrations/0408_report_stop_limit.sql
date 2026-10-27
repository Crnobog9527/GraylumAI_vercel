-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- REPORT-GEN: rolling user-stop allowance and actual-cost settlement.
-- Old callers remain compatible and retain full refunds; new callers use report_stop.
-- Repeatable: additive columns and indexes plus CREATE OR REPLACE functions.
-- Recovery: stop report admission and cancellation before rolling back the app. Keep these columns,
-- fees and ledger entries. First resolve every held chargeable stop using its actual cost; the old
-- settlement would otherwise refund it. Then restore the complete pre-0408 report_fee_hold and
-- report_fee_settle_internal definitions from the preceding revision and remove report_stop.
-- Already-settled charges must not be reversed by restoring code.
BEGIN;
ALTER TABLE public.report_fees ADD COLUMN IF NOT EXISTS user_stopped_at timestamptz;
ALTER TABLE public.report_fees ADD COLUMN IF NOT EXISTS stop_chargeable boolean;
ALTER TABLE public.report_fees DROP CONSTRAINT IF EXISTS report_fees_settlement;
ALTER TABLE public.report_fees ADD CONSTRAINT report_fees_settlement CHECK (
  (state='held' AND settled_at IS NULL AND charged_credits IS NULL AND settle_reason IS NULL)
  OR (state='charged' AND settled_at IS NOT NULL AND charged_credits>0 AND charged_credits<=credits
      AND settle_reason IS NOT NULL AND (charged_credits=credits OR settle_reason='user_stop'))
  OR (state='refunded' AND settled_at IS NOT NULL AND charged_credits=0 AND settle_reason IS NOT NULL));
CREATE INDEX IF NOT EXISTS report_fees_user_stop_idx ON public.report_fees(actor_id,user_stopped_at)
  WHERE user_stopped_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.report_fee_settle_internal(p_execution_id uuid, p_refund boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE f report_fees; e runtime_executions; charge integer; reason text; before_balance integer; restored integer; q record;
  meta jsonb; complete boolean; b bill2_runs;
BEGIN
  PERFORM 1 FROM profiles WHERE id=(SELECT actor_id FROM report_fees WHERE execution_id=p_execution_id) FOR UPDATE;
  SELECT * INTO f FROM report_fees WHERE execution_id=p_execution_id FOR UPDATE;
  IF f.execution_id IS NULL THEN RETURN NULL; END IF;
  IF f.state<>'held' THEN RETURN report_fee_view(f.execution_id); END IF;
  SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id;
  complete:=coalesce(e.state IN ('completed','cost_pending') AND e.result->>'completeness'='complete'
    AND report_body_complete(e.result->>'body',e.payload->'reportGeneration'),false);
  IF f.user_stopped_at IS NOT NULL AND f.stop_chargeable THEN
    SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id;
    IF e.id IS NULL OR e.state NOT IN ('completed','cancelled') OR b.id IS NULL
      OR b.state NOT IN ('settled','refunded') OR b.provider_cost_usd IS NULL OR EXISTS(
        SELECT 1 FROM bill2_calls WHERE run_id=b.id AND dispatched_at IS NOT NULL
          AND (selected_cost_usd IS NULL OR settled_at IS NULL)) THEN
      RETURN report_fee_view(f.execution_id);
    END IF;
    SELECT least(500,f.credits,ceil(coalesce(sum(c.selected_cost_usd *
      bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')),0)*b.credits_per_usd))::integer
      INTO charge FROM bill2_calls c WHERE c.run_id=b.id AND c.dispatched_at IS NOT NULL;
    reason:='user_stop';
  ELSIF f.user_stopped_at IS NOT NULL AND e.state IN ('completed','cancelled') THEN charge:=0; reason:='user_stop';
  ELSIF complete AND f.user_stopped_at IS NULL THEN charge:=f.credits; reason:='complete';
  ELSIF p_refund OR e.id IS NULL OR e.content_deleted_at IS NOT NULL OR e.erased_at IS NOT NULL THEN charge:=0; reason:='deleted';
  ELSIF e.state IN ('completed','cancelled') THEN charge:=0; reason:=coalesce(e.result->>'completeness',e.state);
  ELSE RETURN report_fee_view(f.execution_id); END IF;
  SELECT credits INTO before_balance FROM profiles WHERE id=f.actor_id FOR UPDATE;
  meta:=jsonb_build_object('sourceType','report','sourceId',f.execution_id::text,'executionId',f.execution_id::text,
    'preDeductId',f.pre_deduct_id,'nominalReserved',f.credits,'consumedCredits',charge,'refundedCredits',f.credits-charge,'outcome',reason);
  IF charge>0 THEN
    SELECT * INTO q FROM bill2_legacy_settle(f.actor_id,f.pre_deduct_id,charge,
      jsonb_build_object('preDeductId',f.pre_deduct_id,'credits',f.credits,'chargedDelta',charge),NULL);restored:=q.difference;
  ELSE
    SELECT * INTO q FROM bill2_legacy_refund(f.actor_id,f.pre_deduct_id,'Report hold release');restored:=q.refund_amount;
  END IF;
  IF restored<0 OR q.balance_after-before_balance<>restored OR restored+charge<>f.credits THEN
    RAISE EXCEPTION 'REPORT_FEE_CONSERVATION'; END IF;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,metadata)
  VALUES(f.actor_id,f.credits,'adjustment','Report hold release','adjustment','bill2_release','ai_task',f.execution_id::text,
    'report:'||f.execution_id||':release',before_balance,before_balance::bigint+f.credits,meta);
  IF charge>0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
      idempotency_key,balance_before,balance_after,metadata)
    VALUES(f.actor_id,-charge,'consumption','Positioning report','spend','bill2_spend','ai_task',f.execution_id::text,
      'report:'||f.execution_id||':spend',before_balance::bigint+f.credits,q.balance_after,meta);
  END IF;
  UPDATE report_fees SET state=CASE WHEN charge>0 THEN 'charged' ELSE 'refunded' END,charged_credits=charge,
    settle_reason=reason,settled_at=clock_timestamp() WHERE execution_id=f.execution_id;
  RETURN report_fee_view(f.execution_id);
END $function$;


CREATE OR REPLACE FUNCTION public.report_fee_hold(e runtime_executions, billing jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE fee integer:=report_fixed_price(); call_hold numeric:=0; balance integer; quarantine bigint; avail bigint; q record;
BEGIN
  IF EXISTS(SELECT 1 FROM report_fees WHERE execution_id=e.id) THEN RETURN; END IF;
  -- One complete report per round, rechecked under the session lock runtime_admit holds: a second tab that passed the
  -- host-side check before the first report finished cannot be admitted and charged again (#1102 review). A report
  -- still going counts too, and so does a finished complete report whose price is not settled yet; one that ended
  -- without a complete report (its price refunded or about to be) does not.
  IF EXISTS(SELECT 1 FROM report_fees f JOIN runtime_executions x ON x.id=f.execution_id
    WHERE x.session_id=e.session_id AND x.id<>e.id
      AND x.payload#>>'{reportGeneration,projectId}'=e.payload#>>'{reportGeneration,projectId}'
      AND x.payload#>>'{reportGeneration,roundId}'=e.payload#>>'{reportGeneration,roundId}'
      AND (f.state='charged' AND f.settle_reason IS DISTINCT FROM 'user_stop'
        OR (f.state='held' AND (x.state NOT IN ('completed','cancelled')
          OR (x.result->>'completeness'='complete' AND report_body_complete(x.result->>'body',x.payload->'reportGeneration')))))) THEN
    RAISE EXCEPTION 'REPORT_ALREADY_EXISTS'; END IF;
  -- The report call's own temporary hold: its frozen cost bound in credits (released at zero charge).
  BEGIN
    call_hold:=ceil(bill2_decimal(billing#>'{limits,costUsd}')*(billing#>>'{rules,creditsPerUsd}')::numeric
      *coalesce(nullif(billing#>>'{rules,multiplier}','')::numeric,1));
  EXCEPTION WHEN OTHERS THEN call_hold:=0;
  END;
  SELECT credits INTO balance FROM profiles WHERE id=e.actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED'; END IF;
  PERFORM id FROM subscription_credit_grants WHERE user_id=e.actor_id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=e.actor_id AND accounting_state<>'trusted') THEN
    RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED'; END IF;
  SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine
  FROM subscription_credit_grants g WHERE g.user_id=e.actor_id AND g.status='granted' AND g.accounting_state='trusted'
  AND credit_grant_quarantined(g); -- ARCH-FIX E1
  avail:=greatest(balance-quarantine,0);
  IF avail<fee+call_hold THEN RAISE EXCEPTION 'REPORT_CREDITS'; END IF;
  SELECT * INTO q FROM atomic_pre_deduct(e.actor_id,fee,'Report hold',e.id);
  IF q.is_idempotent THEN RAISE EXCEPTION 'REPORT_REQUEST_CONFLICT'; END IF;
  INSERT INTO report_fees(execution_id,actor_id,credits,pre_deduct_id,state) VALUES(e.id,e.actor_id,fee,q.pre_deduct_id,'held');
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,metadata)
  VALUES(e.actor_id,-fee,'adjustment','Report hold','adjustment','bill2_reserve','ai_task',e.id::text,
    'report:'||e.id||':reserve',q.balance_before,q.balance_after,
    -- Only keys the erasure ledger shape knows (erasure_ledger_metadata): L = price plus the call's temporary hold.
    jsonb_build_object('sourceType','report','sourceId',e.id::text,'executionId',e.id::text,'preDeductId',q.pre_deduct_id,
      'nominalReserved',fee,'L',fee+call_hold));
END $function$;

CREATE OR REPLACE FUNCTION public.report_stop(p_actor_id uuid, p_execution_id uuid, p_stop jsonb, p_confirmed boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE e runtime_executions; s runtime_sessions; b bill2_runs; f report_fees; n integer; v jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED'; END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM report_fees WHERE execution_id=e.id AND actor_id=p_actor_id) THEN
   IF p_stop IS NULL THEN RETURN runtime_cancel(p_actor_id,e.id); END IF;
   RETURN runtime_execution(p_actor_id,e.id,'stop',p_stop);
 END IF;
 PERFORM 1 FROM profiles WHERE id=p_actor_id FOR UPDATE;
 SELECT * INTO f FROM report_fees WHERE execution_id=e.id AND actor_id=p_actor_id FOR UPDATE;
 IF f.user_stopped_at IS NULL AND f.state='held' AND e.state NOT IN ('completed','cancelled') AND e.result IS NULL
   AND e.unavailable_reason IS NULL AND e.failure_code IS NULL AND NOT b.closed AND NOT b.cancel_requested
   AND NOT b.conflict AND b.outcome IS DISTINCT FROM 'confirmed_failure'
   AND NOT runtime_workspace_posts_history_erased(e.id)
   AND NOT runtime_voice_source_gone(e.id)
   AND NOT EXISTS(SELECT 1 FROM runtime_library_references r LEFT JOIN library_documents d
     ON d.id=r.document_id AND d.actor_id=r.actor_id WHERE r.execution_id=e.id
       AND (d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status='deleting')) THEN
   SELECT count(*) INTO n FROM report_fees WHERE actor_id=p_actor_id
     AND user_stopped_at>clock_timestamp()-interval '24 hours';
   IF n>=2 AND NOT coalesce(p_confirmed,false) THEN RETURN jsonb_build_object('state','confirmation_required'); END IF;
   UPDATE report_fees SET user_stopped_at=clock_timestamp(),stop_chargeable=(n>=2) WHERE execution_id=e.id;
 END IF;
 IF p_stop IS NULL THEN v:=runtime_cancel(p_actor_id,e.id);
 ELSE v:=runtime_execution(p_actor_id,e.id,'stop',p_stop); END IF;
 RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.report_stop(uuid,uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.report_stop(uuid,uuid,jsonb,boolean) TO service_role;
COMMIT;
