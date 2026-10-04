-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
DO $$
DECLARE actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); plan uuid; original public.payment_orders;
  result record; sub uuid; initial_balance integer; refused boolean; paid_evidence jsonb;
BEGIN
  INSERT INTO profiles(id,membership_level) VALUES(actor,'free'),(other_actor,'free');
  SELECT id INTO plan FROM membership_plans WHERE level='pro';
  IF plan IS NULL THEN
    INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES('Fixture','pro',false,false,0) RETURNING id INTO plan;
  END IF;
  UPDATE membership_plans SET monthly_price=1999,monthly_credits=100,monthly_bonus_credits=20,is_active='true' WHERE id=plan;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_invoice_fixture',plan,'monthly',true);
  SET LOCAL ROLE service_role;
  original:=pay_common_create_purchase(actor,'membership_plan',plan,'monthly','acct_fixture','test','free');
  PERFORM pg_temp.assert_true(original.purchase_membership_level='pro','membership level frozen by admission');
  refused:=false;
  BEGIN UPDATE payment_orders SET purchase_membership_level='gold' WHERE id=original.id;
    EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  PERFORM pg_temp.assert_true(refused,'direct level mutation denied');
  paid_evidence:=jsonb_build_object('id','cs_invoice_fixture','object','checkout.session','livemode',false,'mode','subscription',
    'client_reference_id',actor,'metadata',jsonb_build_object('orderId',original.id,'userId',actor,'itemId',plan,
      'itemType','membership_plan','billingCycle','monthly','priceId','price_invoice_fixture'),
    'amount_total',1999,'currency','usd','payment_status','paid','status','complete','invoice','in_initial_fixture');
  PERFORM pay_common_record_checkout(original.id,'acct_fixture','test',paid_evidence);
  RESET ROLE;
  UPDATE membership_plans SET monthly_credits=999,monthly_bonus_credits=999 WHERE id=plan;
  SELECT credits INTO initial_balance FROM profiles WHERE id=actor;
  SET LOCAL ROLE service_role;
  SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,p_amount_total=>1999,
    p_grant_period_key=>'invoice:in_initial_fixture',p_period_start=>'2026-10-05T00:00:00Z',
    p_period_end=>'2026-11-05T00:00:00Z',p_credits_granted=>120,p_membership_level=>'pro',
    p_idempotency_key=>'subscription_grant:monthly:in_initial_fixture');
  PERFORM pg_temp.assert_true(result.granted AND result.credits_granted=120 AND result.invoice_order_id=original.id,
    'first invoice uses frozen credits and original admitted order');
  SELECT subscription_id INTO sub FROM payment_provider_refs WHERE object_type='subscription' AND external_id='sub_invoice_fixture';
  PERFORM pg_temp.assert_true(sub IS NOT NULL,'real internal subscription mapped atomically');
  PERFORM pg_temp.assert_true((SELECT subscription_id=sub AND source_order_id=original.id
    AND grant_snapshot=original.purchase_snapshot FROM subscription_credit_grants WHERE id=result.grant_id),
    'grant snapshots and foreign keys refer to the original invoice');
  PERFORM pg_temp.assert_true((SELECT credits=initial_balance+120 AND membership_level='pro' FROM profiles WHERE id=actor),
    'balance and membership level commit together');
  SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,p_amount_total=>1999,
    p_grant_period_key=>'invoice:in_initial_fixture',p_period_start=>'2026-10-05T00:00:00Z',
    p_period_end=>'2026-11-05T00:00:00Z',p_credits_granted=>120,p_membership_level=>'pro',
    p_idempotency_key=>'subscription_grant:monthly:in_initial_fixture');
  PERFORM pg_temp.assert_true(result.is_idempotent AND NOT result.granted,'invoice replay grants once');
  refused:=false;
  BEGIN PERFORM atomic_grant_subscription_invoice_credits(
    p_user_id=>other_actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_other_fixture',p_source_order_id=>original.id,p_amount_total=>1999,
    p_grant_period_key=>'invoice:in_other_fixture',p_period_start=>'2026-11-05T00:00:00Z',
    p_period_end=>'2026-12-05T00:00:00Z',p_credits_granted=>120,p_membership_level=>'pro',
    p_idempotency_key=>'subscription_grant:monthly:in_other_fixture');
    EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_INVOICE_SOURCE_MISMATCH' THEN refused:=true; ELSE RAISE; END IF;
  END;
  PERFORM pg_temp.assert_true(refused,'cross-owner invoice denied before credit mutation');
  RESET ROLE;
  UPDATE profiles SET is_deleted='true',membership_level='free' WHERE id=actor;
  SET LOCAL ROLE service_role;
  SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_renewal_fixture',p_source_order_id=>original.id,p_amount_total=>1999,
    p_grant_period_key=>'invoice:in_renewal_fixture',p_period_start=>'2026-11-05T00:00:00Z',
    p_period_end=>'2026-12-05T00:00:00Z',p_credits_granted=>120,p_membership_level=>'pro',
    p_idempotency_key=>'subscription_grant:monthly:in_renewal_fixture');
  PERFORM pg_temp.assert_true(result.granted AND result.invoice_order_id<>original.id,'renewal gets its own real invoice order');
  PERFORM pg_temp.assert_true((SELECT source_order_id=original.id AND subscription_id=sub
    AND purchase_snapshot=original.purchase_snapshot AND stripe_invoice_id='in_renewal_fixture'
    FROM payment_orders WHERE id=result.invoice_order_id),'renewal derives compatibility and original terms');
  PERFORM pg_temp.assert_true((SELECT is_deleted='true' AND membership_level='free' AND credits=initial_balance+240
    FROM profiles WHERE id=actor),'late financial settlement never reopens membership');
  RESET ROLE;
END $$;
ROLLBACK;
