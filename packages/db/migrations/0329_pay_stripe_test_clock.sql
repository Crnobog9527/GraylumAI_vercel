-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP, Owner approval: PR #1232 comment 6316079313; allocated migration 0329.
-- Only a server-observed, exactly bound staging/test/customer clock changes a source's comparison time.
-- No global clock, first-payment qualification change, table, queue or production setting is introduced.
-- Financial audit/event/retry times remain wall time. Recovery: forward-fix; retain every financial row.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_stripe_test_clock_binding()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT '{"projectId":"prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC","domain":"auth-staging.graylum.com", "databaseHost":"gvcpmcunmfrbxuwimxfa.supabase.co","branch":"staging","repo":"Crnobog9527/GraylumAI_vercel"}'::jsonb;
$$;

-- Internal nullable projection: a different order/user/mode/merchant never inherits a source clock.
CREATE OR REPLACE FUNCTION public.pay_stripe_test_clock_time(p_order uuid)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; root payment_orders; c jsonb;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=p_order;
 SELECT * INTO root FROM payment_orders WHERE id=coalesce(o.source_order_id,o.id);
 c:=root.metadata->'stripeTestClock';
 IF root.id IS NULL OR root.source_order_id IS NOT NULL OR root.purchase_action IS DISTINCT FROM 'checkout'
  OR root.item_type IS DISTINCT FROM 'membership_plan' OR root.payment_channel IS DISTINCT FROM 'stripe'
  OR root.payment_mode IS DISTINCT FROM 'test' OR root.payment_method IS DISTINCT FROM 'card'
  OR root.stripe_managed_payments IS DISTINCT FROM true OR root.purchase_membership_level IS DISTINCT FROM 'pro'
  OR root.billing_cycle IS DISTINCT FROM 'monthly' OR o.user_id IS DISTINCT FROM root.user_id
  OR o.item_type IS DISTINCT FROM root.item_type OR o.item_id IS DISTINCT FROM root.item_id
  OR o.id<>root.id AND (o.subscription_id IS NULL OR o.subscription_id IS DISTINCT FROM root.subscription_id)
  OR o.payment_channel IS DISTINCT FROM root.payment_channel OR o.payment_mode IS DISTINCT FROM root.payment_mode
  OR o.merchant_namespace IS DISTINCT FROM root.merchant_namespace OR o.payment_method IS DISTINCT FROM root.payment_method
  OR o.stripe_managed_payments IS DISTINCT FROM true OR o.purchase_membership_level IS DISTINCT FROM 'pro'
  OR o.billing_cycle IS DISTINCT FROM 'monthly' OR c->'binding' IS DISTINCT FROM pay_stripe_test_clock_binding()
  OR coalesce(c->>'customer','') !~ '^cus_[A-Za-z0-9]{6,128}$'
  OR coalesce(c->>'clock','') !~ '^clock_[A-Za-z0-9]{6,128}$'
  OR root.checkout_request->'providerRequest'->>'customer' IS DISTINCT FROM c->>'customer'
  OR c->>'asOf' IS NULL OR NOT isfinite((c->>'asOf')::timestamptz)
  OR (c->>'asOf')::timestamptz<'2020-01-01'::timestamptz THEN RETURN NULL; END IF;
 RETURN (c->>'asOf')::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.pay_stripe_test_clock_now(p_order uuid)
RETURNS timestamptz LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(pay_stripe_test_clock_time(p_order),clock_timestamp());
$$;

CREATE OR REPLACE FUNCTION public.pay_stripe_test_clock_observe(
 p_order uuid,p_customer text,p_clock text,p_as_of timestamptz,p_binding jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; actor profiles; prior jsonb;
BEGIN
 SELECT * INTO actor FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF actor.id IS NULL OR o.id IS NULL OR o.source_order_id IS NOT NULL OR o.purchase_action IS DISTINCT FROM 'checkout'
  OR o.item_type IS DISTINCT FROM 'membership_plan' OR o.payment_channel IS DISTINCT FROM 'stripe'
  OR o.payment_mode IS DISTINCT FROM 'test' OR o.payment_method IS DISTINCT FROM 'card'
  OR o.stripe_managed_payments IS DISTINCT FROM true OR o.purchase_membership_level IS DISTINCT FROM 'pro'
  OR o.billing_cycle IS DISTINCT FROM 'monthly' OR p_binding IS DISTINCT FROM pay_stripe_test_clock_binding()
  OR coalesce(p_customer,'') !~ '^cus_[A-Za-z0-9]{6,128}$' OR coalesce(p_clock,'') !~ '^clock_[A-Za-z0-9]{6,128}$'
  OR o.checkout_request->'providerRequest'->>'customer' IS DISTINCT FROM p_customer
  OR p_as_of IS NULL OR NOT isfinite(p_as_of) OR p_as_of<'2020-01-01'::timestamptz THEN
  RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_SCOPE'; END IF;
 prior:=o.metadata->'stripeTestClock';
 IF prior IS NOT NULL AND (prior->>'customer' IS DISTINCT FROM p_customer OR prior->>'clock' IS DISTINCT FROM p_clock
  OR prior->'binding' IS DISTINCT FROM p_binding) THEN RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_REBIND'; END IF;
 -- Concurrent observations may arrive reversed; an older read must never rewind the source.
 UPDATE payment_orders SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('stripeTestClock',
  jsonb_build_object('customer',p_customer,'clock',p_clock,'binding',p_binding,
   'asOf',greatest(p_as_of,pay_stripe_test_clock_time(o.id)),'observedAt',clock_timestamp())) WHERE id=o.id;
END $$;

CREATE OR REPLACE FUNCTION public.pay_stripe_test_clock_times(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',id,'now',at_)),'[]'::jsonb)
 FROM (SELECT id,pay_stripe_test_clock_time(id) at_ FROM payment_orders WHERE user_id=p_user) x WHERE at_ IS NOT NULL;
$$;

-- A refunded initial Checkout with no delivery is a cash close, never a paid fulfillment.
-- The API independently re-reads Customer/clock/session/subscription/invoice/PI/charge/all refunds.
CREATE OR REPLACE FUNCTION public.pay_stripe_test_clock_close_refunded(p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; actor profiles; f jsonb; cash jsonb; total_ bigint; count_ integer; ids_ integer;
 payment_key_ text; subscription_key_ text; ref payment_provider_refs;
BEGIN
 payment_key_:=(p_facts->>'merchant')||':test:'||(p_facts->>'paymentIntent');
 subscription_key_:=(p_facts->>'merchant')||':test:'||(p_facts->>'subscription');
 PERFORM pay_dispute_lock(payment_key_,subscription_key_);
 SELECT * INTO actor FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=(p_facts->>'order')::uuid) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=(p_facts->>'order')::uuid FOR UPDATE;
 IF o.id IS NULL OR pay_stripe_test_clock_time(o.id) IS NULL OR o.source_order_id IS NOT NULL
  OR o.merchant_namespace IS DISTINCT FROM p_facts->>'merchant'
  OR o.metadata->'stripeTestClock'->>'customer' IS DISTINCT FROM p_facts->>'customer'
  OR o.metadata->'stripeTestClock'->>'clock' IS DISTINCT FROM p_facts->>'clock'
  OR o.currency IS DISTINCT FROM 'usd' OR p_facts->>'currency' IS DISTINCT FROM o.currency
  OR (p_facts->>'paidMinor')::bigint IS DISTINCT FROM o.amount_total+(p_facts->>'taxMinor')::bigint
  OR (p_facts->>'taxMinor')::bigint<0 OR (p_facts->>'paidMinor')::bigint<=0
  OR jsonb_typeof(p_facts->'paidMinor') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_facts->'taxMinor') IS DISTINCT FROM 'number'
  OR coalesce(p_facts->>'invoice','') !~ '^in_[A-Za-z0-9_]{1,160}$'
  OR coalesce(p_facts->>'paymentIntent','') !~ '^pi_[A-Za-z0-9_]{1,160}$'
  OR coalesce(p_facts->>'charge','') !~ '^ch_[A-Za-z0-9_]{1,160}$'
  OR coalesce(p_facts->>'subscription','') !~ '^sub_[A-Za-z0-9_]{1,160}$'
  OR p_facts->>'paidAt' IS NULL OR NOT isfinite((p_facts->>'paidAt')::timestamptz)
  OR p_facts->>'canceledAt' IS NULL OR NOT isfinite((p_facts->>'canceledAt')::timestamptz)
  OR jsonb_typeof(p_facts->'refunds') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND channel='stripe' AND mode='test'
    AND merchant_namespace=o.merchant_namespace AND object_type='checkout' AND external_id=p_facts->>'checkout') THEN
  RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_SCOPE'; END IF;
 SELECT sum((r->>'amount')::bigint),count(*),count(DISTINCT r->>'id') INTO total_,count_,ids_
  FROM jsonb_array_elements(p_facts->'refunds') r;
 IF count_=0 OR count_<>ids_ OR total_ IS DISTINCT FROM (p_facts->>'paidMinor')::bigint THEN
  RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_REFUND'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(p_facts->'refunds') LOOP
  IF coalesce(f->>'id','') !~ '^re_[A-Za-z0-9_]{1,160}$' OR jsonb_typeof(f->'amount') IS DISTINCT FROM 'number'
   OR (f->>'amount')::bigint<=0 OR f->>'createdAt' IS NULL OR NOT isfinite((f->>'createdAt')::timestamptz)
   OR (f->>'createdAt')::timestamptz>clock_timestamp()+interval '5 minutes' THEN
   RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_REFUND'; END IF;
 END LOOP;
 -- Exact persisted cash-close replays make no mutation, even after suspension/erasure/dispute.
 IF o.metadata->'stripeTestClockClose' IS NOT NULL THEN
  IF o.metadata->'stripeTestClockClose' IS DISTINCT FROM p_facts OR o.status IS DISTINCT FROM 'refunded'
   OR o.payment_status IS DISTINCT FROM 'refunded' OR o.qualification_state IS DISTINCT FROM 'released'
   OR o.fulfilled_at IS NOT NULL OR o.subscription_id IS NOT NULL OR o.purchase_closed_at IS NULL THEN
   RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_CONFLICT'; END IF;
  RETURN jsonb_build_object('state','refunded','orderId',o.id,'duplicate',true,'credits',0);
 END IF;
 IF actor.id IS NULL OR actor.status IS DISTINCT FROM 'active' OR actor.is_deleted::text IS DISTINCT FROM 'false'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=actor.id)
  OR o.fulfilled_at IS NOT NULL OR o.subscription_id IS NOT NULL
  OR o.refund_approval IS NOT NULL OR o.dispute_refund_status IS NOT NULL OR o.method_review_reason IS NOT NULL
  OR EXISTS(SELECT 1 FROM subscription_credit_grants WHERE source_order_id=o.id)
  OR EXISTS(SELECT 1 FROM credit_transactions WHERE source_order_id=o.id)
  OR EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=o.id OR payment_key=payment_key_
    OR merchant_namespace=o.merchant_namespace AND mode='test' AND provider_subscription_id=p_facts->>'subscription') THEN
  RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_PROTECTED'; END IF;
 IF o.status IS DISTINCT FROM 'pending' OR o.payment_status IS DISTINCT FROM 'unpaid'
  OR o.qualification_state IS DISTINCT FROM 'reserved' OR o.purchase_closed_at IS NOT NULL
  OR coalesce(o.payment_amount_facts,'[]'::jsonb)<>'[]'::jsonb
  OR o.dispute_payment_key IS NOT NULL AND o.dispute_payment_key<>payment_key_
  OR o.dispute_subscription_key IS NOT NULL AND o.dispute_subscription_key<>subscription_key_ THEN
  RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_CONFLICT'; END IF;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe',o.merchant_namespace,'test','payment',p_facts->>'invoice',o.id)
 ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO NOTHING;
 SELECT * INTO ref FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=o.merchant_namespace
  AND mode='test' AND object_type='payment' AND external_id=p_facts->>'invoice';
 IF ref.order_id IS DISTINCT FROM o.id THEN RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_CONFLICT'; END IF;
 cash:=jsonb_build_array(jsonb_build_object('kind','paid','amount',(o.amount_total::numeric/100)::numeric(20,2)::text,
  'currency',o.currency,'unit','major','evidence_ref',p_facts->>'invoice'),
  jsonb_build_object('kind','tax','amount',((p_facts->>'taxMinor')::numeric/100)::numeric(20,2)::text,
  'currency',o.currency,'unit','major','evidence_ref',p_facts->>'invoice'));
 FOR f IN SELECT value FROM jsonb_array_elements(p_facts->'refunds') LOOP
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('stripe',o.merchant_namespace,'test','refund',f->>'id',o.id)
   ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO NOTHING;
  SELECT * INTO ref FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=o.merchant_namespace
   AND mode='test' AND object_type='refund' AND external_id=f->>'id';
  IF ref.order_id IS DISTINCT FROM o.id THEN RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_CLOSE_CONFLICT'; END IF;
  cash:=cash||jsonb_build_array(jsonb_build_object('kind','refund','amount',((f->>'amount')::numeric/100)::numeric(20,2)::text,
   'currency',o.currency,'unit','major','evidence_ref',f->>'id'));
 END LOOP;
 UPDATE payment_orders SET status='refunded',payment_status='refunded',qualification_state='released',
  qualification_closed_ref=p_facts->>'checkout',purchase_closed_at=clock_timestamp(),payment_amount_facts=cash,
  dispute_payment_key=payment_key_,dispute_subscription_key=subscription_key_,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('stripeTestClockClose',p_facts,
   'stripeExternalRefund',jsonb_build_object('state','refunded','chargedMinor',total_,'refundedMinor',total_,
    'creditsTakenBack',0,'neverFulfilled',true)) WHERE id=o.id;
 RETURN jsonb_build_object('state','refunded','orderId',o.id,'duplicate',false,'credits',0);
END $$;

-- All new entry points are trusted-server-only. The API supplies no client-selected comparison time.
DO $$ DECLARE signature text; BEGIN
 FOREACH signature IN ARRAY ARRAY['pay_stripe_test_clock_binding()','pay_stripe_test_clock_time(uuid)',
  'pay_stripe_test_clock_now(uuid)','pay_stripe_test_clock_observe(uuid,text,text,timestamp with time zone,jsonb)',
  'pay_stripe_test_clock_times(uuid)','pay_stripe_test_clock_close_refunded(jsonb)'] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC,anon,authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO service_role';
 END LOOP;
END $$;

-- Patch only the approved source-time comparisons in the latest (including dispute/live) bodies.
-- First-payment qualification, real event/refund timestamps, leases and audit clocks stay untouched.
DO $patch$
DECLARE source text; row_ record;
BEGIN
 FOR row_ IN SELECT * FROM (VALUES
  ('pay_stripe_mp_renew_subscription(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
   'p_paid>clock_timestamp()+interval ''5 minutes''','p_paid>pay_stripe_test_clock_now(original.id)+interval ''5 minutes'''),
  ('pay_stripe_mp_renew_subscription(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
   'p_start<=clock_timestamp() AND p_end>clock_timestamp()','p_start<=pay_stripe_test_clock_now(original.id) AND p_end>pay_stripe_test_clock_now(original.id)'),
  ('pay_waffo_grant_period(uuid,integer)','start_at>clock_timestamp()','start_at>pay_stripe_test_clock_now(o.id)'),
  ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone)',
   'p_start<=clock_timestamp() AND p_end>clock_timestamp()','p_start<=pay_stripe_test_clock_now(o.id) AND p_end>pay_stripe_test_clock_now(o.id)'),
  ('pay_common_membership_facts(uuid)','o.entitlement_end<=now()','o.entitlement_end<=coalesce(pay_stripe_test_clock_time(o.id),now())'),
  ('pay_common_membership_facts(uuid)','o.entitlement_start<=now()','o.entitlement_start<=coalesce(pay_stripe_test_clock_time(o.id),now())'),
  ('pay_common_membership_facts(uuid)','o.entitlement_end>now()-interval ''24 hours''','o.entitlement_end>coalesce(pay_stripe_test_clock_time(o.id),now())-interval ''24 hours'''),
  ('pay_common_membership_facts(uuid)','o.entitlement_end>now()','o.entitlement_end>coalesce(pay_stripe_test_clock_time(o.id),now())'),
  ('pay_common_settle_membership_levels(integer)','o.entitlement_start<=now()','o.entitlement_start<=coalesce(pay_stripe_test_clock_time(o.id),now())'),
  ('pay_common_settle_membership_levels(integer)','o.entitlement_end>now()-interval ''24 hours''','o.entitlement_end>coalesce(pay_stripe_test_clock_time(o.id),now())-interval ''24 hours'''),
  ('pay_waffo_release_due(integer)',') AT TIME ZONE ''UTC''<=clock_timestamp()',') AT TIME ZONE ''UTC''<=pay_stripe_test_clock_now(o.id)'),
  ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
   's.current_period_end>now()', 's.current_period_end>coalesce((SELECT pay_stripe_test_clock_time(src.id) FROM payment_orders src WHERE src.subscription_id=s.id AND src.source_order_id IS NULL AND src.purchase_action=''checkout'' ORDER BY src.created_at LIMIT 1),now())'),
  ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
   's.current_period_end<=now()', 's.current_period_end<=coalesce((SELECT pay_stripe_test_clock_time(src.id) FROM payment_orders src WHERE src.subscription_id=s.id AND src.source_order_id IS NULL AND src.purchase_action=''checkout'' ORDER BY src.created_at LIMIT 1),now())')
 ) AS patches(signature,old_,new_) LOOP
  source:=pg_get_functiondef(('public.'||row_.signature)::regprocedure);
  IF position(row_.old_ IN source)>0 THEN
   IF array_length(string_to_array(source,row_.old_),1)<>2 THEN
    RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_PATCH_MISMATCH: % / %',row_.signature,row_.old_; END IF;
   EXECUTE replace(source,row_.old_,row_.new_);
  ELSIF position(row_.new_ IN source)=0 THEN
   RAISE EXCEPTION 'PAY_STRIPE_TEST_CLOCK_PATCH_MISMATCH: % / %',row_.signature,row_.old_;
  END IF;
 END LOOP;
END $patch$;
COMMIT;
