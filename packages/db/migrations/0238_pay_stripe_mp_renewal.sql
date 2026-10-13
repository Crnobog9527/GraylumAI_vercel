-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP 3b (0238): renewals, renewal failures and subscription state of Stripe card / card_cn
-- subscriptions (Owner 2026-10-12, #847 MIGRATION-PLAN sections 3 and 5).
-- 1. pay_stripe_mp_renew_subscription: one paid renewal invoice -> one internal order, granted once. Charges
--    the frozen list price (a card first month records 69/20; the renewal is 69 with no discount; founder 496).
-- 2. pay_stripe_mp_record_renewal_failure: the first failure time starts the founder 7-day deadline; a paid
--    renewal clears it.
-- 3. pay_stripe_mp_sync_subscription: only "stop at period end" and the final cancellation are copied. Stripe's
--    temporary past_due is not: our subscription stays active so the 24-hour grace keeps working while Stripe
--    retries.
-- 4. The 24-hour renewal grace (0214) and the founder deadline (0211) also cover Stripe card / card_cn.
-- No table or column changes. Rollback: forward-fix; financial rows are never deleted.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_stripe_mp_renew_subscription(
 p_subscription uuid,p_merchant text,p_invoice text,p_amount integer,p_currency text,
 p_paid timestamptz,p_start timestamptz,p_end timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions; original payment_orders; prior payment_orders; o payment_orders; actor uuid;
 snapshot jsonb; cents integer; term text; expected_end timestamptz; anchor_at timestamp; month_index integer;
 i integer; n integer:=0; review boolean;
BEGIN
 SELECT user_id INTO actor FROM user_subscriptions WHERE id=p_subscription;
 PERFORM 1 FROM profiles WHERE id=actor FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.payment_mode IS DISTINCT FROM 'test'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant OR s.stripe_subscription_id IS NOT NULL THEN
  RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_SCOPE'; END IF;
 SELECT * INTO original FROM payment_orders WHERE subscription_id=s.id AND payment_channel='stripe'
  AND payment_method IN ('card','card_cn') AND auto_renew AND purchase_action='checkout' AND fulfilled_at IS NOT NULL
  ORDER BY created_at LIMIT 1 FOR UPDATE;
 IF original.id IS NULL THEN RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_SCOPE'; END IF;
 -- invoice.paid and invoice.payment_succeeded for one invoice, and retries, are the same renewal.
 SELECT po.* INTO prior FROM payment_provider_refs r JOIN payment_orders po ON po.id=r.order_id
  WHERE r.channel='stripe' AND r.merchant_namespace=p_merchant AND r.mode='test' AND r.object_type='payment' AND r.external_id=p_invoice;
 IF prior.id IS NOT NULL THEN
  IF prior.subscription_id IS DISTINCT FROM s.id OR prior.amount_total IS DISTINCT FROM p_amount
    OR prior.currency IS DISTINCT FROM p_currency OR prior.entitlement_start IS DISTINCT FROM p_start
    OR prior.entitlement_end IS DISTINCT FROM p_end OR prior.qualified_paid_at IS DISTINCT FROM p_paid THEN
   RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_CONFLICT'; END IF;
  RETURN jsonb_build_object('state',CASE WHEN prior.fulfilled_at IS NOT NULL THEN 'fulfilled' ELSE 'review' END,'duplicate',true,'orderId',prior.id);
 END IF;
 -- The list price frozen at checkout: the first-month coupon is never carried into a renewal.
 cents:=round((original.purchase_snapshot->>'price')::numeric*100)::integer;
 term:=original.entitlement_term;
 anchor_at:=original.entitlement_start AT TIME ZONE 'UTC';
 month_index:=(extract(year FROM p_start AT TIME ZONE 'UTC')::integer-extract(year FROM anchor_at)::integer)*12
   +extract(month FROM p_start AT TIME ZONE 'UTC')::integer-extract(month FROM anchor_at)::integer;
 expected_end:=(anchor_at+make_interval(months=>month_index+CASE term WHEN 'year' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC';
 IF term NOT IN ('month','year') OR p_start IS NULL OR p_end IS DISTINCT FROM expected_end OR p_start<original.entitlement_end
  OR p_start IS DISTINCT FROM (anchor_at+make_interval(months=>month_index)) AT TIME ZONE 'UTC'
  OR term='year' AND month_index%12<>0
  OR p_paid IS NULL OR p_paid<p_start-interval '5 minutes' OR p_paid>=p_end OR p_paid>clock_timestamp()+interval '5 minutes'
  OR p_amount IS DISTINCT FROM cents OR p_currency IS DISTINCT FROM 'usd'
  OR coalesce(p_invoice,'') !~ '^in_[A-Za-z0-9_]{1,160}$'
  OR EXISTS(SELECT 1 FROM payment_orders WHERE subscription_id=s.id AND payment_status='paid'
    AND entitlement_start<p_end AND entitlement_end>p_start) THEN RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_CONFLICT'; END IF;
 snapshot:=original.purchase_snapshot||jsonb_build_object('price',(cents::numeric/100)::numeric(20,2)::text,'discount','0.00');
 review:=s.method_cancel_requested_at IS NOT NULL OR s.credit_release_terminated_at IS NOT NULL OR s.status<>'active'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=actor)
  OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=actor AND status='active' AND is_deleted='false');
 INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
  payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
  price_ref_id,purchase_action,purchase_membership_level,payment_method,auto_renew,entitlement_term,routing_version,
  terms_version,terms_accepted_at,offer_kind,qualification_state,subscription_id,source_order_id,qualified_paid_at,
  entitlement_start,entitlement_end,fulfilled_at,payment_amount_facts,method_review_reason,stripe_managed_payments)
 VALUES(actor,'membership_plan',original.item_id,original.billing_cycle,cents,'usd','subscription',
  CASE WHEN review THEN 'pending' ELSE 'completed' END,'paid','stripe',p_merchant,'test',gen_random_uuid(),
  encode(extensions.digest(p_invoice,'sha256'),'hex'),snapshot,original.price_ref_id,'checkout',original.purchase_membership_level,
  original.payment_method,true,term,original.routing_version,original.terms_version,original.terms_accepted_at,
  CASE WHEN original.offer_kind IN ('founder','founder_renewal') THEN 'founder_renewal' ELSE 'standard' END,
  CASE WHEN review THEN 'review' ELSE 'sold' END,s.id,original.id,p_paid,p_start,p_end,
  CASE WHEN NOT review THEN clock_timestamp() END,jsonb_build_array(jsonb_build_object('kind','paid','amount',
  (cents::numeric/100)::numeric(20,2)::text,'currency','usd','unit','major','evidence_ref',p_invoice)),
  CASE WHEN review THEN 'unexpected_renewal' END,original.stripe_managed_payments) RETURNING * INTO o;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe',p_merchant,'test','payment',p_invoice,o.id);
 IF review THEN RETURN jsonb_build_object('state','review','orderId',o.id,'refundRequired',true); END IF;
 UPDATE user_subscriptions SET current_period_start=p_start,current_period_end=p_end,founder_failed_at=NULL
  WHERE id=s.id AND current_period_end<p_end;
 FOR i IN 1..CASE original.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END LOOP n:=n+pay_waffo_grant_period(o.id,i); END LOOP;
 IF p_start<=clock_timestamp() AND p_end>clock_timestamp() THEN
  UPDATE profiles SET membership_level=CASE WHEN membership_level='gold' OR original.purchase_membership_level='gold'
    THEN 'gold' ELSE original.purchase_membership_level END WHERE id=actor;
 END IF;
 RETURN jsonb_build_object('state','fulfilled','orderId',o.id,'credits',n,'duplicate',false);
END $$;

CREATE OR REPLACE FUNCTION public.pay_stripe_mp_record_renewal_failure(
 p_subscription uuid,p_merchant text,p_invoice text,p_failed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions;
BEGIN
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.payment_mode IS DISTINCT FROM 'test'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant OR s.stripe_subscription_id IS NOT NULL
  OR coalesce(p_invoice,'') !~ '^in_[A-Za-z0-9_]{1,160}$' OR p_failed_at IS NULL
  OR p_failed_at>clock_timestamp()+interval '5 minutes'
  OR NOT EXISTS(SELECT 1 FROM payment_orders WHERE subscription_id=s.id AND payment_channel='stripe'
    AND payment_method IN ('card','card_cn') AND auto_renew AND fulfilled_at IS NOT NULL) THEN
  RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_SCOPE'; END IF;
 -- The earliest failure of the current period starts the deadline, even when Stripe's retry webhooks arrive
 -- out of order; a later retry never moves it later.
 IF p_failed_at>=s.current_period_end-interval '5 minutes'
  AND (s.founder_failed_at IS NULL OR p_failed_at<s.founder_failed_at) THEN
  UPDATE user_subscriptions SET founder_failed_at=p_failed_at WHERE id=s.id RETURNING * INTO s;
 END IF;
 RETURN jsonb_build_object('failedAt',coalesce(s.founder_failed_at,p_failed_at));
END $$;

CREATE OR REPLACE FUNCTION public.pay_stripe_mp_sync_subscription(
 p_subscription uuid,p_merchant text,p_cancel_at_period_end boolean,p_canceled boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions; remaining integer;
BEGIN
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM user_subscriptions WHERE id=p_subscription) FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.payment_mode IS DISTINCT FROM 'test'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant OR s.stripe_subscription_id IS NOT NULL
  OR p_cancel_at_period_end IS NULL OR p_canceled IS NULL
  OR NOT EXISTS(SELECT 1 FROM payment_orders WHERE subscription_id=s.id AND payment_channel='stripe'
    AND payment_method IN ('card','card_cn') AND auto_renew AND fulfilled_at IS NOT NULL) THEN
  RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_SCOPE'; END IF;
 -- A final cancellation is permanent: a late "updated" event can never reopen it.
 IF s.status='canceled' THEN RETURN jsonb_build_object('status','canceled','duplicate',true); END IF;
 UPDATE user_subscriptions SET status=CASE WHEN p_canceled THEN 'canceled' ELSE status END,
  cancel_at_period_end=CASE WHEN p_canceled OR p_cancel_at_period_end THEN 'true' ELSE 'false' END
  WHERE id=s.id RETURNING * INTO s;
 -- Final cancellation: the cached level (read by purchase admission) drops to the highest level still held:
 -- a paid membership period still running (e.g. an older Pro term after a Pro->Gold upgrade) or another
 -- active subscription (legacy Stripe, admin override); free when nothing is left. It is only ever lowered.
 IF s.status='canceled' THEN
  SELECT coalesce(max(lvl),0) INTO remaining FROM (
   SELECT CASE o.purchase_membership_level WHEN 'gold' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END lvl FROM payment_orders o
    WHERE o.user_id=s.user_id AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL
     AND o.payment_status='paid' AND o.status='completed' AND o.entitlement_start<=now() AND o.entitlement_end>now()
   UNION ALL
   SELECT CASE p.level WHEN 'gold' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END FROM user_subscriptions x
    JOIN membership_plans p ON p.id=x.membership_plan_id
    WHERE x.user_id=s.user_id AND x.id<>s.id AND (x.stripe_subscription_id IS NOT NULL OR x.status='admin_override')
     AND x.status IN ('active','trialing','past_due','unpaid','admin_override')
     AND (x.current_period_end IS NULL OR x.current_period_end>now())) held;
  UPDATE profiles SET membership_level=CASE remaining WHEN 2 THEN 'gold' WHEN 1 THEN 'pro' ELSE 'free' END
   WHERE id=s.user_id AND CASE membership_level WHEN 'gold' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END>remaining;
 END IF;
 RETURN jsonb_build_object('status',s.status,'cancelAtPeriodEnd',s.cancel_at_period_end,'duplicate',false);
END $$;

REVOKE ALL ON FUNCTION public.pay_stripe_mp_renew_subscription(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pay_stripe_mp_record_renewal_failure(uuid,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pay_stripe_mp_sync_subscription(uuid,text,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_stripe_mp_renew_subscription(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_stripe_mp_record_renewal_failure(uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_stripe_mp_sync_subscription(uuid,text,boolean,boolean) TO service_role;

-- 24-hour renewal grace (0214) and founder deadline (0211) for Stripe card / card_cn subscriptions.
DO $grace$
DECLARE source text;
  old_grace constant text:='AND o.payment_channel=''waffo'' AND o.payment_method=''card''';
  new_grace constant text:='AND (o.payment_channel=''waffo'' AND o.payment_method=''card'''
    ||' OR o.payment_channel=''stripe'' AND o.payment_method IN (''card'',''card_cn''))';
  old_founder constant text:='IF o.payment_method=''card'' THEN';
  new_founder constant text:='IF o.payment_method IN (''card'',''card_cn'') THEN';
BEGIN
  source:=pg_get_functiondef('public.pay_common_membership_facts(uuid)'::regprocedure);
  IF position(new_grace IN source)=0 THEN
    IF position(old_grace IN source)=0 THEN RAISE EXCEPTION 'PAY_STRIPE_MP_GRACE_PATCH_MISSING'; END IF;
    EXECUTE replace(source,old_grace,new_grace);
  END IF;
  source:=pg_get_functiondef('public.pay_waffo_founder_deadline(uuid)'::regprocedure);
  IF position(new_founder IN source)=0 THEN
    IF position(old_founder IN source)=0 THEN RAISE EXCEPTION 'PAY_STRIPE_MP_FOUNDER_PATCH_MISSING'; END IF;
    EXECUTE replace(source,old_founder,new_founder);
  END IF;
END $grace$;

COMMIT;
