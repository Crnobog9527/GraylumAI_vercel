-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP 3a (0237): first payment of a Stripe card order goes through pay_waffo_fulfill_payment.
-- 0211 rejected every `card` credit package because `card` then meant a Waffo subscription. A Managed
-- Payments credit pack is a one-time Stripe payment (0221 contract: card + stripe + credit_package +
-- payment, no renewal), so only a Waffo card, a renewing order or a subscription id is still a conflict.
-- pay_stripe_mp_record_tax: Managed Payments adds tax on top of the pre-tax amount that grants the entitlement;
-- the tax is appended to the order's existing append-only payment_amount_facts (kind 'tax'), so the charged
-- total stays on record (#847: "税单独记到订单上").
-- No table or column changes. Rollback: forward-fix; financial rows are never deleted.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $card_pack$
DECLARE source text;
  old_check constant text:='IF o.payment_method=''card'' OR p_subscription IS NOT NULL THEN RAISE EXCEPTION ''PAY_WAFFO_PAYMENT_CONFLICT''; END IF;';
  new_check constant text:='IF (o.payment_method=''card'' AND o.payment_channel=''waffo'') OR o.auto_renew OR p_subscription IS NOT NULL'
    ||' THEN RAISE EXCEPTION ''PAY_WAFFO_PAYMENT_CONFLICT''; END IF;';
BEGIN
  source:=pg_get_functiondef('public.pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamptz,text,timestamptz,timestamptz)'::regprocedure);
  IF position(new_check IN source)=0 THEN
    IF position(old_check IN source)=0 THEN RAISE EXCEPTION 'PAY_STRIPE_MP_CARD_PACK_PATCH_MISSING'; END IF;
    EXECUTE replace(source,old_check,new_check);
  END IF;
END $card_pack$;

CREATE OR REPLACE FUNCTION public.pay_stripe_mp_record_tax(p_order uuid,p_merchant text,p_payment text,p_tax integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; fact jsonb; prior jsonb;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_mode IS DISTINCT FROM 'test'
  OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.payment_method NOT IN ('card','card_cn')
  OR p_tax IS NULL OR p_tax<0 OR (p_tax>0 AND o.payment_method<>'card')
  -- Only for a payment this order recorded (pay_waffo_fulfill_payment writes the reference, also for review).
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='payment' AND channel='stripe'
   AND merchant_namespace=p_merchant AND mode='test' AND external_id=p_payment) THEN
  RAISE EXCEPTION 'PAY_STRIPE_MP_TAX_SCOPE'; END IF;
 fact:=jsonb_build_object('kind','tax','amount',(p_tax::numeric/100)::numeric(20,2)::text,'currency','usd','unit','major',
  'evidence_ref',p_payment);
 SELECT v INTO prior FROM jsonb_array_elements(coalesce(o.payment_amount_facts,'[]'::jsonb)) v
  WHERE v->>'kind'='tax' AND v->>'evidence_ref'=p_payment LIMIT 1;
 IF prior IS NOT NULL THEN
  IF prior IS DISTINCT FROM fact THEN RAISE EXCEPTION 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'; END IF;
  RETURN jsonb_build_object('duplicate',true);
 END IF;
 UPDATE payment_orders SET payment_amount_facts=coalesce(payment_amount_facts,'[]'::jsonb)||jsonb_build_array(fact)
  WHERE id=o.id;
 RETURN jsonb_build_object('duplicate',false);
END $$;
REVOKE ALL ON FUNCTION public.pay_stripe_mp_record_tax(uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_stripe_mp_record_tax(uuid,text,text,integer) TO service_role;

COMMIT;
