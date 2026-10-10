-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-WAFFO step 2. Number assigned by control in #791. Test-only; no sales/config seed.
BEGIN;
ALTER TABLE public.payment_orders
 ADD COLUMN IF NOT EXISTS method_dispatched_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_checkout_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_transition text CHECK(method_transition IN ('upgrade','founder_renewal')),
 ADD COLUMN IF NOT EXISTS method_prior_subscription uuid REFERENCES public.user_subscriptions(id),
 ADD COLUMN IF NOT EXISTS method_review_reason text;
ALTER TABLE public.user_subscriptions
 ADD COLUMN IF NOT EXISTS method_cancel_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_cancel_confirmed_at timestamptz,
 ADD COLUMN IF NOT EXISTS method_observed_at timestamptz,
 ADD COLUMN IF NOT EXISTS founder_failed_at timestamptz;
ALTER TABLE public.waffo_event_receipts
 ADD COLUMN IF NOT EXISTS resolution jsonb,
 ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

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
 PERFORM pay_waffo_assert_actor(p_user);
 SELECT * INTO o FROM payment_orders WHERE id=p_order AND user_id=p_user FOR UPDATE;
 IF o.id IS NULL OR o.payment_mode IS DISTINCT FROM 'test' OR o.payment_method IS NULL
   OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.qualification_state IS DISTINCT FROM 'reserved'
   OR o.purchase_closed_at IS NOT NULL THEN RAISE EXCEPTION 'PAY_WAFFO_CHECKOUT_DENIED'; END IF;
 IF o.method_dispatched_at IS NOT NULL THEN
  RETURN jsonb_build_object('dispatch',false,'request',o.checkout_request,'expiresAt',o.method_checkout_expires_at);
 END IF;
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
 IF o.item_type='credit_package' THEN
  IF o.payment_method='card' OR p_subscription IS NOT NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_CONFLICT'; END IF;
  n:=(o.purchase_snapshot->>'credits')::integer+(o.purchase_snapshot->>'bonus_credits')::integer;
  INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_type,source_order_id,idempotency_key,
    balance_before,balance_after,description) VALUES(actor.id,n,'purchase','grant','payment_order',o.id,
    'method-package:'||o.id,actor.credits,actor.credits+n,'Paid credit package') RETURNING id INTO tx;
  UPDATE profiles SET credits=credits+n WHERE id=actor.id;
 ELSE
  IF p_start IS NULL OR p_end IS NULL OR p_end<=p_start THEN RAISE EXCEPTION 'PAY_WAFFO_TERM_INVALID'; END IF;
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
   AND s.credit_release_terminated_at IS NULL AND EXISTS(SELECT 1 FROM generate_series(1,12) idx
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

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
  'pay_waffo_assert_actor','pay_waffo_claim_checkout','pay_waffo_bind_checkout','pay_waffo_grant_period',
  'pay_waffo_fulfill_payment','pay_waffo_release_due','pay_waffo_resolve_receipt') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  IF f.sig::text NOT LIKE '%pay_waffo_assert_actor(%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);
  END IF;
 END LOOP;
END $$;
COMMIT;
