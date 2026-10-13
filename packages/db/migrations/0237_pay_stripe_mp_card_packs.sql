-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP 3a (0237): first payment of a Stripe card order goes through pay_waffo_fulfill_payment.
-- 0211 rejected every `card` credit package because `card` then meant a Waffo subscription. A Managed
-- Payments credit pack is a one-time Stripe payment (0221 contract: card + stripe + credit_package +
-- payment, no renewal), so only a Waffo card, a renewing order or a subscription id is still a conflict.
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

COMMIT;
