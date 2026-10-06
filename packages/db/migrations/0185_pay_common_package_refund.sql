-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PR-4B1: order-local manual approval and package refund. No remote application here.
BEGIN;
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS refund_approval jsonb;
GRANT SELECT(refund_approval) ON public.payment_orders TO service_role;

-- Complete account-wide evidence, under the existing profile -> order lock order.
-- Provider evidence is supplied only by the server after authenticated Stripe reads.
CREATE OR REPLACE FUNCTION public.pay_common_package_refund_quote(
 p_actor uuid,p_order uuid,p_ticket uuid,p_cash jsonb,p_fee text,p_fee_evidence text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE o payment_orders; t tickets; total integer; fee integer; result jsonb; paid_at timestamptz;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active'
   AND is_deleted='false') THEN RAISE EXCEPTION 'PAY_REFUND_ADMIN_REQUIRED'; END IF;
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAY_REFUND_ORDER_UNKNOWN'; END IF;
 SELECT * INTO t FROM tickets WHERE id=p_ticket FOR SHARE;
 IF NOT FOUND OR t.user_id IS DISTINCT FROM o.user_id OR t.category<>'billing'
   OR t.is_deleted IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'PAY_REFUND_TICKET_MISMATCH'; END IF;
 IF o.item_type IS DISTINCT FROM 'credit_package' THEN RAISE EXCEPTION 'PAY_REFUND_TYPE_NOT_IMPLEMENTED'; END IF;
 IF o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_mode IS DISTINCT FROM 'test'
   OR o.merchant_namespace IS NULL THEN RAISE EXCEPTION 'PAY_REFUND_TEST_STRIPE_ONLY'; END IF;
 IF o.status IS DISTINCT FROM 'completed' OR o.payment_status IS DISTINCT FROM 'paid'
   OR o.fulfilled_at IS NULL OR o.purchase_snapshot IS NULL OR o.amount_total<=0
   OR o.refund_approval->>'status' IN ('dispatching','pending','succeeded','failed','review_required')
   THEN RAISE EXCEPTION 'PAY_REFUND_ORDER_UNAVAILABLE'; END IF;
 IF p_cash IS NULL OR p_cash->>'orderId' IS DISTINCT FROM o.id::text
   OR p_cash->>'merchant' IS DISTINCT FROM o.merchant_namespace OR p_cash->>'mode' IS DISTINCT FROM 'test'
   OR p_cash->>'currency' IS DISTINCT FROM o.currency
   OR (p_cash->>'paidMinor')::integer IS DISTINCT FROM o.amount_total
   OR p_cash->>'refundedMinor' IS DISTINCT FROM '0'
   OR p_cash->>'refundCount' IS DISTINCT FROM '0' OR p_cash->>'disputed' IS DISTINCT FROM 'false'
   OR nullif(p_cash->>'chargeId','') IS NULL
   OR NOT EXISTS(SELECT 1 FROM payment_provider_refs r WHERE r.order_id=o.id AND r.object_type='payment'
     AND r.external_id=p_cash->>'paymentIntentId' AND r.channel='stripe'
     AND r.mode=o.payment_mode AND r.merchant_namespace=o.merchant_namespace)
   THEN RAISE EXCEPTION 'PAY_REFUND_CASH_EVIDENCE_INVALID'; END IF;
 paid_at:=(p_cash->>'paidAt')::timestamptz;
 IF paid_at IS NULL OR paid_at>t.created_at OR t.created_at>clock_timestamp()
   OR t.created_at-paid_at>interval '168 hours' THEN RAISE EXCEPTION 'PAY_REFUND_WINDOW'; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=o.user_id AND status='active' AND is_deleted='false')
   THEN RAISE EXCEPTION 'PAY_REFUND_SUBJECT_UNAVAILABLE'; END IF;
 -- Every historical reservation is considered, including ones started before payment.
 IF EXISTS(SELECT 1 FROM billing_history h WHERE h.user_id=o.user_id AND h.operation_type='pre_deduct'
   AND NOT EXISTS(SELECT 1 FROM billing_history done WHERE done.user_id=h.user_id
     AND done.operation_type IN ('settle','refund','abort_settle') AND done.metadata->>'preDeductId'=h.id::text))
   THEN RAISE EXCEPTION 'PAY_REFUND_SETTLEMENT_UNRESOLVED'; END IF;
 -- Canonical spend cannot be cancelled by a positive return. Unknown negative rows fail closed.
 IF EXISTS(SELECT 1 FROM credit_transactions c WHERE c.user_id=o.user_id AND c.created_at>=paid_at
   AND (c.ledger_type='spend' AND c.amount<>0 OR c.amount<0 AND
     (c.ledger_type IS NULL OR c.ledger_type NOT IN ('refund_clawback','adjustment','expiration','spend')
       OR c.ledger_type='adjustment' AND coalesce(c.source_type,'')<>'admin'
          AND coalesce(c.reason_code,'')<>'bill2_reserve'
          AND coalesce(c.idempotency_key,'') NOT LIKE 'admin_adjustment:%'
          AND coalesce(c.idempotency_key,'') NOT LIKE 'admin_credit_deduction:%')))
   THEN RAISE EXCEPTION 'PAY_REFUND_CONSUMPTION_OR_UNKNOWN'; END IF;
 total:=(o.purchase_snapshot->>'credits')::integer+(o.purchase_snapshot->>'bonus_credits')::integer;
 IF total IS NULL OR total<=0 OR total IS DISTINCT FROM (o.metadata->>'grantedCredits')::integer
   OR (SELECT count(*) FROM credit_transactions c WHERE c.user_id=o.user_id AND c.source_order_id=o.id
     AND c.amount=total AND c.idempotency_key='pay-common:package:'||o.id::text)<>1
   OR (SELECT credits FROM profiles WHERE id=o.user_id)<total
   THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
 IF p_fee IS NULL OR p_fee NOT IN ('confirmed','not_permitted')
   OR nullif(btrim(p_fee_evidence),'') IS NULL OR length(p_fee_evidence)>160
   THEN RAISE EXCEPTION 'PAY_REFUND_FEE_EVIDENCE_REQUIRED'; END IF;
 fee:=CASE WHEN p_fee='confirmed' THEN (o.amount_total::bigint*6/100)::integer ELSE 0 END;
 result:=jsonb_build_object('version',1,'orderId',o.id,'ticketId',t.id,'subjectId',o.user_id,
   'submittedAt',t.created_at,'reason','ordinary','treatment','credit_package','currency',o.currency,
   'basisMinor',o.amount_total,'feeMinor',fee,'netMinor',o.amount_total-fee,'credits',total,
   'feePermitted',p_fee,'feeEvidence',p_fee_evidence,'cash',p_cash);
 RETURN result||jsonb_build_object('versionHash',md5(result::text));
END $fn$;

-- Rejection does not require eligibility, legal fee evidence or a provider read.
CREATE OR REPLACE FUNCTION public.pay_common_package_refund_reject(
 p_actor uuid,p_order uuid,p_ticket uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE o payment_orders; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active'
   AND is_deleted='false') THEN RAISE EXCEPTION 'PAY_REFUND_ADMIN_REQUIRED'; END IF;
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF NOT FOUND OR o.item_type IS DISTINCT FROM 'credit_package' THEN RAISE EXCEPTION 'PAY_REFUND_ORDER_UNKNOWN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tickets WHERE id=p_ticket AND user_id=o.user_id AND category='billing' AND is_deleted='false')
   THEN RAISE EXCEPTION 'PAY_REFUND_TICKET_MISMATCH'; END IF;
 IF o.refund_approval->>'idempotencyKey' IS NOT NULL THEN RAISE EXCEPTION 'PAY_REFUND_ALREADY_DISPATCHED'; END IF;
 IF p_reason IS NULL OR p_reason NOT IN ('ineligible','evidence_missing','customer_withdrew') THEN
   RAISE EXCEPTION 'PAY_REFUND_REJECTION_REASON_REQUIRED'; END IF;
 result:=jsonb_build_object('id',gen_random_uuid(),'version',1,'orderId',o.id,'ticketId',p_ticket,
   'reason','ordinary','rejectionReason',p_reason,'status','rejected','decidedBy',p_actor,'decidedAt',clock_timestamp());
 UPDATE payment_orders SET refund_approval=result WHERE id=o.id;
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.pay_common_package_refund_decide(
 p_actor uuid,p_order uuid,p_ticket uuid,p_cash jsonb,p_fee text,p_fee_evidence text,p_version text,p_decision text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE q jsonb; existing jsonb; intent jsonb;
BEGIN
 q:=pay_common_package_refund_quote(p_actor,p_order,p_ticket,p_cash,p_fee,p_fee_evidence);
 IF q->>'versionHash' IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'PAY_REFUND_STALE_PREVIEW'; END IF;
 SELECT refund_approval INTO existing FROM payment_orders WHERE id=p_order;
 IF existing->>'status'='approved' THEN
   IF existing->>'versionHash'=p_version AND p_decision='approve' THEN RETURN existing; END IF;
   IF p_decision<>'reject' THEN RAISE EXCEPTION 'PAY_REFUND_ALREADY_APPROVED'; END IF;
 END IF;
 IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'PAY_REFUND_DECISION_INVALID'; END IF;
 intent:=q||jsonb_build_object('id',gen_random_uuid(),'approvedBy',p_actor,'decidedAt',clock_timestamp(),
   'status',CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END);
 UPDATE payment_orders SET refund_approval=intent WHERE id=p_order;
 RETURN intent;
END $fn$;

CREATE OR REPLACE FUNCTION public.pay_common_package_refund_claim(
 p_actor uuid,p_order uuid,p_intent uuid,p_cash jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent jsonb; q jsonb; balance integer; owner_id uuid; amount integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false')
   THEN RAISE EXCEPTION 'PAY_REFUND_ADMIN_REQUIRED'; END IF;
 SELECT user_id INTO owner_id FROM payment_orders WHERE id=p_order;
 SELECT credits INTO balance FROM profiles WHERE id=owner_id FOR UPDATE;
 SELECT refund_approval INTO intent FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF intent->>'id' IS DISTINCT FROM p_intent::text OR intent->>'status' IS DISTINCT FROM 'approved'
   THEN RAISE EXCEPTION 'PAY_REFUND_NOT_APPROVED'; END IF;
 q:=pay_common_package_refund_quote(p_actor,p_order,(intent->>'ticketId')::uuid,p_cash,
   intent->>'feePermitted',intent->>'feeEvidence');
 IF q->>'versionHash' IS DISTINCT FROM intent->>'versionHash' THEN RAISE EXCEPTION 'PAY_REFUND_STALE_APPROVAL'; END IF;
 amount:=(intent->>'credits')::integer;
 -- Reserve the entire unconsumed purchase (including bonus) before the network boundary.
 -- Unknown cash outcome retains this single clawback; a confirmed failed refund restores it once.
 UPDATE profiles SET credits=credits-amount WHERE id=owner_id;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,
   source_type,source_order_id,idempotency_key,balance_before,balance_after)
 VALUES(owner_id,-amount,'deduction','Approved package refund','refund_clawback','refund_clawback',
   'stripe_refund',p_order,'pay-common:refund:'||p_intent,balance,balance-amount);
 -- Persist uncertainty together with the identity and clawback BEFORE external dispatch.
 -- A crash, timeout or failed result write therefore never hides the need for reconciliation.
 intent:=intent||jsonb_build_object('status','review_required','claimedAt',clock_timestamp(),
   'idempotencyKey','pay-common:refund:'||p_intent);
 UPDATE payment_orders SET refund_approval=intent WHERE id=p_order;
 RETURN intent;
END $fn$;

-- Recheck the operator and durable dispatch at the retry boundary, without
-- re-reserving credits or minting another execution identity.
CREATE OR REPLACE FUNCTION public.pay_common_package_refund_retry(
 p_actor uuid,p_order uuid,p_intent uuid,p_cash jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE i jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false')
   THEN RAISE EXCEPTION 'PAY_REFUND_ADMIN_REQUIRED'; END IF;
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT refund_approval INTO i FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF i->>'id' IS DISTINCT FROM p_intent::text OR coalesce(i->>'status','') NOT IN ('dispatching','review_required')
   OR i->>'idempotencyKey' IS DISTINCT FROM 'pay-common:refund:'||p_intent
   OR i->'cash' IS DISTINCT FROM p_cash
   OR (i->>'claimedAt')::timestamptz IS NULL
   OR clock_timestamp()-(i->>'claimedAt')::timestamptz NOT BETWEEN interval '0' AND interval '20 hours'
   THEN RAISE EXCEPTION 'PAY_REFUND_RETRY_REQUIRES_REVIEW'; END IF;
 RETURN i;
END $fn$;

CREATE OR REPLACE FUNCTION public.pay_common_package_refund_result(
 p_order uuid,p_intent uuid,p_refund jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE o payment_orders; i jsonb; next_status text; balance integer; amount integer;
BEGIN
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 i:=o.refund_approval;
 IF i->>'id' IS DISTINCT FROM p_intent::text OR i->>'status' NOT IN ('dispatching','pending','succeeded','failed','review_required')
   OR i->>'idempotencyKey' IS NULL THEN RAISE EXCEPTION 'PAY_REFUND_INTENT_MISMATCH'; END IF;
 IF p_refund->>'intentId' IS DISTINCT FROM p_intent::text OR p_refund->>'orderId' IS DISTINCT FROM o.id::text
   OR p_refund->>'paymentIntentId' IS DISTINCT FROM i->'cash'->>'paymentIntentId'
   OR p_refund->>'chargeId' IS DISTINCT FROM i->'cash'->>'chargeId'
   OR p_refund->>'currency' IS DISTINCT FROM i->>'currency'
   OR p_refund->>'amount' IS DISTINCT FROM i->>'netMinor'
   OR p_refund->>'mode' IS DISTINCT FROM o.payment_mode OR p_refund->>'merchant' IS DISTINCT FROM o.merchant_namespace
   OR nullif(p_refund->>'id','') IS NULL
   OR i->>'refundId' IS NOT NULL AND i->>'refundId' IS DISTINCT FROM p_refund->>'id'
   THEN RAISE EXCEPTION 'PAY_REFUND_RESULT_MISMATCH'; END IF;
 next_status:=p_refund->>'status';
 IF next_status IS NULL OR next_status NOT IN ('pending','requires_action','succeeded','failed','canceled')
   THEN RAISE EXCEPTION 'PAY_REFUND_RESULT_UNKNOWN'; END IF;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe',o.merchant_namespace,o.payment_mode,'refund',p_refund->>'id',o.id)
 ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM payment_provider_refs r WHERE r.channel='stripe'
   AND r.merchant_namespace=o.merchant_namespace AND r.mode=o.payment_mode AND r.object_type='refund'
   AND r.external_id=p_refund->>'id' AND r.order_id=o.id)
   THEN RAISE EXCEPTION 'PAY_REFUND_PROVIDER_MAPPING_CONFLICT'; END IF;
 IF i->>'status'='succeeded' THEN RETURN i; END IF;
 IF i->>'status'='failed' THEN
   IF next_status='succeeded' THEN RAISE EXCEPTION 'PAY_REFUND_TERMINAL_CONFLICT'; END IF;
   RETURN i;
 END IF;
 IF next_status IN ('failed','canceled') THEN
   amount:=(i->>'credits')::integer;
   SELECT credits INTO balance FROM profiles WHERE id=o.user_id;
   UPDATE profiles SET credits=credits+amount WHERE id=o.user_id;
   INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,
     source_type,source_order_id,idempotency_key,balance_before,balance_after)
   VALUES(o.user_id,amount,'refund','Failed cash refund credit restoration','adjustment','refund_failed_restore',
     'stripe_refund',o.id,'pay-common:refund-restore:'||p_intent,balance,balance+amount);
   next_status:='failed';
 ELSIF next_status<>'succeeded' THEN next_status:='pending';
 END IF;
 i:=i||jsonb_build_object('status',next_status,'refundId',p_refund->>'id','checkedAt',clock_timestamp());
 UPDATE payment_orders SET refund_approval=i,
   status=CASE WHEN next_status='succeeded' THEN
     CASE WHEN (i->>'netMinor')::integer=amount_total THEN 'refunded' ELSE 'partially_refunded' END ELSE status END,
   payment_status=CASE WHEN next_status='succeeded' THEN
     CASE WHEN (i->>'netMinor')::integer=amount_total THEN 'refunded' ELSE 'partially_refunded' END ELSE payment_status END,
   updated_at=clock_timestamp() WHERE id=o.id;
 RETURN i;
END $fn$;

-- Existing event reconciliation remains the entry for unrelated refunds. With an active
-- approved package refund, retain unmatched events for review instead of a second clawback.
DO $do$ BEGIN
 IF to_regprocedure('public.atomic_reconcile_stripe_refund_before_pr4b(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)') IS NULL THEN
   ALTER FUNCTION public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)
     RENAME TO atomic_reconcile_stripe_refund_before_pr4b;
 END IF;
END $do$;
CREATE OR REPLACE FUNCTION public.atomic_reconcile_stripe_refund(
 p_order_id uuid,p_idempotency_key text,p_refund_event_type text,p_refund_id text DEFAULT NULL,
 p_refund_status text DEFAULT NULL,p_refund_amount integer DEFAULT NULL,p_refund_currency text DEFAULT NULL,
 p_charge_id text DEFAULT NULL,p_payment_intent_id text DEFAULT NULL,p_invoice_id text DEFAULT NULL,
 p_subscription_id text DEFAULT NULL,p_refund_reason text DEFAULT NULL,p_refund_created_at timestamptz DEFAULT NULL,
 p_is_full_refund boolean DEFAULT false,p_is_failed boolean DEFAULT false
) RETURNS TABLE(order_id uuid,user_id uuid,order_status text,clawback_amount integer,shortfall_amount integer,
 transaction_id uuid,already_reconciled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE o payment_orders;
BEGIN
 PERFORM 1 FROM profiles WHERE id=(SELECT x.user_id FROM payment_orders x WHERE x.id=p_order_id) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order_id FOR UPDATE;
 IF o.refund_approval->>'idempotencyKey' IS NOT NULL THEN
   UPDATE payment_orders SET metadata=coalesce(metadata,'{}')||jsonb_build_object('refundExecutionUnmatchedEvent',
     jsonb_build_object('refundId',p_refund_id,'status',p_refund_status,'amount',p_refund_amount,
       'currency',p_refund_currency,'eventType',p_refund_event_type,'reviewRequired',true)) WHERE id=o.id;
   RETURN QUERY SELECT o.id,o.user_id,o.status,0,0,NULL::uuid,false; RETURN;
 END IF;
 RETURN QUERY SELECT * FROM atomic_reconcile_stripe_refund_before_pr4b(p_order_id,p_idempotency_key,
 p_refund_event_type,p_refund_id,p_refund_status,p_refund_amount,p_refund_currency,p_charge_id,p_payment_intent_id,
 p_invoice_id,p_subscription_id,p_refund_reason,p_refund_created_at,p_is_full_refund,p_is_failed);
END $fn$;
REVOKE ALL ON FUNCTION public.atomic_reconcile_stripe_refund_before_pr4b(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)
 TO service_role;
REVOKE ALL ON FUNCTION public.pay_common_package_refund_reject(uuid,uuid,uuid,text),
 public.pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text),
 public.pay_common_package_refund_decide(uuid,uuid,uuid,jsonb,text,text,text,text),
 public.pay_common_package_refund_claim(uuid,uuid,uuid,jsonb),
 public.pay_common_package_refund_retry(uuid,uuid,uuid,jsonb),public.pay_common_package_refund_result(uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_package_refund_reject(uuid,uuid,uuid,text),
 public.pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text),
 public.pay_common_package_refund_decide(uuid,uuid,uuid,jsonb,text,text,text,text),
 public.pay_common_package_refund_claim(uuid,uuid,uuid,jsonb),
 public.pay_common_package_refund_retry(uuid,uuid,uuid,jsonb),public.pay_common_package_refund_result(uuid,uuid,jsonb)
 TO service_role;
COMMIT;
