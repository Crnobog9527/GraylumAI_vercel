-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP step 4b-1 (0252): our approved credit-pack refund (PAY-COMMON 0185) for method orders, with tax.
-- Rules unchanged (MASTER_PLAN item 51 / record AA): 7 days, no credit consumption on the account since the payment,
-- the 6% fee only where the law permits it (the admin chooses 'confirmed' / 'not_permitted'). Changes:
-- - card and wallet packs (method orders, 0211) are granted under 'method-package:' and carry no grantedCredits;
-- - an international card pack (Managed Payments) charged the pre-tax amount plus the tax recorded for its payment
--   (0237): the Stripe evidence must carry that tax (taxMinor), and the refund adds it in full:
--   refund = pre-tax - floor(pre-tax x 6%) + tax (controller 2026-10-14);
-- - "fully refunded" compares with the whole charge (pre-tax + tax).
-- Same signatures; full bodies replace 0185's. Rollback: forward-fix (re-create 0185's bodies).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_common_package_refund_quote(
 p_actor uuid,p_order uuid,p_ticket uuid,p_cash jsonb,p_fee text,p_fee_evidence text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE o payment_orders; t tickets; total integer; fee integer; result jsonb; paid_at timestamptz; tax integer:=0;
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
   OR coalesce((p_cash->>'taxMinor')::integer,0)<>0 AND o.payment_method IS DISTINCT FROM 'card'
   OR p_cash->>'refundedMinor' IS DISTINCT FROM '0'
   OR p_cash->>'refundCount' IS DISTINCT FROM '0' OR p_cash->>'disputed' IS DISTINCT FROM 'false'
   OR nullif(p_cash->>'chargeId','') IS NULL
   OR NOT EXISTS(SELECT 1 FROM payment_provider_refs r WHERE r.order_id=o.id AND r.object_type='payment'
     AND r.external_id=p_cash->>'paymentIntentId' AND r.channel='stripe'
     AND r.mode=o.payment_mode AND r.merchant_namespace=o.merchant_namespace)
   THEN RAISE EXCEPTION 'PAY_REFUND_CASH_EVIDENCE_INVALID'; END IF;
 -- PAY-STRIPE-MP: an international card pack (Managed Payments) charged the pre-tax amount plus the tax recorded
 -- for its payment (0237); the Stripe evidence must carry exactly that tax, and it is refunded in full.
 IF o.payment_method='card' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(o.payment_amount_facts,'[]'::jsonb)) f
    WHERE f->>'kind'='tax' AND f->>'evidence_ref'=p_cash->>'paymentIntentId') THEN RAISE EXCEPTION 'PAY_REFUND_TAX_PENDING'; END IF;
  SELECT coalesce(sum(round((f->>'amount')::numeric*100)),0)::integer INTO tax
    FROM jsonb_array_elements(o.payment_amount_facts) f WHERE f->>'kind'='tax' AND f->>'evidence_ref'=p_cash->>'paymentIntentId';
 END IF;
 IF coalesce((p_cash->>'taxMinor')::integer,0) IS DISTINCT FROM tax THEN RAISE EXCEPTION 'PAY_REFUND_CASH_EVIDENCE_INVALID'; END IF;
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
 IF total IS NULL OR total<=0
   -- Method orders (card / wallet, 0211) grant the pack under 'method-package:' and carry no grantedCredits.
   OR (o.payment_method IS NULL AND ((SELECT count(*) FROM credit_transactions c WHERE c.user_id=o.user_id
     AND c.source_order_id=o.id AND c.amount=total AND c.idempotency_key='pay-common:package:'||o.id::text)<>1
     OR total IS DISTINCT FROM (o.metadata->>'grantedCredits')::integer))
   OR (o.payment_method IS NOT NULL AND (SELECT count(*) FROM credit_transactions c WHERE c.user_id=o.user_id
     AND c.source_order_id=o.id AND c.amount=total AND c.idempotency_key='method-package:'||o.id::text)<>1)
   OR (SELECT credits FROM profiles WHERE id=o.user_id)<total
   THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
 IF p_fee IS NULL OR p_fee NOT IN ('confirmed','not_permitted')
   OR nullif(btrim(p_fee_evidence),'') IS NULL OR length(p_fee_evidence)>160
   THEN RAISE EXCEPTION 'PAY_REFUND_FEE_EVIDENCE_REQUIRED'; END IF;
 fee:=CASE WHEN p_fee='confirmed' THEN (o.amount_total::bigint*6/100)::integer ELSE 0 END;
 result:=jsonb_build_object('version',1,'orderId',o.id,'ticketId',t.id,'subjectId',o.user_id,
   'submittedAt',t.created_at,'reason','ordinary','treatment','credit_package','currency',o.currency,
   -- Refund = pre-tax amount less the 6% fee (when the law permits it, floored) plus the full recorded tax.
   'basisMinor',o.amount_total,'feeMinor',fee,'taxMinor',tax,'netMinor',o.amount_total-fee+tax,'credits',total,
   'feePermitted',p_fee,'feeEvidence',p_fee_evidence,'cash',p_cash);
 RETURN result||jsonb_build_object('versionHash',md5(result::text));
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
   -- Fully refunded when the whole charge (pre-tax amount plus the recorded tax) came back.
   status=CASE WHEN next_status='succeeded' THEN CASE WHEN (i->>'netMinor')::integer=amount_total+coalesce((i->>'taxMinor')::integer,0)
     THEN 'refunded' ELSE 'partially_refunded' END ELSE status END,
   payment_status=CASE WHEN next_status='succeeded' THEN CASE WHEN (i->>'netMinor')::integer=amount_total+coalesce((i->>'taxMinor')::integer,0)
     THEN 'refunded' ELSE 'partially_refunded' END ELSE payment_status END,
   updated_at=clock_timestamp() WHERE id=o.id;
 RETURN i;
END $fn$;

COMMIT;
