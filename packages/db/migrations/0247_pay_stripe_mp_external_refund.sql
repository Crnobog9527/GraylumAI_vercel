-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP 3c (0247): external refunds of Stripe card orders (card / card_cn).
-- A refund we did not approve (Link support, Stripe refunding after 48 hours without our reply, a Dashboard refund)
-- is a refund fact (#847 MIGRATION-PLAN section 3). One function records it for the order its payment paid for
-- (first payment, renewal or international-card credit pack; the payment is the order's 'payment' reference):
-- - every refund is recorded once (a 'refund' reference and a 'refund' payment fact), whatever order events arrive in;
-- - a FULL refund (refunded >= pre-tax amount + recorded tax) of a subscription period ends it: the period's unused
--   grant credits are taken back (the shortfall is Graylum's and is in the ledger), the order becomes refunded (no
--   membership from it, no further annual releases, recognisable as refunded for the founder rules) and the cached
--   level is settled by 0243; a full refund of a credit pack ends the order but only reports for a person to settle;
-- - without the payment's recorded tax the charged total is unknown: the refund is refused and retried;
-- - a PARTIAL refund is only recorded and returned for review (Owner/controller 2026-10-14: no automatic ending);
-- - renewal is never stopped here; the caller alerts when the subscription is still renewing.
-- No table or column changes. Rollback: forward-fix; financial rows are never deleted.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_stripe_mp_record_external_refund(
 p_order uuid,p_merchant text,p_payment text,p_refund text,p_amount integer,p_currency text,p_refunded_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; s user_subscriptions; owner profiles; ref payment_provider_refs;
 charged bigint; refunded bigint; credits_back integer:=0; taken integer:=0; renewing boolean:=false; key text;
BEGIN
 -- Profile first, then order: the same lock order as fulfillment, renewal and the subscription sync.
 SELECT * INTO owner FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR owner.id IS NULL OR o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_mode IS DISTINCT FROM 'test'
  OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.payment_method NOT IN ('card','card_cn')
  OR coalesce(p_refund,'') !~ '^(re|pyr)_[A-Za-z0-9_]{1,160}$' OR p_amount IS NULL OR p_amount<=0
  OR p_currency IS DISTINCT FROM o.currency OR p_refunded_at IS NULL OR p_refunded_at>clock_timestamp()+interval '5 minutes'
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='payment' AND channel='stripe'
   AND merchant_namespace=p_merchant AND mode='test' AND external_id=p_payment) THEN
  RAISE EXCEPTION 'PAY_STRIPE_MP_REFUND_SCOPE'; END IF;
 -- One record per Stripe refund, bound to one order.
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe',p_merchant,'test','refund',p_refund,o.id) ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO NOTHING;
 SELECT * INTO ref FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant AND mode='test'
  AND object_type='refund' AND external_id=p_refund;
 IF ref.order_id IS DISTINCT FROM o.id THEN RAISE EXCEPTION 'PAY_COMMON_REFUND_IDENTITY_MISMATCH'; END IF;
 IF o.subscription_id IS NOT NULL THEN
  SELECT * INTO s FROM user_subscriptions WHERE id=o.subscription_id;
  renewing:=s.status IN ('active','trialing','past_due','unpaid') AND s.cancel_at_period_end IS DISTINCT FROM 'true';
 END IF;
 -- A replay (retry after a crash, or the same refund via another event) returns the persisted review state, so the
 -- caller repeats any alert a crashed delivery never sent; nothing is recorded or taken back again.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(o.payment_amount_facts,'[]'::jsonb)) f
  WHERE f->>'kind'='refund' AND f->>'evidence_ref'=p_refund) THEN
  RETURN jsonb_build_object('state',coalesce(o.metadata->'stripeExternalRefund'->>'state','recorded'),'duplicate',true,
   'userId',o.user_id,'renewing',renewing,'packageId',CASE WHEN o.item_type='credit_package' THEN o.item_id END,
   'packCredits',o.metadata->'stripeExternalRefund'->'packCredits','balance',o.metadata->'stripeExternalRefund'->'balanceAtRefund');
 END IF;
 UPDATE payment_orders SET payment_amount_facts=coalesce(payment_amount_facts,'[]'::jsonb)||jsonb_build_array(
  jsonb_build_object('kind','refund','amount',(p_amount::numeric/100)::numeric(20,2)::text,'currency',o.currency,
   'unit','major','evidence_ref',p_refund)) WHERE id=o.id RETURNING * INTO o;
 -- Charged = pre-tax amount + the tax recorded for this payment (0237; recorded after every card payment, 0 without
 -- Managed Payments). Without it the charged total is unknown: refuse, so the refund is retried once tax is recorded.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(o.payment_amount_facts,'[]'::jsonb)) f
  WHERE f->>'kind'='tax' AND f->>'evidence_ref'=p_payment) THEN RAISE EXCEPTION 'PAY_STRIPE_MP_TAX_PENDING'; END IF;
 SELECT o.amount_total+coalesce(sum(round((f->>'amount')::numeric*100))::bigint,0) INTO charged
  FROM jsonb_array_elements(coalesce(o.payment_amount_facts,'[]'::jsonb)) f WHERE f->>'kind'='tax' AND f->>'evidence_ref'=p_payment;
 SELECT coalesce(sum(round((f->>'amount')::numeric*100))::bigint,0) INTO refunded
  FROM jsonb_array_elements(o.payment_amount_facts) f WHERE f->>'kind'='refund';
 -- Already ended by an earlier refund: this one is only recorded (the refund fact above), never ends it twice.
 IF o.status='refunded' THEN
  RETURN jsonb_build_object('state','refunded','duplicate',false,'userId',o.user_id,'renewing',renewing,
   'refundedMinor',refunded,'chargedMinor',charged);
 END IF;
 IF refunded<charged THEN
  UPDATE payment_orders SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('stripeExternalRefund',
   jsonb_build_object('state','partial_review','refundedMinor',refunded,'chargedMinor',charged,'lastRefundId',p_refund))
  WHERE id=o.id;
  RETURN jsonb_build_object('state','partial_review','duplicate',false,'userId',o.user_id,'renewing',renewing,
   'refundedMinor',refunded,'chargedMinor',charged);
 END IF;
 -- Full refund of a credit pack: packs are not tracked per source yet (PAY-DISPUTE-GUARD PR-D0), and a package
 -- refund is only recorded for a person to settle (MASTER_PLAN item 47; controller 2026-10-14, option B). The order
 -- is ended as refunded; no credits are taken; the caller alerts with the pack, its credits and the balance.
 IF o.item_type='credit_package' THEN
  SELECT coalesce(sum(amount),0) INTO credits_back FROM credit_transactions
   WHERE source_order_id=o.id AND idempotency_key='method-package:'||o.id;
  UPDATE payment_orders SET status='refunded',payment_status='refunded',
   metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('stripeExternalRefund',jsonb_build_object('state','pack_review',
    'refundedMinor',refunded,'chargedMinor',charged,'lastRefundId',p_refund,'refundedAt',p_refunded_at,
    'packCredits',credits_back,'balanceAtRefund',owner.credits))
  WHERE id=o.id;
  RETURN jsonb_build_object('state','pack_review','duplicate',false,'userId',o.user_id,'renewing',false,
   'packageId',o.item_id,'packCredits',credits_back,'balance',owner.credits,'refundedMinor',refunded,'chargedMinor',charged);
 END IF;
 -- Full refund of a subscription period: take back what this order's grants still hold, reverse them, end the order.
 -- Only what this order's own grants still hold (PAYG keeps consumed_amount per grant): other sources stay untouched.
 -- Never pushes the balance below zero.
 SELECT coalesce(sum(greatest(credits_granted-consumed_amount,0)),0) INTO credits_back FROM subscription_credit_grants
  WHERE source_order_id=o.id AND status='granted';
 UPDATE subscription_credit_grants SET status='reversed' WHERE source_order_id=o.id AND status='granted';
 taken:=least(greatest(owner.credits,0),credits_back)::integer;
 key:='pay-stripe-mp:external-refund:'||o.id;
 -- One ledger row per ended order, also when nothing could be taken back: the shortfall Graylum absorbs is on record.
 IF credits_back>0 THEN
  UPDATE profiles SET credits=credits-taken WHERE id=owner.id;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,
   source_refund_id,idempotency_key,balance_before,balance_after,metadata)
  VALUES(owner.id,-taken,'deduction','External card refund','refund_clawback','refund_clawback','stripe_refund',o.id,
   p_refund,key,owner.credits,owner.credits-taken,jsonb_build_object('creditsUnused',credits_back,'creditsTakenBack',taken,
    'creditsShortfall',credits_back-taken,'shortfallAbsorbedBy','graylum','refundedMinor',refunded,'chargedMinor',charged));
 END IF;
 UPDATE payment_orders SET status='refunded',payment_status='refunded',
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('stripeExternalRefund',jsonb_build_object('state','refunded',
   'refundedMinor',refunded,'chargedMinor',charged,'lastRefundId',p_refund,'refundedAt',p_refunded_at,
   'creditsUnused',credits_back,'creditsTakenBack',taken,'creditsShortfall',credits_back-taken))
 WHERE id=o.id;
 -- The refunded order no longer counts in pay_common_membership_facts; lower the cached level to match (0243).
 PERFORM pay_common_settle_membership_level(o.user_id);
 RETURN jsonb_build_object('state','refunded','duplicate',false,'userId',o.user_id,'renewing',renewing,
  'creditsTakenBack',taken,'creditsShortfall',credits_back-taken,'refundedMinor',refunded,'chargedMinor',charged);
END $$;
REVOKE ALL ON FUNCTION public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)
 TO service_role;

COMMIT;
