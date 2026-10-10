-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-WAFFO step 2. Number assigned by control in #791. Test-only; no sales/config seed.
BEGIN;
ALTER TABLE public.payment_orders
 ADD COLUMN IF NOT EXISTS method_dispatched_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_checkout_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_transition text CHECK(method_transition IN ('upgrade','founder_renewal')),
 ADD COLUMN IF NOT EXISTS method_prior_subscription uuid REFERENCES public.user_subscriptions(id),
 ADD COLUMN IF NOT EXISTS method_review_reason text,
 ADD COLUMN IF NOT EXISTS method_upgrade_charge_at timestamptz;
DROP TRIGGER IF EXISTS pay_waffo_upgrade_charge_freeze ON public.payment_orders;
CREATE TRIGGER pay_waffo_upgrade_charge_freeze BEFORE UPDATE ON public.payment_orders
 FOR EACH ROW EXECUTE FUNCTION public.pay_common_frozen_guard('method_upgrade_charge_at');
ALTER TABLE public.user_subscriptions
 ADD COLUMN IF NOT EXISTS method_cancel_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_cancel_dispatched_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_cancel_confirmed_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_observed_at timestamptz,
 ADD COLUMN IF NOT EXISTS founder_failed_at timestamptz;
ALTER TABLE public.waffo_event_receipts
 ADD COLUMN IF NOT EXISTS resolution jsonb,
 ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- Pack prices are distinct provider objects for Pro (95%) and Gold (90%).
-- Existing generic references stay legacy; never infer a provider price's discounted amount.
ALTER TABLE public.payment_provider_refs ADD COLUMN IF NOT EXISTS package_tier text NOT NULL DEFAULT 'legacy'
 CHECK(package_tier IN ('legacy','pro','gold') AND
   (package_tier='legacy' OR (object_type='price' AND credit_package_id IS NOT NULL AND offer_kind='standard')));
DROP INDEX IF EXISTS public.pay_common_current_package_price;
CREATE UNIQUE INDEX pay_common_current_package_price ON public.payment_provider_refs
 (channel,merchant_namespace,mode,credit_package_id,billing_cycle,package_tier)
 WHERE object_type='price' AND is_current AND credit_package_id IS NOT NULL;
DROP TRIGGER IF EXISTS pay_waffo_package_tier_freeze ON public.payment_provider_refs;
CREATE TRIGGER pay_waffo_package_tier_freeze BEFORE UPDATE ON public.payment_provider_refs
 FOR EACH ROW EXECUTE FUNCTION public.pay_common_frozen_guard('package_tier');
-- Old checkout callers can select only their old generic mappings.
DO $legacy_price$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text)'::regprocedure);
 IF position('r.package_tier' IN source)=0 THEN
  IF position('ELSE r.credit_package_id=p_item_id END' IN source)=0 THEN
   RAISE EXCEPTION 'PAY_WAFFO_LEGACY_PRICE_PATCH_MISSING'; END IF;
  source:=replace(source,'ELSE r.credit_package_id=p_item_id END',
   'ELSE r.credit_package_id=p_item_id AND r.package_tier=''legacy'' END');
  EXECUTE source;
 END IF;
END $legacy_price$;

-- The old admin API validates one generic price, not three discounted provider objects.
-- Same-price mapping maintenance preserves tiers; amount changes need a tier-aware operation.
DO $tier_catalog$
DECLARE source text; guard text;
BEGIN
 source:=pg_get_functiondef('public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text)'::regprocedure);
 IF position('PAY_WAFFO_TIER_PRICE_UPDATE_REQUIRED' IN source)=0 THEN
  IF position('  IF current_row IS NOT NULL THEN' IN source)=0
   OR position('IF FOUND AND (' IN source)=0
   OR position('UPDATE payment_provider_refs SET is_current=false WHERE' IN source)=0 THEN
   RAISE EXCEPTION 'PAY_WAFFO_CATALOG_PATCH_MISSING'; END IF;
  guard:=$guard$
  IF p_kind='credit_package' AND current_row IS NOT NULL AND p_values ? 'price'
    AND p_values->'price' IS DISTINCT FROM current_row->'price'
    AND EXISTS(SELECT 1 FROM payment_provider_refs WHERE credit_package_id=target
      AND object_type='price' AND is_current AND package_tier IN ('pro','gold')) THEN
    RAISE EXCEPTION 'PAY_WAFFO_TIER_PRICE_UPDATE_REQUIRED' USING ERRCODE='23514';
  END IF;
$guard$;
  source:=replace(source,'  IF current_row IS NOT NULL THEN',guard||'  IF current_row IS NOT NULL THEN');
  source:=replace(source,'IF FOUND AND (','IF FOUND AND (old_ref.package_tier<>''legacy'' OR ');
  source:=replace(source,'UPDATE payment_provider_refs SET is_current=false WHERE',
   'UPDATE payment_provider_refs SET is_current=false WHERE package_tier=''legacy'' AND');
  EXECUTE source;
 END IF;
END $tier_catalog$;

-- All additions use existing authorities. These helpers are service-only, never client RPCs.
CREATE OR REPLACE FUNCTION public.pay_waffo_assert_actor(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM profiles WHERE id=p_user AND status='active' AND is_deleted::text='false' FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user) THEN
  RAISE EXCEPTION 'PAY_WAFFO_ACCOUNT_CLOSED' USING ERRCODE='42501';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pay_waffo_claim_checkout(
 p_user uuid,p_order uuid,p_merchant text,p_request jsonb,p_expires timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(7063,2);
 PERFORM pay_waffo_assert_actor(p_user);
 SELECT * INTO o FROM payment_orders WHERE id=p_order AND user_id=p_user FOR UPDATE;
 IF o.id IS NULL OR o.payment_mode IS DISTINCT FROM 'test' OR o.payment_method IS NULL
   OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.qualification_state IS DISTINCT FROM 'reserved'
   OR o.purchase_closed_at IS NOT NULL THEN RAISE EXCEPTION 'PAY_WAFFO_CHECKOUT_DENIED'; END IF;
 IF o.method_dispatched_at IS NOT NULL THEN
  RETURN jsonb_build_object('dispatch',false,'request',o.checkout_request,'expiresAt',o.method_checkout_expires_at);
 END IF;
 IF o.method_transition='upgrade' AND (p_expires>clock_timestamp()+interval '31 minutes'
   OR o.method_upgrade_charge_at IS NOT NULL AND p_expires>=o.method_upgrade_charge_at-interval '48 hours') THEN
  RAISE EXCEPTION 'PAY_WAFFO_UPGRADE_WAIT'; END IF;
 IF o.payment_method='card' AND EXISTS(SELECT 1 FROM system_settings WHERE key='waffo_test_product_'||o.price_ref_id
  AND value->>'state' IN ('blocking','blocked','restoring')) THEN RAISE EXCEPTION 'PAY_WAFFO_PRODUCT_PAUSED'; END IF;
 IF p_expires IS NULL OR p_expires<=clock_timestamp() OR p_expires>clock_timestamp()+interval '31 minutes'
   OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR octet_length(p_request::text)>16384
   OR p_request->>'orderId' IS DISTINCT FROM o.id::text
   OR p_request->>'userId' IS DISTINCT FROM p_user::text
   OR p_request->>'method' IS DISTINCT FROM o.payment_method
   OR p_request->>'merchant' IS DISTINCT FROM p_merchant
   OR p_request->>'mode' IS DISTINCT FROM 'test'
   OR (p_request-ARRAY['orderId','userId','method','merchant','mode','providerRequest'])<>'{}'::jsonb
   OR jsonb_typeof(p_request->'providerRequest') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'PAY_WAFFO_CHECKOUT_INVALID';
 END IF;
 UPDATE payment_orders SET checkout_request=p_request,method_dispatched_at=clock_timestamp(),
   method_checkout_expires_at=p_expires WHERE id=o.id;
 RETURN jsonb_build_object('dispatch',true,'request',p_request,'expiresAt',p_expires);
END $$;

CREATE OR REPLACE FUNCTION public.pay_waffo_bind_checkout(
 p_user uuid,p_order uuid,p_merchant text,p_checkout text,p_expires timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; ref payment_provider_refs;
BEGIN
 -- Financial recovery after account closure must still preserve the original mapping.
 PERFORM 1 FROM profiles WHERE id=p_user FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order AND user_id=p_user FOR UPDATE;
 IF o.id IS NULL OR o.payment_mode IS DISTINCT FROM 'test' OR o.merchant_namespace IS DISTINCT FROM p_merchant
   OR o.payment_method IS NULL OR o.method_dispatched_at IS NULL
   OR p_expires IS NULL OR p_expires>o.method_checkout_expires_at OR p_expires<=o.method_dispatched_at
   OR coalesce(p_checkout,'') !~ '^[A-Za-z0-9_:-]{1,160}$' THEN RAISE EXCEPTION 'PAY_WAFFO_CHECKOUT_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='checkout' AND external_id<>p_checkout) THEN
  RAISE EXCEPTION 'PAY_WAFFO_EXTRA_CHECKOUT_REVIEW';
 END IF;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES(o.payment_channel,p_merchant,'test','checkout',p_checkout,o.id) ON CONFLICT DO NOTHING;
 SELECT * INTO ref FROM payment_provider_refs WHERE channel=o.payment_channel AND merchant_namespace=p_merchant
   AND mode='test' AND object_type='checkout' AND external_id=p_checkout;
 IF ref.order_id IS DISTINCT FROM o.id THEN RAISE EXCEPTION 'PAY_WAFFO_CHECKOUT_CONFLICT'; END IF;
END $$;

-- One paid source, one canonical grant per period. Actor/order/subscription locks precede source locks.
CREATE OR REPLACE FUNCTION public.pay_waffo_grant_period(p_order uuid,p_index integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; s user_subscriptions; actor profiles; start_at timestamptz; end_at timestamptz;
 n integer; periods integer; key text; tx uuid; existing subscription_credit_grants;
BEGIN
 SELECT user_id INTO actor.id FROM payment_orders WHERE id=p_order;
 SELECT * INTO actor FROM profiles WHERE id=actor.id FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=o.subscription_id FOR UPDATE;
 IF o.id IS NULL OR s.id IS NULL OR o.payment_mode IS DISTINCT FROM 'test' OR o.payment_method IS NULL
   OR o.qualification_state IS DISTINCT FROM 'sold' OR o.payment_status IS DISTINCT FROM 'paid'
   OR o.status IS DISTINCT FROM 'completed' OR o.fulfilled_at IS NULL
   OR s.user_id IS DISTINCT FROM actor.id OR s.credit_release_terminated_at IS NOT NULL
   OR actor.status IS DISTINCT FROM 'active' OR actor.is_deleted::text IS DISTINCT FROM 'false'
   OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=actor.id) THEN RETURN 0; END IF;
 periods:=CASE o.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END;
 IF p_index IS NULL OR p_index<1 OR p_index>periods THEN RAISE EXCEPTION 'PAY_WAFFO_GRANT_INVALID'; END IF;
 start_at:=CASE WHEN periods=12 THEN ((o.entitlement_start AT TIME ZONE 'UTC')+make_interval(months=>p_index-1))
   AT TIME ZONE 'UTC' ELSE o.entitlement_start END;
 end_at:=CASE WHEN periods=12 THEN least(o.entitlement_end,((o.entitlement_start AT TIME ZONE 'UTC')
   +make_interval(months=>p_index)) AT TIME ZONE 'UTC') ELSE o.entitlement_end END;
 IF start_at>clock_timestamp() THEN RETURN 0; END IF;
 key:='payment:'||o.id::text||':'||lpad(p_index::text,2,'0');
 SELECT * INTO existing FROM subscription_credit_grants WHERE subscription_id=s.id AND source_order_id=o.id
   AND grant_period_key=key FOR UPDATE;
 IF FOUND THEN RETURN 0; END IF;
 n:=(o.purchase_snapshot->>'credits')::integer/periods
   +CASE WHEN p_index<=(o.purchase_snapshot->>'credits')::integer%periods THEN 1 ELSE 0 END
   +CASE WHEN periods=1 THEN (o.purchase_snapshot->>'bonus_credits')::integer ELSE 0 END;
 IF n<=0 THEN RAISE EXCEPTION 'PAY_WAFFO_GRANT_INVALID'; END IF;
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_type,source_order_id,
   idempotency_key,balance_before,balance_after,description)
 VALUES(actor.id,n,'purchase','grant','payment_order',o.id,key,actor.credits,actor.credits+n,'Membership paid period') RETURNING id INTO tx;
 INSERT INTO subscription_credit_grants(user_id,membership_plan_id,billing_cycle,grant_type,
   grant_period_key,period_start,period_end,period_index,total_periods,credits_granted,idempotency_key,
   credit_transaction_id,subscription_id,source_order_id,grant_snapshot,accounting_state,accounting_review_reason)
 VALUES(actor.id,o.item_id,o.billing_cycle,CASE WHEN periods=12 THEN 'annual_monthly_release' ELSE 'monthly_invoice' END,
   key,start_at,end_at,CASE WHEN periods=12 THEN p_index END,periods,n,key,tx,s.id,o.id,o.purchase_snapshot,'trusted',NULL);
 UPDATE profiles SET credits=credits+n WHERE id=actor.id;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.pay_waffo_fulfill_payment(
 p_order uuid,p_merchant text,p_checkout text,p_payment text,p_amount integer,p_currency text,
 p_paid_at timestamptz,p_subscription text,p_start timestamptz,p_end timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; actor profiles; sub user_subscriptions; state text; expected_end timestamptz; ref payment_provider_refs;
 n integer:=0; tx uuid; i integer;
BEGIN
 SELECT user_id INTO actor.id FROM payment_orders WHERE id=p_order;
 SELECT * INTO actor FROM profiles WHERE id=actor.id FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.payment_mode IS DISTINCT FROM 'test' OR o.merchant_namespace IS DISTINCT FROM p_merchant
   OR o.payment_method IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_SCOPE'; END IF;
 -- Never let out-of-order paid events overwrite refund/quarantine state.
 IF o.payment_status IN ('refunded','partially_refunded') OR o.status IN ('refunded','partially_refunded') THEN
  RETURN jsonb_build_object('state','review','reason','refund_observed');
 END IF;
 state:=pay_waffo_observe_qualification(o.id,p_merchant,'test',p_checkout,'paid',p_payment,p_amount,p_currency,p_paid_at);
 IF state<>'sold' THEN RETURN jsonb_build_object('state',state); END IF;
 IF o.fulfilled_at IS NOT NULL THEN RETURN jsonb_build_object('state','fulfilled','duplicate',true); END IF;
 IF actor.status IS DISTINCT FROM 'active' OR actor.is_deleted::text IS DISTINCT FROM 'false'
   OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=actor.id) THEN
  UPDATE payment_orders SET method_review_reason='account_closed' WHERE id=o.id;
  RETURN jsonb_build_object('state','review','reason','account_closed');
 END IF;
 IF o.method_transition='upgrade' AND o.method_upgrade_charge_at IS NOT NULL
   AND p_paid_at>=o.method_upgrade_charge_at-interval '48 hours' THEN
  UPDATE payment_orders SET method_review_reason='upgrade_payment_after_cutoff' WHERE id=o.id;
  RETURN jsonb_build_object('state','review','reason','upgrade_payment_after_cutoff');
 END IF;
 IF o.item_type='credit_package' THEN
  IF o.payment_method='card' OR p_subscription IS NOT NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_CONFLICT'; END IF;
  n:=(o.purchase_snapshot->>'credits')::integer+(o.purchase_snapshot->>'bonus_credits')::integer;
  INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_type,source_order_id,idempotency_key,
    balance_before,balance_after,description) VALUES(actor.id,n,'purchase','grant','payment_order',o.id,
    'method-package:'||o.id,actor.credits,actor.credits+n,'Paid credit package') RETURNING id INTO tx;
  UPDATE profiles SET credits=credits+n WHERE id=actor.id;
 ELSE
  IF p_start IS NULL OR p_end IS NULL OR p_end<=p_start THEN RAISE EXCEPTION 'PAY_WAFFO_TERM_INVALID'; END IF;
  IF o.method_transition='founder_renewal' AND ((NOT o.auto_renew AND p_start IS DISTINCT FROM
    (SELECT entitlement_end FROM payment_orders WHERE id=o.source_order_id))
   OR pay_waffo_founder_deadline(o.source_order_id) IS NULL OR p_paid_at>pay_waffo_founder_deadline(o.source_order_id)) THEN RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_EXPIRED'; END IF;
  expected_end:=CASE o.entitlement_term WHEN 'days30' THEN p_start+interval '30 days'
    WHEN 'year' THEN ((p_start AT TIME ZONE 'UTC')+interval '1 year') AT TIME ZONE 'UTC'
    ELSE ((p_start AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' END;
  IF expected_end IS DISTINCT FROM p_end
    OR (NOT o.auto_renew AND o.method_transition IS DISTINCT FROM 'founder_renewal' AND p_start<>p_paid_at)
    OR (o.auto_renew AND (p_paid_at<p_start-interval '5 minutes' OR p_paid_at>=p_end)) THEN
   RAISE EXCEPTION 'PAY_WAFFO_TERM_INVALID';
  END IF;
  IF o.auto_renew AND coalesce(p_subscription,'') !~ '^[A-Za-z0-9_:-]{1,160}$'
    OR NOT o.auto_renew AND p_subscription IS NOT NULL THEN RAISE EXCEPTION 'PAY_WAFFO_SUBSCRIPTION_CONFLICT'; END IF;
  INSERT INTO user_subscriptions(user_id,membership_plan_id,billing_cycle,status,cancel_at_period_end,
    current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
  VALUES(actor.id,o.item_id,o.billing_cycle,'active',CASE WHEN o.auto_renew THEN 'false' ELSE 'true' END,
    p_start,p_end,o.payment_channel,p_merchant,'test',o.purchase_snapshot) RETURNING * INTO sub;
  IF o.auto_renew THEN
   INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
   VALUES(o.payment_channel,p_merchant,'test','subscription',p_subscription,sub.id) ON CONFLICT DO NOTHING;
   SELECT * INTO ref FROM payment_provider_refs WHERE channel=o.payment_channel AND merchant_namespace=p_merchant
     AND mode='test' AND object_type='subscription' AND external_id=p_subscription;
   IF ref.subscription_id IS DISTINCT FROM sub.id THEN RAISE EXCEPTION 'PAY_WAFFO_SUBSCRIPTION_CONFLICT'; END IF;
  END IF;
  UPDATE payment_orders SET subscription_id=sub.id,entitlement_start=p_start,entitlement_end=p_end WHERE id=o.id;
  -- Do not downgrade another still-paid membership; ordinary admission already serializes purchases.
  IF p_start<=clock_timestamp() AND p_end>clock_timestamp() THEN
   UPDATE profiles SET membership_level=CASE WHEN membership_level='gold' OR o.purchase_membership_level='gold'
     THEN 'gold' ELSE o.purchase_membership_level END WHERE id=actor.id;
  END IF;
 END IF;
 UPDATE payment_orders SET status='completed',fulfilled_at=clock_timestamp(),payment_amount_facts=
   coalesce(payment_amount_facts,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('kind','paid','amount',
   (p_amount::numeric/100)::numeric(20,2)::text,'currency',p_currency,'unit','major','evidence_ref',p_payment)) WHERE id=o.id;
 IF o.method_transition='upgrade' THEN
  UPDATE user_subscriptions SET method_cancel_requested_at=coalesce(method_cancel_requested_at,clock_timestamp())
  WHERE id=o.method_prior_subscription AND user_id=actor.id AND cancel_at_period_end='false';
 END IF;
 IF o.item_type='membership_plan' THEN
  FOR i IN 1..CASE o.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END LOOP n:=n+pay_waffo_grant_period(o.id,i); END LOOP;
 END IF;
 RETURN jsonb_build_object('state','fulfilled','orderId',o.id,'subscriptionId',sub.id,'credits',n,'duplicate',false);
END $$;

-- Existing billing cron calls this bounded release path; cancellation does not revoke paid annual grants.
CREATE OR REPLACE FUNCTION public.pay_waffo_release_due(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row record; i integer; n integer:=0;
BEGIN
 IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'PAY_WAFFO_LIMIT_INVALID'; END IF;
 FOR row IN SELECT o.id FROM payment_orders o JOIN user_subscriptions s ON s.id=o.subscription_id
   WHERE o.payment_method IS NOT NULL AND o.payment_mode='test' AND o.billing_cycle='yearly'
   AND o.payment_status='paid' AND o.status='completed' AND o.fulfilled_at IS NOT NULL
   AND s.credit_release_terminated_at IS NULL
   AND EXISTS(SELECT 1 FROM profiles p WHERE p.id=o.user_id AND p.status='active' AND p.is_deleted='false')
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=o.user_id) AND EXISTS(SELECT 1 FROM generate_series(1,12) idx
     WHERE ((o.entitlement_start AT TIME ZONE 'UTC')+make_interval(months=>idx-1)) AT TIME ZONE 'UTC'<=clock_timestamp()
     AND NOT EXISTS(SELECT 1 FROM subscription_credit_grants g WHERE g.source_order_id=o.id AND g.period_index=idx))
   ORDER BY o.entitlement_start,o.id LIMIT p_limit LOOP
  FOR i IN 1..12 LOOP n:=n+pay_waffo_grant_period(row.id,i); END LOOP;
 END LOOP;
 RETURN n;
END $$;

-- Receipt status is not money authority. Only a worker that completed a checked transaction marks applied.
CREATE OR REPLACE FUNCTION public.pay_waffo_resolve_receipt(p_id uuid,p_merchant text,p_state text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_state NOT IN ('applied','review') OR coalesce(p_reason,'') !~ '^[a-z_]{1,64}$' THEN
  RAISE EXCEPTION 'PAY_WAFFO_RECEIPT_RESOLUTION_INVALID'; END IF;
 UPDATE waffo_event_receipts SET status=p_state,resolution=jsonb_build_object('reason',p_reason),resolved_at=clock_timestamp()
 WHERE id=p_id AND merchant_namespace=p_merchant AND mode='test' AND status='received';
 IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM waffo_event_receipts WHERE id=p_id AND merchant_namespace=p_merchant
   AND mode='test' AND status=p_state) THEN RAISE EXCEPTION 'PAY_WAFFO_RECEIPT_SCOPE'; END IF;
END $$;

-- Bound to original receipt/payment; no email matching or user entitlement writes.
CREATE OR REPLACE FUNCTION public.pay_waffo_record_offsite(p_receipt uuid,p_merchant text,p_cash jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r waffo_event_receipts; prior jsonb; stats jsonb; n integer; fees integer; threshold integer:=5;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('waffo-offsite:'||p_merchant,0));
 SELECT * INTO r FROM waffo_event_receipts WHERE id=p_receipt AND merchant_namespace=p_merchant AND mode='test' FOR UPDATE;
 IF r.id IS NULL OR r.event_type<>'subscription.payment_succeeded'
  OR jsonb_typeof(p_cash) IS DISTINCT FROM 'object'
  OR (p_cash-ARRAY['paymentId','subscriptionId','productId','amount','currency','paidAt'])<>'{}'
  OR p_cash->>'paymentId' IS DISTINCT FROM r.resource_refs->>'paymentId'
  OR p_cash->>'subscriptionId' IS DISTINCT FROM coalesce(r.resource_refs->>'subscriptionId',r.resource_refs->>'orderId')
  OR coalesce(p_cash->>'productId','') !~ '^PROD_[A-Za-z0-9]+$'
  OR coalesce(p_cash->>'amount','') !~ '^[1-9][0-9]{0,8}$'
  OR p_cash->>'currency' IS DISTINCT FROM 'usd'
  OR p_cash->>'paidAt' IS NULL OR (p_cash->>'paidAt')::timestamptz>clock_timestamp()+interval '5 minutes' THEN
   RAISE EXCEPTION 'PAY_WAFFO_OFFSITE_INVALID'; END IF;
 -- Any known payment or subscription must use its original recovery, never this offsite path.
 IF EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='waffo' AND merchant_namespace=p_merchant AND mode='test'
  AND ((object_type='payment' AND external_id=p_cash->>'paymentId')
    OR (object_type='subscription' AND external_id=p_cash->>'subscriptionId'))) THEN
   RAISE EXCEPTION 'PAY_WAFFO_OFFSITE_MAPPED'; END IF;
 SELECT resolution->'cash' INTO prior FROM waffo_event_receipts WHERE merchant_namespace=p_merchant AND mode='test'
  AND resolution->>'kind'='offsite' AND resolution->'cash'->>'paymentId'=p_cash->>'paymentId' LIMIT 1;
 IF prior IS NOT NULL AND prior IS DISTINCT FROM p_cash THEN RAISE EXCEPTION 'PAY_WAFFO_OFFSITE_CONFLICT'; END IF;
 IF r.status<>'received' AND (r.resolution->>'kind' IS DISTINCT FROM 'offsite' OR r.resolution->'cash' IS DISTINCT FROM p_cash) THEN
   RAISE EXCEPTION 'PAY_WAFFO_OFFSITE_CONFLICT'; END IF;
 UPDATE waffo_event_receipts SET status='review',resolved_at=clock_timestamp(),resolution=jsonb_build_object(
  'kind','offsite','cash',p_cash,'refundDueAt',(p_cash->>'paidAt')::timestamptz+interval '10 days',
  'refundRequired',true,'cancelRenewalRequired',true,'feeCents',0) WHERE id=r.id AND status='received';
 SELECT count(DISTINCT resolution->'cash'->>'paymentId')::integer INTO n FROM waffo_event_receipts
  WHERE merchant_namespace=p_merchant AND mode='test' AND resolution->>'kind'='offsite'
  AND (resolution->'cash'->>'paidAt')::timestamptz>=clock_timestamp()-interval '24 hours';
 SELECT coalesce(sum(fee),0)::integer INTO fees FROM (SELECT max((resolution->>'feeCents')::integer) fee
  FROM waffo_event_receipts WHERE merchant_namespace=p_merchant AND mode='test' AND resolution->>'kind'='offsite'
  AND (resolution->'cash'->>'paidAt')::timestamptz>=clock_timestamp()-interval '24 hours'
  GROUP BY resolution->'cash'->>'paymentId') x;
 SELECT coalesce((value->>'countThreshold')::integer,5) INTO threshold FROM system_settings WHERE key='waffo_test_abuse_thresholds';
 threshold:=coalesce(threshold,5);
 stats:=jsonb_build_object('payments24h',n,'feeCents24h',fees,'alert',n>=threshold OR fees>=500,'refundRequired',true);
 RETURN stats;
END $$;

-- Existing settings store only the product-specific operational intent/history. Provider status
-- remains authoritative for offsite checkout availability; local block is immediate and conservative.
CREATE OR REPLACE FUNCTION public.pay_waffo_product_control(p_actor uuid,p_ref uuid,p_block boolean,p_expected bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ref payment_provider_refs; current jsonb; result jsonb; version bigint; setting_key text;
BEGIN
 PERFORM pg_advisory_xact_lock(7063,2);
 PERFORM pay_waffo_assert_actor(p_actor);
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin') THEN RAISE EXCEPTION 'PAY_WAFFO_ADMIN_REQUIRED'; END IF;
 SELECT * INTO ref FROM payment_provider_refs WHERE id=p_ref FOR SHARE;
 IF ref.id IS NULL OR ref.channel<>'waffo' OR ref.mode<>'test' OR ref.object_type<>'price'
  OR ref.external_id !~ '^PROD_[A-Za-z0-9]+$' OR p_block IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_CONTROL_INVALID'; END IF;
 IF p_block AND ref.offer_kind='founder' AND NOT EXISTS(SELECT 1 FROM waffo_event_receipts
  WHERE merchant_namespace=ref.merchant_namespace AND mode='test' AND resolution->>'kind'='offsite'
  AND resolution->'cash'->>'productId'=ref.external_id) THEN RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_PRODUCT_PROTECTED'; END IF;
 setting_key:='waffo_test_product_'||ref.id;
 SELECT value INTO current FROM system_settings WHERE system_settings.key=setting_key FOR UPDATE;
 version:=coalesce((current->>'version')::bigint,0);
 IF p_expected IS DISTINCT FROM version THEN RAISE EXCEPTION 'PAY_WAFFO_CONTROL_VERSION'; END IF;
 IF current->>'state' IN ('blocking','restoring') THEN RETURN current; END IF;
 IF p_block AND current->>'state'='blocked' OR NOT p_block AND (current IS NULL OR current->>'state'='active') THEN
  RETURN coalesce(current,jsonb_build_object('state','active','version',0)); END IF;
 result:=jsonb_build_object('version',version+1,'operationId',gen_random_uuid(),'state',CASE WHEN p_block THEN 'blocking' ELSE 'restoring' END,
  'productId',ref.external_id,'merchant',ref.merchant_namespace,'refId',ref.id,'mode','test','actor',p_actor,
  'blockedAt',CASE WHEN p_block THEN to_jsonb(clock_timestamp()) ELSE current->'blockedAt' END,
  'history',coalesce(current->'history','[]'::jsonb));
 INSERT INTO system_settings(key,value) VALUES(setting_key,result) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.pay_waffo_product_control_result(p_ref uuid,p_operation uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current jsonb; result jsonb; setting_key text:='waffo_test_product_'||p_ref;
BEGIN
 PERFORM pg_advisory_xact_lock(7063,2);
 SELECT value INTO current FROM system_settings WHERE system_settings.key=setting_key FOR UPDATE;
 IF current IS NULL OR current->>'operationId' IS DISTINCT FROM p_operation::text
  OR p_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'PAY_WAFFO_CONTROL_CONFLICT'; END IF;
 IF current->>'state'='blocking' AND p_status='inactive' THEN
  result:=current||jsonb_build_object('state','blocked','confirmedAt',clock_timestamp());
 ELSIF current->>'state'='restoring' AND p_status='active' THEN
  result:=current||jsonb_build_object('state','active','confirmedAt',clock_timestamp(),'history',
   (current->'history')||jsonb_build_array(jsonb_build_object('start',current->'blockedAt','end',clock_timestamp())));
 ELSIF current->>'state'=(CASE p_status WHEN 'active' THEN 'active' ELSE 'blocked' END) THEN RETURN current;
 ELSE RAISE EXCEPTION 'PAY_WAFFO_CONTROL_PENDING'; END IF;
 UPDATE system_settings SET value=result WHERE system_settings.key=setting_key;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.pay_waffo_product_block_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.payment_method='card' AND NEW.payment_mode='test' AND NEW.purchase_action='checkout' AND NEW.qualified_paid_at IS NULL THEN
  PERFORM pg_advisory_xact_lock_shared(7063,2);
  IF EXISTS(SELECT 1 FROM system_settings WHERE key='waffo_test_product_'||NEW.price_ref_id
    AND value->>'state' IN ('blocking','blocked','restoring')) THEN RAISE EXCEPTION 'PAY_WAFFO_PRODUCT_PAUSED'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pay_waffo_product_block ON public.payment_orders;
CREATE TRIGGER pay_waffo_product_block BEFORE INSERT ON public.payment_orders
FOR EACH ROW EXECUTE FUNCTION public.pay_waffo_product_block_guard();

CREATE OR REPLACE FUNCTION public.pay_waffo_cancel_intent(p_user uuid,p_subscription uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions; ref payment_provider_refs; dispatch boolean;
BEGIN
 PERFORM pay_waffo_assert_actor(p_user);
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription AND user_id=p_user FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'waffo' OR s.payment_mode IS DISTINCT FROM 'test'
  OR NOT EXISTS(SELECT 1 FROM payment_orders WHERE subscription_id=s.id AND payment_method='card' AND fulfilled_at IS NOT NULL) THEN
  RAISE EXCEPTION 'PAY_WAFFO_CANCEL_DENIED'; END IF;
 SELECT * INTO ref FROM payment_provider_refs WHERE subscription_id=s.id AND channel='waffo' AND mode='test'
  AND merchant_namespace=s.merchant_namespace AND object_type='subscription';
 IF ref.id IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_CANCEL_SCOPE'; END IF;
 dispatch:=s.method_cancel_dispatched_at IS NULL;
 UPDATE user_subscriptions SET method_cancel_requested_at=coalesce(method_cancel_requested_at,clock_timestamp()),
  method_cancel_dispatched_at=coalesce(method_cancel_dispatched_at,clock_timestamp()) WHERE id=s.id RETURNING * INTO s;
 RETURN jsonb_build_object('dispatch',dispatch,'dispatchedAt',s.method_cancel_dispatched_at,'subscriptionId',s.id,'providerId',ref.external_id,'merchant',s.merchant_namespace,'mode','test');
END $$;

-- Only after the server has read the original subscription as cancellable may it reclaim a stale dispatch.
-- The exact observed dispatch timestamp is a CAS token; concurrent recoveries cannot both send.
CREATE OR REPLACE FUNCTION public.pay_waffo_retry_cancel(
 p_user uuid,p_subscription uuid,p_merchant text,p_provider text,p_expected timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions;
BEGIN
 PERFORM pay_waffo_assert_actor(p_user);
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription AND user_id=p_user FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'waffo' OR s.payment_mode IS DISTINCT FROM 'test'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant OR s.method_cancel_requested_at IS NULL
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=s.id AND channel='waffo'
   AND mode='test' AND merchant_namespace=p_merchant AND object_type='subscription' AND external_id=p_provider) THEN
  RAISE EXCEPTION 'PAY_WAFFO_CANCEL_DENIED'; END IF;
 IF s.method_cancel_confirmed_at IS NOT NULL OR p_expected IS NULL
  OR s.method_cancel_dispatched_at IS DISTINCT FROM p_expected
  OR s.method_cancel_dispatched_at>clock_timestamp()-interval '1 minute' THEN RETURN false; END IF;
 UPDATE user_subscriptions SET method_cancel_dispatched_at=clock_timestamp() WHERE id=s.id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.pay_waffo_cancel_result(p_subscription uuid,p_merchant text,p_provider text,p_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions; actor uuid;
BEGIN
 SELECT user_id INTO actor FROM user_subscriptions WHERE id=p_subscription;
 PERFORM 1 FROM profiles WHERE id=actor FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription FOR UPDATE;
 IF s.id IS NULL OR s.payment_mode IS DISTINCT FROM 'test' OR s.payment_channel IS DISTINCT FROM 'waffo'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant OR s.method_cancel_requested_at IS NULL
  OR p_state NOT IN ('canceling','canceled') OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=s.id
    AND channel='waffo' AND merchant_namespace=p_merchant AND mode='test' AND object_type='subscription' AND external_id=p_provider) THEN
   RAISE EXCEPTION 'PAY_WAFFO_CANCEL_CONFLICT'; END IF;
 -- Cancellation removes future charging, never revokes already paid time/annual credit sources.
 UPDATE user_subscriptions SET cancel_at_period_end='true',method_cancel_confirmed_at=coalesce(method_cancel_confirmed_at,clock_timestamp())
 WHERE id=s.id;
END $$;

-- Original paid end remains the renewal anchor. Pauses never grant unpaid membership time.
CREATE OR REPLACE FUNCTION public.pay_waffo_founder_deadline(p_order uuid)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; s user_subscriptions; control jsonb; span jsonb; deadline timestamptz; last_end timestamptz;
 a timestamptz; b timestamptz;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=p_order;
 SELECT * INTO s FROM user_subscriptions WHERE id=o.subscription_id;
 IF o.offer_kind NOT IN ('founder','founder_renewal') OR o.payment_status<>'paid' OR o.fulfilled_at IS NULL
  OR o.entitlement_end IS NULL THEN RETURN NULL; END IF;
 deadline:=o.entitlement_end+interval '7 days';last_end:=o.entitlement_end;
 IF o.payment_method='card' THEN
  IF s.founder_failed_at IS NULL OR s.method_cancel_requested_at IS NOT NULL THEN RETURN NULL; END IF;
  deadline:=s.founder_failed_at+interval '7 days';last_end:=s.founder_failed_at;
  SELECT value INTO control FROM system_settings WHERE key='waffo_test_product_'||o.price_ref_id;
  FOR span IN SELECT value FROM jsonb_array_elements(coalesce(control->'history','[]'::jsonb)||
    CASE WHEN control->>'state' IN ('blocking','blocked','restoring') THEN
      jsonb_build_array(jsonb_build_object('start',control->'blockedAt','end',now())) ELSE '[]'::jsonb END)
    ORDER BY (value->>'start')::timestamptz LOOP
   a:=greatest(last_end,(span->>'start')::timestamptz);b:=least(now(),(span->>'end')::timestamptz);
   IF a>deadline THEN EXIT; END IF;
   IF b>a THEN deadline:=deadline+(b-a);last_end:=b; END IF;
  END LOOP;
 END IF;
 RETURN deadline;
END $$;
CREATE OR REPLACE FUNCTION public.pay_waffo_admit_purchase(
  p_user uuid,p_item_type text,p_item uuid,p_cycle text,p_method text,p_offer text,
  p_merchant text,p_mode text,p_version bigint,p_terms text,p_digests jsonb,p_transition text,p_prior uuid
) RETURNS public.payment_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.profiles; intent public.payment_orders; product jsonb; ref public.payment_provider_refs;
  routes jsonb; selected_channel text; cents integer; credits integer; bonus integer:=0; discount integer:=100;
  snapshot jsonb; term text; ref_count integer:=0; gold jsonb; prior payment_orders; old_sub user_subscriptions;
BEGIN
  IF p_user IS NULL OR p_item IS NULL OR coalesce(p_item_type,'') NOT IN ('membership_plan','credit_package')
    OR coalesce(p_cycle,'') NOT IN ('monthly','yearly','one_time')
    OR (p_item_type='credit_package') IS DISTINCT FROM (p_cycle='one_time')
    OR coalesce(p_method,'') NOT IN ('card','wechat_pay','alipay')
    OR coalesce(p_offer,'') NOT IN ('standard','gold_first30','founder','founder_renewal')
    OR coalesce(p_merchant,'') !~ '^[A-Za-z0-9_-]{1,64}$'
    OR coalesce(p_terms,'') !~ '^[A-Za-z0-9_.:-]{1,80}$' THEN
    RAISE EXCEPTION 'PAY_WAFFO_PURCHASE_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_mode IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'PAY_WAFFO_LIVE_DISABLED' USING ERRCODE='23514';
  END IF;
  -- Same lock used by setting saves, then account lock, then identity locks, then founder pool.
  PERFORM pg_advisory_xact_lock_shared(7063,2);
  SELECT * INTO actor FROM profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR actor.status IS DISTINCT FROM 'active' OR actor.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user) THEN
    RAISE EXCEPTION 'PAY_WAFFO_ACCOUNT_CLOSED' USING ERRCODE='42501';
  END IF;
  IF p_transition IS NOT NULL THEN
    SELECT * INTO old_sub FROM user_subscriptions WHERE id=p_prior AND user_id=p_user FOR UPDATE;
    SELECT * INTO prior FROM payment_orders WHERE subscription_id=old_sub.id AND user_id=p_user
      AND payment_mode='test' AND payment_status='paid' AND status='completed' AND fulfilled_at IS NOT NULL
      ORDER BY entitlement_end DESC LIMIT 1 FOR UPDATE;
    IF prior.id IS NULL OR prior.payment_method IS NULL OR prior.entitlement_start IS NULL OR prior.entitlement_end IS NULL
      OR p_item_type<>'membership_plan' OR p_transition NOT IN ('upgrade','founder_renewal') THEN
      RAISE EXCEPTION 'PAY_WAFFO_TRANSITION_DENIED'; END IF;
    IF p_transition='upgrade' THEN
      IF prior.purchase_membership_level<>'pro' OR prior.entitlement_end<=now() OR p_offer NOT IN ('standard','gold_first30','founder')
        OR NOT EXISTS(SELECT 1 FROM membership_plans WHERE id=p_item AND level='gold')
        OR EXISTS(SELECT 1 FROM payment_orders WHERE user_id=p_user AND subscription_id<>old_sub.id
          AND purchase_membership_level='gold' AND payment_status='paid' AND entitlement_end>now())
        OR (prior.auto_renew AND (old_sub.status<>'active' OR old_sub.cancel_at_period_end<>'false'
          OR old_sub.method_cancel_requested_at IS NOT NULL OR old_sub.method_observed_at IS NULL
          OR old_sub.method_observed_at<now()-interval '5 minutes' OR old_sub.current_period_end<=now()+interval '48 hours 31 minutes')) THEN
        RAISE EXCEPTION 'PAY_WAFFO_UPGRADE_WAIT'; END IF;
    ELSE
      IF p_offer<>'founder_renewal' OR p_cycle<>'yearly' OR p_item<>prior.item_id
        OR EXISTS(SELECT 1 FROM payment_orders WHERE source_order_id=prior.id AND method_transition='founder_renewal'
          AND fulfilled_at IS NOT NULL)
        OR pay_waffo_founder_deadline(prior.id) IS NULL OR now()>pay_waffo_founder_deadline(prior.id)
        OR (prior.auto_renew AND old_sub.status<>'canceled') THEN RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_EXPIRED'; END IF;
    END IF;
  ELSIF p_prior IS NOT NULL OR p_offer='founder_renewal' THEN RAISE EXCEPTION 'PAY_WAFFO_TRANSITION_DENIED'; END IF;
  -- Any unresolved method/provider blocks switching; returning a new identity would risk a second charge.
  SELECT * INTO intent FROM payment_orders WHERE user_id=p_user AND fulfilled_at IS NULL
    AND purchase_closed_at IS NULL AND (purchase_action='checkout' OR payment_channel IS NULL)
    AND status NOT IN ('refunded','partially_refunded')
    AND (payment_channel IS NOT NULL OR status NOT IN ('failed','canceled','cancelled','expired')
      OR payment_status='paid') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF intent.item_id=p_item AND intent.item_type=p_item_type AND intent.billing_cycle=p_cycle
      AND intent.payment_method=p_method AND intent.offer_kind=p_offer
      AND intent.merchant_namespace=p_merchant AND intent.payment_mode=p_mode AND intent.terms_version=p_terms
      AND intent.method_transition IS NOT DISTINCT FROM p_transition AND intent.method_prior_subscription IS NOT DISTINCT FROM p_prior THEN
      RETURN intent;
    END IF;
    RAISE EXCEPTION 'PAY_WAFFO_PURCHASE_PENDING' USING ERRCODE='23514';
  END IF;
  SELECT value INTO routes FROM system_settings WHERE key='payment_method_routes';
  IF routes IS NULL OR (routes->p_method->>'enabled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAY_WAFFO_SALES_DISABLED' USING ERRCODE='23514';
  END IF;
  IF (routes->>'version')::bigint IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTE_VERSION_CONFLICT' USING ERRCODE='PT409';
  END IF;
  IF p_method<>'card' AND p_cycle='yearly' AND
    (routes->p_method->>'annualVerified')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAY_WAFFO_ANNUAL_UNVERIFIED' USING ERRCODE='23514';
  END IF;
  IF p_method='card' AND p_item_type='credit_package' THEN
    RAISE EXCEPTION 'PAY_WAFFO_METHOD_DENIED' USING ERRCODE='23514';
  END IF;
  selected_channel:=CASE p_method WHEN 'card' THEN 'waffo' ELSE 'stripe' END;
  IF p_item_type='membership_plan' THEN
    SELECT to_jsonb(p) INTO product FROM membership_plans p WHERE id=p_item AND is_active='true'
      AND level IN ('pro','gold') FOR SHARE;
    IF product IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PRODUCT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
    -- Existing tables remain the catalog authority; old staging prices are never silently charged.
    cents:=(product->>CASE p_cycle WHEN 'monthly' THEN 'monthly_price' ELSE 'yearly_price' END)::integer;
    credits:=(product->>'monthly_credits')::integer;
    IF cents IS DISTINCT FROM (CASE WHEN product->>'level'='pro' THEN
        CASE p_cycle WHEN 'monthly' THEN 2900 ELSE 27900 END ELSE
        CASE p_cycle WHEN 'monthly' THEN 6900 ELSE 62100 END END)
      OR credits IS DISTINCT FROM (CASE product->>'level' WHEN 'pro' THEN 3480 ELSE 8970 END) THEN
      RAISE EXCEPTION 'PAY_WAFFO_CATALOG_NOT_READY' USING ERRCODE='23514';
    END IF;
    IF p_cycle='yearly' AND (product->>'yearly_credits')::integer IS DISTINCT FROM credits*12 THEN
      RAISE EXCEPTION 'PAY_WAFFO_CATALOG_NOT_READY' USING ERRCODE='23514';
    END IF;
    IF p_offer<>'standard' AND product->>'level'<>'gold'
      OR p_offer='gold_first30' AND p_cycle<>'monthly'
      OR p_offer IN ('founder','founder_renewal') AND p_cycle<>'yearly' THEN
      RAISE EXCEPTION 'PAY_WAFFO_OFFER_INVALID' USING ERRCODE='23514';
    END IF;
    IF p_transition IS NULL AND (actor.membership_level<>'free' OR EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_user
      AND (s.status IN ('active','trialing','past_due','incomplete','unpaid') OR s.current_period_end>now()))) THEN
      -- Upgrade and founder renewal require the controlled PR-2 transition, never a second ordinary checkout.
      RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED' USING ERRCODE='23514';
    END IF;
    term:=CASE p_cycle WHEN 'monthly' THEN 'month' ELSE 'year' END;
    IF product->>'level'='gold' THEN
      PERFORM pay_waffo_lock_identities(p_digests,p_mode);
      gold:=pay_waffo_gold_digests(p_digests);
      PERFORM pay_waffo_lock_identities(gold,p_mode);
      IF EXISTS(SELECT 1 FROM payment_orders o CROSS JOIN LATERAL jsonb_array_elements(o.gold_identity_digests) d
        JOIN jsonb_array_elements(gold) i ON d=i WHERE o.payment_mode=p_mode
        AND o.qualification_state IN ('reserved','review')
        AND (p_offer='gold_first30' OR o.offer_kind='gold_first30')) THEN
        RAISE EXCEPTION 'PAY_WAFFO_GOLD_FIRST_INELIGIBLE' USING ERRCODE='23514';
      END IF;
      IF p_offer='gold_first30' AND (
        EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p_user
          AND (o.payment_mode=p_mode OR o.payment_mode IS NULL AND p_mode='live')
          AND (o.purchase_membership_level='gold' OR o.metadata->>'membershipLevel'='gold'
            OR EXISTS(SELECT 1 FROM membership_plans p WHERE p.id=o.item_id AND p.level='gold'))
          AND (o.payment_status IN ('paid','refunded','partially_refunded') OR o.fulfilled_at IS NOT NULL))
        OR EXISTS(SELECT 1 FROM opening_grant_identity_digests d JOIN jsonb_array_elements(gold) i
          ON d.kind=i->>'kind' AND d.key_version=i->>'key_version' AND d.digest=i->>'digest'
          WHERE d.purpose='gold_purchase_'||p_mode AND d.expires_at>now())
        OR EXISTS(SELECT 1 FROM payment_orders o CROSS JOIN LATERAL jsonb_array_elements(o.gold_identity_digests) d
          JOIN jsonb_array_elements(gold) i ON d=i
          WHERE o.payment_mode=p_mode AND (o.qualification_state IN ('reserved','review')
            OR o.qualification_state='sold' AND now()<date_trunc('year',coalesce(o.qualified_paid_at,o.created_at),'UTC')+interval '2 years'))
      ) THEN RAISE EXCEPTION 'PAY_WAFFO_GOLD_FIRST_INELIGIBLE' USING ERRCODE='23514'; END IF;
    END IF;
    IF p_offer='gold_first30' THEN cents:=4900; term:='days30'; END IF;
    IF p_offer='founder_renewal' THEN cents:=49600; END IF;
    IF p_offer='founder' THEN
      PERFORM pg_advisory_xact_lock(7063,CASE p_mode WHEN 'test' THEN 3 ELSE 4 END);
      IF EXISTS(SELECT 1 FROM payment_orders WHERE user_id=p_user AND payment_mode=p_mode
        AND offer_kind IN ('founder','founder_renewal') AND qualification_state='sold') THEN
        RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_RENEWAL_REQUIRED' USING ERRCODE='23514';
      END IF;
      IF (SELECT count(*) FROM payment_orders WHERE payment_mode=p_mode AND offer_kind='founder'
        AND (qualification_state IN ('reserved','sold')
          OR qualification_state='review' AND qualification_closed_ref IS NULL))>=50 THEN
        RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_SOLD_OUT' USING ERRCODE='23514';
      END IF;
      cents:=49600;
    END IF;
  ELSE
    IF p_offer<>'standard' OR actor.membership_level NOT IN ('pro','gold') THEN
      RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_REQUIRED' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM user_subscriptions sub JOIN membership_plans plan ON plan.id=sub.membership_plan_id
        JOIN payment_orders paid ON paid.subscription_id=sub.id AND paid.user_id=sub.user_id
        WHERE sub.user_id=p_user AND sub.payment_mode=p_mode AND sub.stripe_subscription_id IS NULL
          AND sub.current_period_start<=now() AND sub.current_period_end>now()
          AND sub.status IN ('active','canceled','cancelled') AND plan.level=actor.membership_level
          AND paid.payment_mode=p_mode AND paid.payment_channel=sub.payment_channel
          AND paid.merchant_namespace=sub.merchant_namespace AND paid.payment_status='paid'
          AND paid.status='completed' AND paid.fulfilled_at IS NOT NULL AND paid.qualification_state='sold'
          AND paid.entitlement_start<=now() AND paid.entitlement_end>now()) THEN
      -- Historical internal rows do not hide a valid membership from the original Stripe source.
      IF NOT EXISTS(SELECT 1 FROM user_subscriptions sub JOIN membership_plans plan ON plan.id=sub.membership_plan_id
        WHERE sub.user_id=p_user AND sub.payment_channel='stripe' AND sub.payment_mode=p_mode
          AND sub.stripe_subscription_id IS NOT NULL AND plan.level=actor.membership_level
          AND sub.current_period_start<=now() AND sub.current_period_end>now()
          AND sub.status IN ('active','trialing')) THEN
        RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_REQUIRED' USING ERRCODE='23514';
      END IF;
      PERFORM pay_common_assert_purchase_facts(p_user,p_item_type,actor.membership_level);
    END IF;
    SELECT to_jsonb(p) INTO product FROM credit_packages p WHERE id=p_item AND active='true' FOR SHARE;
    IF product IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PRODUCT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
    discount:=CASE actor.membership_level WHEN 'pro' THEN 95 ELSE 90 END;
    cents:=floor((product->>'price')::numeric*discount/100/10)::integer*10;
    credits:=(product->>'credits_amount')::integer;
    bonus:=coalesce((product->>'bonus_credits')::integer,0);
    IF ((product->>'price')::integer,credits,bonus) NOT IN ((990,990,0),(2990,2990,0),(9990,9990,1000)) THEN
      RAISE EXCEPTION 'PAY_WAFFO_CATALOG_NOT_READY' USING ERRCODE='23514';
    END IF;
  END IF;
  FOR ref IN SELECT * FROM payment_provider_refs r WHERE r.channel=selected_channel AND r.merchant_namespace=p_merchant
    AND r.mode=p_mode AND r.object_type='price' AND r.billing_cycle=p_cycle AND r.offer_kind=(CASE p_offer WHEN 'founder_renewal' THEN 'founder' ELSE p_offer END) AND r.is_current
    AND CASE p_item_type WHEN 'membership_plan' THEN r.membership_plan_id=p_item ELSE r.credit_package_id=p_item AND r.package_tier=actor.membership_level END
    FOR SHARE LOOP ref_count:=ref_count+1; END LOOP;
  IF ref_count<>1 THEN RAISE EXCEPTION 'PAY_WAFFO_PRICE_MAPPING_MISSING' USING ERRCODE='23514'; END IF;
  IF p_item_type='membership_plan' AND p_cycle='yearly' THEN credits:=credits*12; END IF;
  snapshot:=jsonb_build_object('version',1,'item_type',p_item_type,'item_id',p_item,'item_updated_at',
    to_char((product->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'billing_cycle',p_cycle,'currency','usd','unit','major','price',(cents::numeric/100)::numeric(18,2)::text,
    'discount','0.00','tax_behavior','inclusive','credits',credits,'bonus_credits',bonus);
  INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    price_ref_id,purchase_action,purchase_membership_level,payment_method,auto_renew,entitlement_term,routing_version,
    terms_version,terms_accepted_at,offer_kind,qualification_state,gold_identity_digests,method_transition,method_prior_subscription,source_order_id,method_upgrade_charge_at)
  VALUES(p_user,p_item_type,p_item,p_cycle,cents,'usd',CASE p_method WHEN 'card' THEN 'subscription' ELSE 'payment' END,
    'pending','unpaid',selected_channel,p_merchant,p_mode,gen_random_uuid(),
    encode(extensions.digest(concat_ws(':',snapshot::text,p_method,p_offer,p_terms,ref.id::text),'sha256'),'hex'),
    snapshot,ref.id,'checkout',product->>'level',p_method,p_method='card',term,p_version,p_terms,clock_timestamp(),
    p_offer,'reserved',CASE WHEN product->>'level'='gold' THEN gold END,p_transition,p_prior,prior.id,
    CASE WHEN p_transition='upgrade' AND prior.auto_renew THEN old_sub.current_period_end END) RETURNING * INTO intent;
  RETURN intent;
END $$;
CREATE OR REPLACE FUNCTION public.pay_waffo_create_purchase(
 p_user uuid,p_item_type text,p_item uuid,p_cycle text,p_method text,p_offer text,
 p_merchant text,p_mode text,p_version bigint,p_terms text,p_digests jsonb
) RETURNS public.payment_orders LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.pay_waffo_admit_purchase(p_user,p_item_type,p_item,p_cycle,p_method,p_offer,p_merchant,p_mode,p_version,p_terms,p_digests,NULL,NULL);
$$;
CREATE OR REPLACE FUNCTION public.pay_waffo_create_transition(
 p_user uuid,p_item uuid,p_cycle text,p_method text,p_offer text,p_merchant text,p_version bigint,p_terms text,
 p_digests jsonb,p_transition text,p_prior uuid
) RETURNS public.payment_orders LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.pay_waffo_admit_purchase(p_user,'membership_plan',p_item,p_cycle,p_method,p_offer,p_merchant,'test',p_version,
   p_terms,p_digests,p_transition,p_prior);
$$;
-- One immutable payment source per recurring charge. Periods come from verified original-payment
-- evidence, never from the subscription's current period or a locally guessed payment count.
CREATE OR REPLACE FUNCTION public.pay_waffo_renew_subscription(
 p_subscription uuid,p_merchant text,p_payment text,p_amount integer,p_currency text,
 p_paid timestamptz,p_start timestamptz,p_end timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions; original payment_orders; prior payment_orders; o payment_orders; actor uuid;
 snapshot jsonb; cents integer; term text; expected_end timestamptz; anchor_at timestamp; month_index integer;
 i integer; n integer:=0; review boolean;
BEGIN
 SELECT user_id INTO actor FROM user_subscriptions WHERE id=p_subscription;
 PERFORM 1 FROM profiles WHERE id=actor FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'waffo' OR s.payment_mode IS DISTINCT FROM 'test'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant THEN RAISE EXCEPTION 'PAY_WAFFO_RENEW_SCOPE'; END IF;
 SELECT * INTO original FROM payment_orders WHERE subscription_id=s.id AND payment_method='card' AND purchase_action='checkout'
  AND fulfilled_at IS NOT NULL ORDER BY created_at LIMIT 1 FOR UPDATE;
 IF original.id IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_RENEW_SCOPE'; END IF;
 SELECT po.* INTO prior FROM payment_provider_refs r JOIN payment_orders po ON po.id=r.order_id
  WHERE r.channel='waffo' AND r.merchant_namespace=p_merchant AND r.mode='test' AND r.object_type='payment' AND r.external_id=p_payment;
 IF prior.id IS NOT NULL THEN
  IF prior.subscription_id IS DISTINCT FROM s.id OR prior.amount_total IS DISTINCT FROM p_amount
    OR prior.currency IS DISTINCT FROM p_currency OR prior.entitlement_start IS DISTINCT FROM p_start
    OR prior.entitlement_end IS DISTINCT FROM p_end OR prior.qualified_paid_at IS DISTINCT FROM p_paid THEN
   RAISE EXCEPTION 'PAY_WAFFO_RENEW_CONFLICT'; END IF;
  RETURN jsonb_build_object('state',CASE WHEN prior.fulfilled_at IS NOT NULL THEN 'fulfilled' ELSE 'review' END,'duplicate',true,'orderId',prior.id);
 END IF;
 cents:=CASE WHEN original.offer_kind IN ('founder','founder_renewal') THEN 49600
  WHEN original.offer_kind='gold_first30' THEN 6900 ELSE original.amount_total END;
 term:=CASE original.entitlement_term WHEN 'days30' THEN 'month' ELSE original.entitlement_term END;
 anchor_at:=(CASE original.entitlement_term WHEN 'days30' THEN original.entitlement_end ELSE original.entitlement_start END) AT TIME ZONE 'UTC';
 month_index:=(extract(year FROM p_start AT TIME ZONE 'UTC')::integer-extract(year FROM anchor_at)::integer)*12
   +extract(month FROM p_start AT TIME ZONE 'UTC')::integer-extract(month FROM anchor_at)::integer;
 expected_end:=(anchor_at+make_interval(months=>month_index+CASE term WHEN 'year' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC';
 IF p_start IS NULL OR p_end IS DISTINCT FROM expected_end OR p_start<original.entitlement_end
  OR p_start IS DISTINCT FROM (anchor_at+make_interval(months=>month_index)) AT TIME ZONE 'UTC'
  OR term='year' AND month_index%12<>0
  OR p_paid IS NULL OR p_paid<p_start-interval '5 minutes' OR p_paid>=p_end OR p_paid>clock_timestamp()+interval '5 minutes'
  OR p_amount IS DISTINCT FROM cents OR p_currency IS DISTINCT FROM 'usd'
  OR coalesce(p_payment,'') !~ '^[A-Za-z0-9_:-]{1,160}$'
  OR EXISTS(SELECT 1 FROM payment_orders WHERE subscription_id=s.id AND payment_status='paid'
    AND entitlement_start<p_end AND entitlement_end>p_start) THEN RAISE EXCEPTION 'PAY_WAFFO_RENEW_CONFLICT'; END IF;
 snapshot:=original.purchase_snapshot||jsonb_build_object('price',(cents::numeric/100)::numeric(20,2)::text);
 review:=s.method_cancel_requested_at IS NOT NULL OR s.credit_release_terminated_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=actor)
  OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=actor AND status='active' AND is_deleted='false');
 INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
  payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
  price_ref_id,purchase_action,purchase_membership_level,payment_method,auto_renew,entitlement_term,routing_version,
  terms_version,terms_accepted_at,offer_kind,qualification_state,subscription_id,source_order_id,qualified_paid_at,
  entitlement_start,entitlement_end,fulfilled_at,payment_amount_facts,method_review_reason)
 VALUES(actor,'membership_plan',original.item_id,original.billing_cycle,cents,'usd','subscription',
  CASE WHEN review THEN 'pending' ELSE 'completed' END,'paid','waffo',p_merchant,'test',gen_random_uuid(),
  encode(extensions.digest(p_payment,'sha256'),'hex'),snapshot,original.price_ref_id,'checkout',original.purchase_membership_level,
  'card',true,term,original.routing_version,original.terms_version,original.terms_accepted_at,
  CASE WHEN original.offer_kind IN ('founder','founder_renewal') THEN 'founder_renewal' ELSE 'standard' END,
  CASE WHEN review THEN 'review' ELSE 'sold' END,s.id,original.id,p_paid,p_start,p_end,
  CASE WHEN NOT review THEN clock_timestamp() END,jsonb_build_array(jsonb_build_object('kind','paid','amount',
  (cents::numeric/100)::numeric(20,2)::text,'currency','usd','unit','major','evidence_ref',p_payment)),
  CASE WHEN review THEN 'unexpected_renewal' END) RETURNING * INTO o;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('waffo',p_merchant,'test','payment',p_payment,o.id);
 IF review THEN RETURN jsonb_build_object('state','review','orderId',o.id,'refundRequired',true); END IF;
 UPDATE user_subscriptions SET current_period_start=p_start,current_period_end=p_end
  WHERE id=s.id AND current_period_end<p_end;
 FOR i IN 1..CASE original.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END LOOP n:=n+pay_waffo_grant_period(o.id,i); END LOOP;
 IF p_start<=clock_timestamp() AND p_end>clock_timestamp() THEN
  UPDATE profiles SET membership_level=CASE WHEN membership_level='gold' OR original.purchase_membership_level='gold'
    THEN 'gold' ELSE original.purchase_membership_level END WHERE id=actor;
 END IF;
 RETURN jsonb_build_object('state','fulfilled','orderId',o.id,'credits',n,'duplicate',false);
END $$;
-- Only the server's complete original-identity provider scan may call this after its absence grace.
CREATE OR REPLACE FUNCTION public.pay_waffo_close_uncreated(p_user uuid,p_order uuid,p_merchant text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 PERFORM 1 FROM profiles WHERE id=p_user FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order AND user_id=p_user FOR UPDATE;
 IF o.id IS NULL OR o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_mode IS DISTINCT FROM 'test'
  OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.payment_method NOT IN ('wechat_pay','alipay')
  OR o.method_dispatched_at IS NULL OR o.method_checkout_expires_at IS NULL
  OR o.method_checkout_expires_at+interval '1 hour'>now() OR o.payment_status IS DISTINCT FROM 'unpaid'
  OR o.fulfilled_at IS NOT NULL OR o.qualification_state NOT IN ('reserved','released')
  OR EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type IN ('checkout','payment')) THEN
   RAISE EXCEPTION 'PAY_WAFFO_CLOSE_DENIED'; END IF;
 UPDATE payment_orders SET qualification_state='released',qualification_closed_ref='verified_absent:'||o.id,
  purchase_closed_at=coalesce(purchase_closed_at,clock_timestamp()),
  method_review_reason='verified_checkout_absent' WHERE id=o.id;
END $$;
-- The fresh claim owner calls this only before Session-create was invoked, after the final
-- local expiry check. It is NOT an absence assertion for a timed-out provider request.
CREATE OR REPLACE FUNCTION public.pay_waffo_abort_before_dispatch(
 p_user uuid,p_order uuid,p_merchant text,p_expected timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 PERFORM pay_waffo_assert_actor(p_user);
 SELECT * INTO o FROM payment_orders WHERE id=p_order AND user_id=p_user FOR UPDATE;
 IF o.id IS NULL OR o.payment_mode IS DISTINCT FROM 'test' OR o.payment_channel IS DISTINCT FROM 'stripe'
  OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.payment_method NOT IN ('alipay','wechat_pay')
  OR o.method_dispatched_at IS NULL OR p_expected IS NULL OR o.method_checkout_expires_at IS DISTINCT FROM p_expected
  OR o.payment_status IS DISTINCT FROM 'unpaid' OR o.fulfilled_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type IN ('checkout','payment')) THEN
  RAISE EXCEPTION 'PAY_WAFFO_CLOSE_DENIED'; END IF;
 IF o.qualification_state='released' AND o.qualification_closed_ref='never_dispatched:'||o.id THEN RETURN; END IF;
 IF o.qualification_state IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'PAY_WAFFO_CLOSE_DENIED'; END IF;
 UPDATE payment_orders SET qualification_state='released',qualification_closed_ref='never_dispatched:'||o.id,
  purchase_closed_at=clock_timestamp(),method_review_reason='checkout_dispatch_window_exhausted' WHERE id=o.id;
END $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
  'pay_waffo_assert_actor','pay_waffo_claim_checkout','pay_waffo_bind_checkout','pay_waffo_grant_period',
  'pay_waffo_fulfill_payment','pay_waffo_release_due','pay_waffo_resolve_receipt','pay_waffo_record_offsite',
  'pay_waffo_product_control','pay_waffo_product_control_result','pay_waffo_product_block_guard',
  'pay_waffo_close_uncreated','pay_waffo_abort_before_dispatch','pay_waffo_cancel_intent','pay_waffo_cancel_result','pay_waffo_retry_cancel','pay_waffo_renew_subscription','pay_waffo_admit_purchase','pay_waffo_create_transition','pay_waffo_founder_deadline') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  IF f.sig::text NOT LIKE '%pay_waffo_assert_actor(%' AND f.sig::text NOT LIKE '%pay_waffo_product_block_guard(%' AND f.sig::text NOT LIKE '%pay_waffo_admit_purchase(%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);
  END IF;
 END LOOP;
END $$;
COMMIT;
