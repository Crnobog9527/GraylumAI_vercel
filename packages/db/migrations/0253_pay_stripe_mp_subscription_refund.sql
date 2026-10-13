-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP step 4b-2 (0253): our approved monthly first-purchase refund (PAY-COMMON 0193-0195) for card
-- subscriptions (0222). Rules unchanged (MASTER_PLAN item 51 / record AA): 7 days, no credit consumption on the
-- account since the payment, the 6% fee only where the law permits it; stop renewal, refund, then cancel the Stripe
-- subscription at once (marked Graylum-initiated by the server), or restore renewal when the refund fails. Changes:
-- - a card subscription stores no Stripe ids on its rows: its Stripe subscription is its 'subscription' reference and
--   its first invoice its 'payment' reference; its grants carry no Stripe invoice or subscription id;
-- - a card checkout row that never took money (abandoned, expired) is not membership history;
-- - an international card (Managed Payments) charged the pre-tax amount plus the tax recorded for its invoice (0237):
--   terms carry taxMinor (card orders only, 0 for a mainland card) and the refund adds it in full:
--   refund = pre-tax - floor(pre-tax x 6%) + tax (controller 2026-10-14); "fully refunded" compares with the whole
--   charge; the erasure proof (0195) accepts such terms.
-- Same signatures; full bodies replace 0193/0194's (validate, result); 0195's erasure check is kept and wrapped.
-- Rollback: forward-fix (re-create 0193/0194's bodies; rename the 0195 check back).
BEGIN;
SET LOCAL lock_timeout='5s';

-- Called under profile -> order -> subscription -> grants locks. Provider facts are
-- server-read, not client input; this function independently checks all local facts.
CREATE OR REPLACE FUNCTION public.monthly_refund_validate(p_actor uuid,p_order uuid,p_terms jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;s user_subscriptions;t tickets;g subscription_credit_grants;
 total bigint:=0;paid timestamptz;fee bigint;witness jsonb;card boolean;tax bigint:=0;
BEGIN
 PERFORM monthly_refund_assert_admin(p_actor);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=o.subscription_id FOR UPDATE;
 SELECT * INTO t FROM tickets WHERE id=(p_terms->>'ticketId')::uuid FOR SHARE;
 -- PAY-STRIPE-MP: a card subscription (0222) stores no Stripe ids on its rows; its Stripe subscription is its
 -- 'subscription' reference and its first invoice its 'payment' reference.
 card:=coalesce(o.payment_method IN ('card','card_cn'),false);
 IF o.id IS NULL OR s.id IS NULL OR t.id IS NULL OR p_terms IS NULL
 OR p_terms->>'kind' IS DISTINCT FROM 'monthly_first_purchase'
 OR p_terms->>'orderId' IS DISTINCT FROM o.id::text OR p_terms->>'userId' IS DISTINCT FROM o.user_id::text
 OR p_terms->>'subscriptionId' IS DISTINCT FROM s.id::text OR s.user_id IS DISTINCT FROM o.user_id
 OR t.user_id IS DISTINCT FROM o.user_id OR t.category IS DISTINCT FROM 'billing' OR t.is_deleted IS DISTINCT FROM 'false'
 OR o.item_type IS DISTINCT FROM 'membership_plan' OR o.billing_cycle IS DISTINCT FROM 'monthly'
 OR s.billing_cycle IS DISTINCT FROM 'monthly' OR o.source_order_id IS NOT NULL
 OR o.status IS DISTINCT FROM 'completed' OR o.payment_status IS DISTINCT FROM 'paid' OR o.fulfilled_at IS NULL
 OR s.status IS DISTINCT FROM 'active' OR s.credit_release_terminated_at IS NOT NULL
 OR s.current_period_end IS DISTINCT FROM (p_terms->>'periodEnd')::timestamptz OR s.current_period_end<=clock_timestamp()
 OR s.cancel_at_period_end IS DISTINCT FROM p_terms->>'originalCancelAtPeriodEnd'
 OR o.purchase_snapshot IS NULL OR o.purchase_snapshot IS DISTINCT FROM p_terms->'snapshot'
 OR s.contract_snapshot IS DISTINCT FROM o.purchase_snapshot OR s.membership_plan_id IS DISTINCT FROM o.item_id
 OR o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_mode IS DISTINCT FROM 'test'
 OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.payment_mode IS DISTINCT FROM 'test'
 OR o.merchant_namespace IS NULL OR o.merchant_namespace IS DISTINCT FROM s.merchant_namespace
 OR o.merchant_namespace IS DISTINCT FROM p_terms->>'merchant' OR p_terms->>'mode' IS DISTINCT FROM 'test'
 OR NOT card AND s.stripe_subscription_id IS DISTINCT FROM p_terms->>'providerSubscriptionId'
 OR card AND (s.stripe_subscription_id IS NOT NULL OR o.qualification_state IS DISTINCT FROM 'sold')
 OR p_terms->>'plan' IS NULL OR p_terms->>'plan' NOT IN ('pro','gold')
 OR o.purchase_membership_level IS DISTINCT FROM p_terms->>'plan'
 OR NOT EXISTS(SELECT 1 FROM membership_plans WHERE id=s.membership_plan_id AND level=p_terms->>'plan')
 OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=o.user_id AND status='active' AND is_deleted='false')
 OR o.refund_approval IS NOT NULL AND (o.refund_approval->>'kind' IS DISTINCT FROM 'monthly_first_purchase'
   OR o.refund_approval->>'status' IS DISTINCT FROM 'approved')
 THEN RAISE EXCEPTION 'PAY_MONTHLY_SCOPE_OR_STATE'; END IF;
 paid:=(p_terms->>'paidAt')::timestamptz;
 IF paid IS NULL OR paid>t.created_at OR t.created_at>clock_timestamp()
 OR t.created_at-paid>interval '168 hours' OR t.created_at IS DISTINCT FROM (p_terms->>'submittedAt')::timestamptz
 THEN RAISE EXCEPTION 'PAY_REFUND_WINDOW'; END IF;
 -- An international card (Managed Payments) charged the pre-tax amount plus the tax recorded for this invoice
 -- (0237); the refund adds that tax in full. Other orders carry no tax in their terms.
 IF o.payment_method='card' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(o.payment_amount_facts,'[]'::jsonb)) f
   WHERE f->>'kind'='tax' AND f->>'evidence_ref'=p_terms->>'invoiceId') THEN RAISE EXCEPTION 'PAY_REFUND_TAX_PENDING'; END IF;
  SELECT coalesce(sum(round((f->>'amount')::numeric*100)),0)::bigint INTO tax FROM jsonb_array_elements(o.payment_amount_facts) f
   WHERE f->>'kind'='tax' AND f->>'evidence_ref'=p_terms->>'invoiceId';
 END IF;
 IF card IS DISTINCT FROM (p_terms ? 'taxMinor') OR card AND (p_terms->>'taxMinor')::bigint IS DISTINCT FROM tax
 THEN RAISE EXCEPTION 'PAY_MONTHLY_CASH'; END IF;
 IF o.amount_total IS NULL OR o.amount_total<=0 OR o.currency IS DISTINCT FROM p_terms->>'currency'
 OR o.amount_total IS DISTINCT FROM (p_terms->>'paidMinor')::bigint
 OR o.amount_total IS DISTINCT FROM (p_terms->>'basisMinor')::bigint
 OR p_terms->>'feePermitted' IS NULL OR p_terms->>'feePermitted' NOT IN ('confirmed','not_permitted')
 OR nullif(btrim(p_terms->>'feeEvidence'),'') IS NULL OR length(p_terms->>'feeEvidence')>160
 OR nullif(p_terms->>'chargeId','') IS NULL OR nullif(p_terms->>'paymentIntentId','') IS NULL
 THEN RAISE EXCEPTION 'PAY_MONTHLY_CASH'; END IF;
 fee:=CASE WHEN p_terms->>'feePermitted'='confirmed' THEN o.amount_total::bigint*6/100 ELSE 0 END;
 IF fee IS DISTINCT FROM (p_terms->>'feeMinor')::bigint
 OR o.amount_total-fee+tax IS DISTINCT FROM (p_terms->>'netMinor')::bigint
 THEN RAISE EXCEPTION 'PAY_MONTHLY_AMOUNT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id
 AND object_type=CASE WHEN card THEN 'payment' ELSE 'invoice' END
 AND external_id=p_terms->>'invoiceId' AND channel='stripe' AND mode='test' AND merchant_namespace=o.merchant_namespace)
 OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=s.id AND object_type='subscription'
 AND external_id=CASE WHEN card THEN p_terms->>'providerSubscriptionId' ELSE s.stripe_subscription_id END
 AND channel='stripe' AND mode='test' AND merchant_namespace=o.merchant_namespace)
 OR EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='refund')
 -- A card checkout row is created before payment; one that never took money (abandoned, expired) is not history.
 OR (SELECT count(*) FROM payment_orders x WHERE x.user_id=o.user_id AND x.item_type='membership_plan'
  AND (NOT card OR x.payment_method IS NULL OR x.payment_method NOT IN ('card','card_cn')
   OR x.fulfilled_at IS NOT NULL OR x.payment_status IN ('paid','refunded','partially_refunded')
   OR EXISTS(SELECT 1 FROM payment_provider_refs r WHERE r.order_id=x.id AND r.object_type IN ('payment','invoice'))))<>1
 OR (SELECT count(*) FROM user_subscriptions WHERE user_id=o.user_id)<>1
 THEN RAISE EXCEPTION 'PAY_MONTHLY_HISTORY'; END IF;
 IF EXISTS(SELECT 1 FROM billing_history h WHERE h.user_id=o.user_id AND h.operation_type='pre_deduct'
 AND NOT EXISTS(SELECT 1 FROM billing_history d WHERE d.user_id=h.user_id
 AND d.operation_type IN ('settle','refund','abort_settle') AND d.metadata->>'preDeductId'=h.id::text))
 THEN RAISE EXCEPTION 'PAY_REFUND_SETTLEMENT_UNRESOLVED'; END IF;
 IF EXISTS(SELECT 1 FROM credit_transactions c WHERE c.user_id=o.user_id AND c.created_at>=paid
 AND (c.counts_as_spend=true AND c.amount<>0 OR c.ledger_type='spend' AND c.amount<>0 OR c.amount<0 AND
 (c.ledger_type IS NULL OR c.ledger_type NOT IN ('refund_clawback','adjustment','expiration','spend')
 OR c.ledger_type='adjustment' AND coalesce(c.source_type,'')<>'admin'
 AND coalesce(c.reason_code,'')<>'bill2_reserve' AND coalesce(c.idempotency_key,'') NOT LIKE 'admin_adjustment:%'
 AND coalesce(c.idempotency_key,'') NOT LIKE 'admin_credit_deduction:%')))
 THEN RAISE EXCEPTION 'PAY_REFUND_CONSUMPTION_OR_UNKNOWN'; END IF;
 FOR g IN SELECT * FROM subscription_credit_grants WHERE user_id=o.user_id ORDER BY id FOR UPDATE LOOP
  IF g.source_order_id IS DISTINCT FROM o.id OR g.subscription_id IS DISTINCT FROM s.id
  OR g.status IS DISTINCT FROM 'granted' OR g.accounting_state IS DISTINCT FROM 'trusted' OR g.consumed_amount<>0
  OR g.grant_snapshot IS DISTINCT FROM o.purchase_snapshot OR g.billing_cycle IS DISTINCT FROM 'monthly'
  OR g.grant_type IS DISTINCT FROM 'monthly_invoice'
  OR g.stripe_invoice_id IS DISTINCT FROM (CASE WHEN card THEN NULL ELSE p_terms->>'invoiceId' END)
  OR g.stripe_subscription_id IS DISTINCT FROM s.stripe_subscription_id
  OR g.period_start IS DISTINCT FROM s.current_period_start OR g.period_end IS DISTINCT FROM s.current_period_end
  OR g.credits_granted<=0 OR NOT EXISTS(SELECT 1 FROM credit_transactions c WHERE c.id=g.credit_transaction_id
   AND c.user_id=o.user_id AND c.source_order_id=o.id AND c.ledger_type='grant' AND c.amount=g.credits_granted)
  THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
  total:=total+g.credits_granted;
 END LOOP;
 IF total<=0 OR total IS DISTINCT FROM (p_terms->>'credits')::bigint
 OR total IS DISTINCT FROM (o.purchase_snapshot->>'credits')::bigint+(o.purchase_snapshot->>'bonus_credits')::bigint
 OR (SELECT credits FROM profiles WHERE id=o.user_id)<total THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
 -- Bind approval to every local financial row, without retaining personal content.
 witness:=jsonb_build_object('order',to_jsonb(o)-ARRAY['refund_approval','updated_at','metadata','checkout_request'],
  'subscription',to_jsonb(s)-ARRAY['metadata','updated_at'],'ticket',jsonb_build_object('id',t.id,'at',t.created_at),
  'ledger',(SELECT jsonb_agg(jsonb_build_array(id,amount,ledger_type,counts_as_spend,source_type,reason_code,
   source_order_id,idempotency_key,created_at) ORDER BY id) FROM credit_transactions WHERE user_id=o.user_id),
  'grants',(SELECT jsonb_agg(to_jsonb(x)-ARRAY['metadata','updated_at'] ORDER BY id) FROM subscription_credit_grants x WHERE user_id=o.user_id),
  'holds',(SELECT jsonb_agg(jsonb_build_array(id,operation_type,metadata->>'preDeductId') ORDER BY id)
   FROM billing_history WHERE user_id=o.user_id));
 RETURN md5(witness::text);
END $$;

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
 -- PAY-STRIPE-MP: fully refunded when the whole charge (pre-tax amount plus the recorded tax) came back.
 UPDATE payment_orders SET refund_approval=i,
 status=CASE WHEN next_status='succeeded' THEN CASE WHEN (t->>'netMinor')::integer=amount_total+coalesce((t->>'taxMinor')::integer,0)
 THEN 'refunded' ELSE 'partially_refunded' END ELSE status END,
 payment_status=CASE WHEN next_status='succeeded' THEN CASE WHEN (t->>'netMinor')::integer=amount_total+coalesce((t->>'taxMinor')::integer,0)
 THEN 'refunded' ELSE 'partially_refunded' END ELSE payment_status END WHERE id=p_order;
 RETURN i;
END $$;

-- 0195's erasure proof of a finished refund, kept as is; card terms are checked here and then shown to it without
-- their tax (a refund without tax is exactly what it validates).
DO $$ BEGIN
 IF to_regprocedure('public.monthly_refund_erasure_safe_0195(jsonb)') IS NULL THEN
  ALTER FUNCTION public.monthly_refund_erasure_safe(jsonb) RENAME TO monthly_refund_erasure_safe_0195;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.monthly_refund_erasure_safe(i jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE t jsonb;tax numeric;
BEGIN
 t:=i->'terms';
 IF t IS NULL OR jsonb_typeof(t)<>'object' OR NOT t ? 'taxMinor' THEN RETURN monthly_refund_erasure_safe_0195(i); END IF;
 IF jsonb_typeof(t->'taxMinor')<>'number' OR jsonb_typeof(t->'netMinor')<>'number' THEN RETURN false; END IF;
 tax:=(t->>'taxMinor')::numeric;
 IF tax<0 OR tax<>trunc(tax) OR tax>9007199254740991 OR (t->>'netMinor')::numeric-tax<=0 THEN RETURN false; END IF;
 RETURN monthly_refund_erasure_safe_0195(jsonb_set(i,'{terms}',(t-'taxMinor')
  ||jsonb_build_object('netMinor',(t->>'netMinor')::numeric-tax)));
EXCEPTION WHEN others THEN RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.monthly_refund_validate(uuid,uuid,jsonb),public.monthly_refund_erasure_safe(jsonb),
 public.monthly_refund_erasure_safe_0195(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pay_common_monthly_refund_result(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_monthly_refund_result(uuid,uuid,jsonb) TO service_role;
COMMIT;
