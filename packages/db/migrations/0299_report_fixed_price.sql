/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- REPORT-FIXED-PRICE. Number allocated by the controller. Owner 2026-10-17: "报告固定价 500 积分，替代按量扣费；
-- 失败全额退回；重新生成照收全价；按钮写明价格". Replaces per-call user charging of a report generation.
--
-- * Admission: runtime_admit holds the fixed price (system_settings report_fixed_price_credits, default 500) for a
--   report execution in the transaction that creates it, with the existing pre-deduction primitive. The available
--   balance must also cover the report call's own temporary hold (its frozen cost bound), so an admitted report never
--   waits for credits. Refused: REPORT_CREDITS (nothing is created).
-- * Call: the report's model call keeps its run, hold and settlement, but settles at zero user charge
--   (nominal_source 'fixed_fee'; nominal cost, would-be charge and real provider cost stay recorded; platform-borne).
-- * Settlement (report_fee_settle_internal): a complete report (result completeness 'complete' and
--   report_body_complete, the existing REPORT-GEN check of 0206) charges the price once; an execution that ended
--   without one (failed, cut off, stopped, cancelled) refunds it in full; deleting the conversation or closing the
--   account refunds a held price. The report-visual plan (#1078) will later count only the prose: change
--   report_body_complete then, this file follows it.
-- * Ledger rows reuse bill2_reserve / bill2_release / bill2_spend (source_id = execution id) with metadata keys the
--   erasure ledger shape knows. Re-generating is a new execution and a new price (Owner: 重新生成照收全价).
-- New table reason: the fee must survive content erasure of the execution (financial record), like bill2 runs.
-- Compatibility: report executions admitted before this migration have no fee row and keep per-call billing.
-- Independent of 0294 (fusion fixed price): the shared pieces below (fixed_fee zero source, erasure enum) are the
-- same idempotent definitions, so either order works. Repeatable: every patch is anchored and skipped once applied.
-- Recovery: switch report generation off, settle held fees (report_fee_settle_due), restore the previous bodies.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.report_fees (
  execution_id uuid CONSTRAINT report_fees_pk PRIMARY KEY,
  actor_id uuid NOT NULL CONSTRAINT report_fees_actor_ref REFERENCES public.profiles(id),
  credits integer NOT NULL CHECK (credits > 0),
  pre_deduct_id uuid NOT NULL CONSTRAINT report_fees_pre_deduct_unique UNIQUE,
  state text NOT NULL CHECK (state IN ('held','charged','refunded')),
  charged_credits integer,
  settle_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT report_fees_settlement CHECK (
    (state='held' AND settled_at IS NULL AND charged_credits IS NULL AND settle_reason IS NULL)
    OR (state='charged' AND settled_at IS NOT NULL AND charged_credits=credits AND settle_reason IS NOT NULL)
    OR (state='refunded' AND settled_at IS NOT NULL AND charged_credits=0 AND settle_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS report_fees_held_idx ON public.report_fees(actor_id) WHERE state='held';
ALTER TABLE public.report_fees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_fees FROM PUBLIC, anon, authenticated, service_role;

-- The price row (a scalar, editable on the administrator settings page). Kept if it already exists.
INSERT INTO public.system_settings(key,value) VALUES('report_fixed_price_credits','500'::jsonb) ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.report_fixed_price() RETURNS integer
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v text;
BEGIN
  SELECT value#>>'{}' INTO v FROM system_settings WHERE key='report_fixed_price_credits';
  v:=coalesce(nullif(v,''),'500');
  IF v!~'^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'REPORT_PRICE_INVALID'; END IF;
  RETURN v::int;
END $$;
REVOKE ALL ON FUNCTION public.report_fixed_price() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_fixed_price() TO service_role;

-- Holds the price of a report execution being admitted (called inside runtime_admit after the insert).
CREATE OR REPLACE FUNCTION public.report_fee_hold(e runtime_executions, billing jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE fee integer:=report_fixed_price(); call_hold numeric:=0; balance integer; quarantine bigint; avail bigint; q record;
BEGIN
  IF EXISTS(SELECT 1 FROM report_fees WHERE execution_id=e.id) THEN RETURN; END IF;
  -- One complete report per round, rechecked under the session lock runtime_admit holds: a second tab that passed the
  -- host-side check before the first report finished cannot be admitted and charged again (#1102 review). A report
  -- still going counts too; one that ended without a complete report (its price refunded) does not.
  IF EXISTS(SELECT 1 FROM report_fees f JOIN runtime_executions x ON x.id=f.execution_id
    WHERE x.session_id=e.session_id AND x.id<>e.id
      AND x.payload#>>'{reportGeneration,projectId}'=e.payload#>>'{reportGeneration,projectId}'
      AND x.payload#>>'{reportGeneration,roundId}'=e.payload#>>'{reportGeneration,roundId}'
      AND (f.state='charged' OR (f.state='held' AND x.state NOT IN ('completed','cancelled')))) THEN
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
  AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=e.actor_id AND s.stripe_subscription_id=g.stripe_subscription_id
    AND s.credit_release_terminated_at IS NOT NULL);
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
END $$;
REVOKE ALL ON FUNCTION public.report_fee_hold(runtime_executions,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_fee_view(p_execution_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('credits',f.credits,'state',f.state,'chargedCredits',f.charged_credits,'reason',f.settle_reason,
    'settledAt',f.settled_at) FROM report_fees f WHERE f.execution_id=p_execution_id;
$$;
REVOKE ALL ON FUNCTION public.report_fee_view(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Settles a held price (idempotent). Complete report: charge; ended without one, deleted, or p_refund: refund;
-- still running or waiting: stays held. Lock order: profile -> fee row, the order content erasure (which already
-- holds the profile) reaches it in.
CREATE OR REPLACE FUNCTION public.report_fee_settle_internal(p_execution_id uuid, p_refund boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f report_fees; e runtime_executions; charge integer; reason text; before_balance integer; restored integer; q record;
  meta jsonb; complete boolean;
BEGIN
  PERFORM 1 FROM profiles WHERE id=(SELECT actor_id FROM report_fees WHERE execution_id=p_execution_id) FOR UPDATE;
  SELECT * INTO f FROM report_fees WHERE execution_id=p_execution_id FOR UPDATE;
  IF f.execution_id IS NULL THEN RETURN NULL; END IF;
  IF f.state<>'held' THEN RETURN report_fee_view(f.execution_id); END IF;
  SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id;
  complete:=coalesce(e.state IN ('completed','cost_pending') AND e.result->>'completeness'='complete'
    AND report_body_complete(e.result->>'body',e.payload->'reportGeneration'),false);
  IF complete THEN charge:=f.credits; reason:='complete';
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
END $$;
REVOKE ALL ON FUNCTION public.report_fee_settle_internal(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Host entry for the user's own report execution (the page reads its status after the report ends).
CREATE OR REPLACE FUNCTION public.report_fee_settle(p_actor_id uuid, p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF NOT EXISTS(SELECT 1 FROM report_fees WHERE execution_id=p_execution_id AND actor_id=p_actor_id) THEN RETURN NULL; END IF;
  RETURN report_fee_settle_internal(p_execution_id,false);
END $$;

-- Daily recovery: held prices whose execution ended; one left held for 3 days with its billing run closed and every
-- call settled (an execution that never reaches an end state) is refunded. Listed without locks: the settlement takes
-- the profile, then the fee row, and is idempotent.
CREATE OR REPLACE FUNCTION public.report_fee_settle_due(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE due report_fees; n integer:=0; v jsonb; stale boolean;
BEGIN
  FOR due IN SELECT f.* FROM report_fees f WHERE f.state='held' ORDER BY f.created_at
    LIMIT least(greatest(coalesce(p_limit,100),1),500) LOOP
    SELECT due.created_at<=clock_timestamp()-interval '3 days' AND coalesce(r.closed,true)
      AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.settled_at IS NULL)
      INTO stale FROM runtime_executions e LEFT JOIN bill2_runs r ON r.id=e.billing_run_id WHERE e.id=due.execution_id;
    v:=report_fee_settle_internal(due.execution_id,coalesce(stale,true) AND due.created_at<=clock_timestamp()-interval '3 days');
    IF v->>'state'<>'held' THEN n:=n+1; END IF;
  END LOOP;
  RETURN n;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['report_fee_settle(uuid,uuid)','report_fee_settle_due(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- Admission: hold the price in the transaction that creates a report execution (a refusal creates nothing).
DO $$ DECLARE src text; a text:=$x$ UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;$x$; BEGIN
  src:=pg_get_functiondef('public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
  IF position('-- 0299 report price' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'REPORT_PRICE_SOURCE_MISMATCH: runtime_admit'; END IF;
    EXECUTE replace(src,a,a||$x$
 -- 0299 report price
 IF p_payload ? 'reportGeneration' THEN PERFORM report_fee_hold(e,p_billing); END IF;$x$);
  END IF;
END $$;

-- Finalize: the call of a priced report settles at zero user charge; the would-be charge is platform-absorbed.
-- Same definition as 0294 (either migration may come first).
CREATE OR REPLACE FUNCTION public.bill2_payg_zero_source(source text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(source IN ('confirmed_failure','tool_no_usage','tool_failed','tool_failed_charged','tool_unknown','fixed_fee'),false)
$$;
REVOKE ALL ON FUNCTION public.bill2_payg_zero_source(text) FROM PUBLIC, anon, authenticated, service_role;
DO $$ DECLARE src text; a text:=$x$debit:=least(delta,c.reserved_credits)::int;cap:=greatest(bounded-c.reserved_credits,0);bound:=delta-debit-cap;$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('-- 0299 report price' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'REPORT_PRICE_SOURCE_MISMATCH: bill2_payg_finalize'; END IF;
    EXECUTE replace(src,a,a||$x$
   -- 0299 report price: the report's fixed price covers this call; the hold is released through the refund path.
   IF r.session_ref IS NOT NULL AND EXISTS(SELECT 1 FROM report_fees rf JOIN runtime_executions re ON re.id=rf.execution_id
    WHERE re.billing_run_id=r.id) THEN debit:=0;cap:=0;bound:=delta;source:='fixed_fee';END IF;$x$);
  END IF;
END $$;
DO $$ DECLARE src text; a text:=$x$"tool_usage", "tool_no_usage", "tool_failed", "tool_failed_charged", "tool_unknown"]$x$; BEGIN
  src:=pg_get_functiondef('public.erasure_ledger_metadata(jsonb)'::regprocedure);
  IF position('"fixed_fee"' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>3 THEN RAISE EXCEPTION 'REPORT_PRICE_SOURCE_MISMATCH: erasure_ledger_metadata'; END IF;
    EXECUTE replace(src,a,$x$"tool_usage", "tool_no_usage", "tool_failed", "tool_failed_charged", "tool_unknown", "fixed_fee"]$x$);
  END IF;
END $$;

-- Usage projections for a fixed-fee call: the settled-at-zero path skips token_stats / ai_usage_logs (the zero-charge
-- refund path writes none), but the real provider cost must reach the cost dashboards (#1098 review). Same rows as a
-- charged call, at zero credits. Shared marker: whichever of 0294 / 0299 applies first patches, the other skips.
DO $$ DECLARE src text; a text:=$x$  UPDATE bill2_calls SET nominal_cost_usd=n,nominal_source=source,theoretical_delta=delta,charged_delta=debit,$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('-- fixed_fee usage rows' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FIXED_FEE_SOURCE_MISMATCH: bill2_payg_finalize usage rows'; END IF;
    EXECUTE replace(src,a,$x$  -- fixed_fee usage rows
  IF source='fixed_fee' AND c.dispatched_at IS NOT NULL THEN
   INSERT INTO token_stats(bill2_run_id,bill2_call_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
   VALUES(rid,c.id,a,c.model,(selected_usage->>'inputTokens')::int,(selected_usage->>'outputTokens')::int,NULL,NULL,NULL,c.selected_cost_usd,0,meta);
   INSERT INTO ai_usage_logs(bill2_run_id,bill2_call_id,user_id,request_id,model_id,status,metadata)
   VALUES(rid,c.id,a,c.id::text,c.model,'success',meta);
  END IF;
$x$||a);
  END IF;
END $$;

-- Content deletion: before results are removed, a complete report is charged and any other held price refunded.
DO $$ DECLARE src text; a text:=$x$ UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;$x$; BEGIN
  src:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0299 report price' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'REPORT_PRICE_SOURCE_MISMATCH: content_erasure_confirm'; END IF;
    EXECUTE replace(src,a,$x$ -- 0299 report price
 PERFORM report_fee_settle_internal(held_fee.execution_id,false) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions));
 PERFORM report_fee_settle_internal(held_fee.execution_id,true) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions));
$x$||a);
  END IF;
END $$;

-- Account erasure: the same two steps for every held price of the account; a held price keeps it pending.
DO $$ DECLARE src text; a text:=$x$  RETURN counts;$x$; BEGIN
  src:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('-- 0299 report price' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'REPORT_PRICE_SOURCE_MISMATCH: account_erasure_scrub_content'; END IF;
    EXECUTE replace(src,a,$x$  -- 0299 report price
  PERFORM report_fee_settle_internal(held_fee.execution_id,false) FROM report_fees held_fee
   WHERE held_fee.actor_id=p_profile_id AND held_fee.state='held';
  PERFORM report_fee_settle_internal(held_fee.execution_id,true) FROM report_fees held_fee
   WHERE held_fee.actor_id=p_profile_id AND held_fee.state='held';
$x$||a);
  END IF;
  src:=pg_get_functiondef('public.account_erasure_financial_proof(uuid)'::regprocedure);
  a:=$x$ RETURN jsonb_build_object('financialPending',pending,'manualReview',manual);$x$;
  IF position('report_fees' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'REPORT_PRICE_SOURCE_MISMATCH: account_erasure_financial_proof'; END IF;
    EXECUTE replace(src,a,$x$ SELECT count(*) INTO n FROM report_fees WHERE actor_id=p_profile_id AND state='held';
 pending:=pending+n;
$x$||a);
  END IF;
END $$;
COMMIT;
