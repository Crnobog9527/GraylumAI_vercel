-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.monthly_refund_lock(p_order uuid,p_intent uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;i jsonb;
BEGIN
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 i:=o.refund_approval;
 IF i IS NULL OR i->>'kind' IS DISTINCT FROM 'monthly_first_purchase' OR i->>'id' IS DISTINCT FROM p_intent::text
 THEN RAISE EXCEPTION 'PAY_REFUND_INTENT_MISMATCH'; END IF;
 PERFORM 1 FROM user_subscriptions WHERE id=o.subscription_id FOR UPDATE;
 PERFORM 1 FROM subscription_credit_grants WHERE source_order_id=o.id ORDER BY id FOR UPDATE;
 RETURN i;
END $$;

-- Fresh channel observation from the server, never a browser-supplied proof.
CREATE OR REPLACE FUNCTION public.monthly_refund_observation(i jsonb,e jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF e IS NULL OR e->>'mode' IS DISTINCT FROM 'test' OR e->>'merchant' IS DISTINCT FROM i->'terms'->>'merchant'
 OR e->'subscription'->>'id' IS DISTINCT FROM i->'terms'->>'providerSubscriptionId'
 OR (e->'subscription'->>'periodEnd')::timestamptz IS DISTINCT FROM (i->'terms'->>'periodEnd')::timestamptz
 OR (e->>'checkedAt')::timestamptz IS NULL OR (e->>'checkedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
 OR clock_timestamp()-(e->>'checkedAt')::timestamptz>interval '60 seconds'
 OR e->'refunds'->>'complete' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'PAY_MONTHLY_OBSERVATION'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_start(
 p_actor uuid,p_order uuid,p_intent uuid,p_revision integer,p_stage text,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;t jsonb;sub jsonb;at timestamptz;cash text;
BEGIN
 PERFORM monthly_refund_assert_admin(p_actor);
 i:=monthly_refund_lock(p_order,p_intent);t:=i->'terms';sub:=p_evidence->'subscription';
 IF i ? 'terminalConflict' THEN RAISE EXCEPTION 'PAY_MONTHLY_PERSISTED_CONFLICT'; END IF;
 PERFORM monthly_refund_observation(i,p_evidence);
 IF i->>'hold' IS DISTINCT FROM 'held' OR (i->>'revision')::integer IS DISTINCT FROM p_revision
 OR p_stage IS NULL OR p_stage NOT IN ('stop_renewal','refund','cancel','restore_renewal')
 OR sub->>'status' IS DISTINCT FROM 'active' OR sub->>'preflight' IS DISTINCT FROM 'clear'
 OR NOT EXISTS(SELECT 1 FROM user_subscriptions WHERE id=(t->>'subscriptionId')::uuid AND status='paused')
 THEN RAISE EXCEPTION 'PAY_MONTHLY_STAGE_CONFLICT'; END IF;
 cash:=i->'recordedRefund'->>'status';
 -- Closed accounts may reconcile and terminate already accepted refunds, never renew again.
 IF p_stage<>'cancel' AND NOT EXISTS(SELECT 1 FROM profiles WHERE id=(t->>'userId')::uuid
 AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'PAY_REFUND_SUBJECT_UNAVAILABLE'; END IF;
 IF p_stage IN ('stop_renewal','refund') THEN
  IF EXISTS(SELECT 1 FROM credit_transactions WHERE user_id=(t->>'userId')::uuid
   AND created_at>=(t->>'paidAt')::timestamptz AND amount<>0 AND (ledger_type='spend' OR counts_as_spend=true))
  OR EXISTS(SELECT 1 FROM billing_history h WHERE h.user_id=(t->>'userId')::uuid AND h.operation_type='pre_deduct'
   AND NOT EXISTS(SELECT 1 FROM billing_history d WHERE d.user_id=h.user_id
    AND d.operation_type IN ('settle','refund','abort_settle') AND d.metadata->>'preDeductId'=h.id::text))
  THEN RAISE EXCEPTION 'PAY_REFUND_CONSUMPTION_OR_UNKNOWN'; END IF;
  IF i->'recordedRefund'<>'null'::jsonb OR jsonb_array_length(p_evidence->'refunds'->'rows')<>0
  OR clock_timestamp()-(i->>'claimedAt')::timestamptz NOT BETWEEN interval '0' AND interval '20 hours'
  OR clock_timestamp() >= (i->>'claimedAt')::timestamptz+interval '20 hours'
  OR (t->>'periodEnd')::timestamptz<=clock_timestamp()
  THEN RAISE EXCEPTION 'PAY_MONTHLY_DISPATCH_CONFLICT'; END IF;
  IF p_stage='stop_renewal' AND (t->>'originalCancelAtPeriodEnd'<>'false'
   OR sub->>'cancelAtPeriodEnd'<>'false' OR i->'started'->>'refund' IS NOT NULL)
  OR p_stage='refund' AND (sub->>'cancelAtPeriodEnd'<>'true'
   OR sub->>'renewalOwnership' IS DISTINCT FROM CASE WHEN t->>'originalCancelAtPeriodEnd'='true' THEN 'original' ELSE 'intent' END)
  THEN RAISE EXCEPTION 'PAY_MONTHLY_RENEWAL_CONFLICT'; END IF;
 ELSIF p_stage='cancel' THEN
  IF cash IS DISTINCT FROM 'succeeded' OR i->'started'->>'restore_renewal' IS NOT NULL
  THEN RAISE EXCEPTION 'PAY_MONTHLY_CASH_NOT_SUCCEEDED'; END IF;
 ELSE
  IF cash IS NULL OR cash NOT IN ('failed','canceled') OR i->'started'->>'cancel' IS NOT NULL
  OR t->>'originalCancelAtPeriodEnd'<>'false' OR sub->>'renewalOwnership'<>'intent'
  OR sub->>'cancelAtPeriodEnd'<>'true' OR (t->>'periodEnd')::timestamptz<=clock_timestamp()
  THEN RAISE EXCEPTION 'PAY_MONTHLY_RESTORE_CONFLICT'; END IF;
 END IF;
 at:=(i->'started'->>p_stage)::timestamptz;
 IF at IS NULL THEN
  i:=jsonb_set(i,ARRAY['started',p_stage],to_jsonb(clock_timestamp()));
 ELSIF p_stage<>'cancel' AND clock_timestamp()-at>=interval '20 hours' THEN
  RAISE EXCEPTION 'PAY_REFUND_RETRY_REQUIRES_REVIEW';
 END IF;
 i:=i||jsonb_build_object('revision',p_revision+1,'status','review_required');
 UPDATE payment_orders SET refund_approval=i WHERE id=p_order;
 RETURN i;
END $$;

-- Result recording has no account-active prerequisite: cash facts outlive account closure.
CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_result(p_order uuid,p_intent uuid,p_refund jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;t jsonb;old_status text;next_status text;
BEGIN
 i:=monthly_refund_lock(p_order,p_intent);t:=i->'terms';
 IF i->'started'->>'refund' IS NULL OR i->>'claimedAt' IS NULL
 OR p_refund->>'intentId' IS DISTINCT FROM p_intent::text OR p_refund->>'orderId' IS DISTINCT FROM p_order::text
 OR p_refund->>'chargeId' IS DISTINCT FROM t->>'chargeId' OR p_refund->>'paymentIntentId' IS DISTINCT FROM t->>'paymentIntentId'
 OR p_refund->>'currency' IS DISTINCT FROM t->>'currency' OR p_refund->>'amount' IS DISTINCT FROM t->>'netMinor'
 OR p_refund->>'merchant' IS DISTINCT FROM t->>'merchant' OR p_refund->>'mode' IS DISTINCT FROM 'test'
 OR nullif(p_refund->>'id','') IS NULL OR i->'recordedRefund'->>'id' IS NOT NULL
 AND i->'recordedRefund'->>'id' IS DISTINCT FROM p_refund->>'id'
 THEN RAISE EXCEPTION 'PAY_REFUND_RESULT_MISMATCH'; END IF;
 next_status:=p_refund->>'status';old_status:=i->'recordedRefund'->>'status';
 IF next_status IS NULL OR next_status NOT IN ('pending','requires_action','succeeded','failed','canceled')
 THEN RAISE EXCEPTION 'PAY_REFUND_TERMINAL_CONFLICT'; END IF;
 IF old_status IN ('succeeded','failed','canceled') AND old_status IS DISTINCT FROM next_status THEN
  i:=i||jsonb_build_object('status','review_required','terminalConflict',true,'revision',(i->>'revision')::integer+1);
  UPDATE payment_orders SET refund_approval=i WHERE id=p_order; RETURN i;
 END IF;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe',t->>'merchant','test','refund',p_refund->>'id',p_order)
 ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=t->>'merchant'
 AND mode='test' AND object_type='refund' AND external_id=p_refund->>'id' AND order_id=p_order)
 THEN RAISE EXCEPTION 'PAY_REFUND_PROVIDER_MAPPING_CONFLICT'; END IF;
 IF old_status=next_status OR i->>'terminalConflict'='true' THEN RETURN i; END IF;
 i:=i||jsonb_build_object('recordedRefund',jsonb_build_object('id',p_refund->>'id','status',next_status),
 'status','review_required','revision',(i->>'revision')::integer+1);
 UPDATE payment_orders SET refund_approval=i,
 status=CASE WHEN next_status='succeeded' THEN CASE WHEN (t->>'netMinor')::integer=amount_total
 THEN 'refunded' ELSE 'partially_refunded' END ELSE status END,
 payment_status=CASE WHEN next_status='succeeded' THEN CASE WHEN (t->>'netMinor')::integer=amount_total
 THEN 'refunded' ELSE 'partially_refunded' END ELSE payment_status END WHERE id=p_order;
 RETURN i;
END $$;

CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_finish(
 p_actor uuid,p_order uuid,p_intent uuid,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;t jsonb;sub jsonb;cash text;balance integer;
BEGIN
 PERFORM monthly_refund_assert_admin(p_actor);i:=monthly_refund_lock(p_order,p_intent);t:=i->'terms';
 IF i ? 'terminalConflict' THEN RAISE EXCEPTION 'PAY_MONTHLY_PERSISTED_CONFLICT'; END IF;
 PERFORM monthly_refund_observation(i,p_evidence);sub:=p_evidence->'subscription';cash:=i->'recordedRefund'->>'status';
 IF i->>'status' IN ('succeeded','failed') THEN RETURN i; END IF;
 IF i->>'hold' IS DISTINCT FROM 'held' OR cash IS NULL OR cash NOT IN ('succeeded','failed','canceled')
 OR jsonb_array_length(p_evidence->'refunds'->'rows')<>1
 OR p_evidence->'refunds'->'rows'->0->>'id' IS DISTINCT FROM i->'recordedRefund'->>'id'
 OR p_evidence->'refunds'->'rows'->0->>'status' IS DISTINCT FROM cash
 THEN RAISE EXCEPTION 'PAY_MONTHLY_FINALIZE_CONFLICT'; END IF;
 PERFORM set_config('pay_common.monthly_transition',p_intent::text,true);
 IF cash='succeeded' THEN
  IF sub->>'status' IS DISTINCT FROM 'canceled' THEN RAISE EXCEPTION 'PAY_MONTHLY_CANCEL_UNRESOLVED'; END IF;
  UPDATE user_subscriptions SET status='canceled',cancel_at_period_end='true',credit_release_terminated_at=clock_timestamp(),
   credit_release_terminated_reason='approved_monthly_refund',credit_release_terminated_event_id=i->'recordedRefund'->>'id',
   credit_release_terminated_period_key=(SELECT min(grant_period_key) FROM subscription_credit_grants WHERE source_order_id=p_order)
   WHERE id=(t->>'subscriptionId')::uuid;
  i:=i||jsonb_build_object('hold','terminated','status','succeeded');
 ELSE
  IF sub->>'status' IS DISTINCT FROM 'active' OR sub->>'preflight' IS DISTINCT FROM 'clear'
  OR sub->>'cancelAtPeriodEnd' IS DISTINCT FROM t->>'originalCancelAtPeriodEnd'
  OR (t->>'periodEnd')::timestamptz<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=(t->>'userId')::uuid AND status='active' AND is_deleted='false')
  THEN RAISE EXCEPTION 'PAY_MONTHLY_RESTORE_UNRESOLVED'; END IF;
  SELECT credits INTO balance FROM profiles WHERE id=(t->>'userId')::uuid;
  UPDATE profiles SET credits=credits+(t->>'credits')::integer,membership_level=t->>'plan' WHERE id=(t->>'userId')::uuid;
  INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,source_order_id,
   idempotency_key,balance_before,balance_after)
  VALUES((t->>'userId')::uuid,(t->>'credits')::integer,'refund','adjustment','refund_failed_restore','stripe_refund',p_order,
   'pay-common:monthly-refund:'||p_intent||':restore',balance,balance+(t->>'credits')::integer);
  UPDATE subscription_credit_grants SET status='granted' WHERE source_order_id=p_order;
  UPDATE user_subscriptions SET status='active',cancel_at_period_end=t->>'originalCancelAtPeriodEnd'
   WHERE id=(t->>'subscriptionId')::uuid;
  i:=i||jsonb_build_object('hold','released','status','failed');
 END IF;
 i:=i||jsonb_build_object('revision',(i->>'revision')::integer+1,'finishedAt',clock_timestamp());
 UPDATE payment_orders SET refund_approval=i WHERE id=p_order;
 PERFORM set_config('pay_common.monthly_transition','',true);
 RETURN i;
END $$;

CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_conflict(p_order uuid,p_intent uuid,p_cash jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;t jsonb;
BEGIN
 i:=monthly_refund_lock(p_order,p_intent);t:=i->'terms';
 IF p_cash IS NULL OR p_cash->>'chargeId' IS DISTINCT FROM t->>'chargeId'
 OR p_cash->>'paymentIntentId' IS DISTINCT FROM t->>'paymentIntentId'
 OR p_cash->>'currency' IS DISTINCT FROM t->>'currency' OR p_cash->>'merchant' IS DISTINCT FROM t->>'merchant'
 OR p_cash->>'mode' IS DISTINCT FROM 'test' OR nullif(p_cash->>'id','') IS NULL
 THEN RAISE EXCEPTION 'PAY_REFUND_RESULT_MISMATCH'; END IF;
 i:=i||jsonb_build_object('status','review_required','terminalConflict',true,
  'unmatchedRefund',jsonb_build_object('id',p_cash->>'id','amount',p_cash->'amount','status',p_cash->>'status'),
  'revision',(i->>'revision')::integer+1);
 UPDATE payment_orders SET refund_approval=i WHERE id=p_order;RETURN i;
END $$;
REVOKE ALL ON FUNCTION public.pay_common_monthly_refund_conflict(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_monthly_refund_conflict(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_reject(
 p_actor uuid,p_order uuid,p_ticket uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;i jsonb;
BEGIN
 PERFORM monthly_refund_assert_admin(p_actor);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.item_type IS DISTINCT FROM 'membership_plan' OR o.billing_cycle IS DISTINCT FROM 'monthly'
 OR NOT EXISTS(SELECT 1 FROM tickets WHERE id=p_ticket AND user_id=o.user_id AND category='billing' AND is_deleted='false')
 OR p_reason IS NULL OR p_reason NOT IN ('ineligible','evidence_missing','customer_withdrew')
 THEN RAISE EXCEPTION 'PAY_MONTHLY_REJECTION_INVALID'; END IF;
 i:=o.refund_approval;
 IF i IS NOT NULL AND (i->>'kind' IS DISTINCT FROM 'monthly_first_purchase' OR i->>'claimedAt' IS NOT NULL)
 THEN RAISE EXCEPTION 'PAY_REFUND_ALREADY_DISPATCHED'; END IF;
 IF i->>'status'='rejected' THEN RETURN i; END IF;
 i:=coalesce(i,jsonb_build_object('kind','monthly_first_purchase','id',gen_random_uuid(),
  'orderId',p_order,'ticketId',p_ticket))||jsonb_build_object('status','rejected','rejectionReason',p_reason,
  'rejectedBy',p_actor,'rejectedAt',clock_timestamp());
 UPDATE payment_orders SET refund_approval=i WHERE id=p_order;RETURN i;
END $$;
REVOKE ALL ON FUNCTION public.pay_common_monthly_refund_reject(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_monthly_refund_reject(uuid,uuid,uuid,text) TO service_role;

-- Paused local entitlement must not hide an unconfirmed renewal stop from closure.
CREATE OR REPLACE FUNCTION public.account_erasure_renewing(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_profile_id AND s.stripe_subscription_id IS NOT NULL
 AND lower(s.status) IN ('active','trialing','past_due','incomplete','unpaid','paused')
 AND s.cancel_at_period_end::text IS DISTINCT FROM 'true');
$$;

DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['monthly_refund_lock(uuid,uuid)','monthly_refund_observation(jsonb,jsonb)'] LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC,anon,authenticated,service_role'; END LOOP;
 FOREACH f IN ARRAY ARRAY['pay_common_monthly_refund_start(uuid,uuid,uuid,integer,text,jsonb)',
 'pay_common_monthly_refund_result(uuid,uuid,jsonb)','pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)'] LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC,anon,authenticated';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||f||' TO service_role'; END LOOP;
END $$;
COMMIT;
