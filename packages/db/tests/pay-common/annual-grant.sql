-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
-- Isolated test setup: explicitly select Stripe; the surrounding rollback restores the prior setting.
INSERT INTO public.system_settings(key,value)
SELECT 'payment_new_purchase_channel',jsonb_build_object('channel','stripe','version',
  coalesce((SELECT (value->>'version')::bigint FROM public.system_settings WHERE key='payment_new_purchase_channel'),0)+1)
ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('channel','stripe',
  'version',(public.system_settings.value->>'version')::bigint+1);
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
  UPDATE membership_plans SET yearly_price=1999,yearly_credits=1205,monthly_bonus_credits=0,is_active='true' WHERE id=plan;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_invoice_fixture',plan,'yearly',true);
  SET LOCAL ROLE service_role;
  original:=pay_common_create_purchase(actor,'membership_plan',plan,'yearly','acct_fixture','test','free');
  PERFORM pg_temp.assert_true(original.purchase_membership_level='pro','membership level frozen by admission');
  refused:=false;
  BEGIN UPDATE payment_orders SET purchase_membership_level='gold' WHERE id=original.id;
    EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  PERFORM pg_temp.assert_true(refused,'direct level mutation denied');
  paid_evidence:=jsonb_build_object('id','cs_invoice_fixture','object','checkout.session','livemode',false,'mode','subscription',
    'client_reference_id',actor,'metadata',jsonb_build_object('orderId',original.id,'userId',actor,'itemId',plan,
      'itemType','membership_plan','billingCycle','yearly','priceId','price_invoice_fixture'),
    'amount_total',1999,'currency','usd','payment_status','paid','status','complete','invoice','in_initial_fixture');
  PERFORM pay_common_record_checkout(original.id,'acct_fixture','test',paid_evidence);
  RESET ROLE;
  UPDATE membership_plans SET yearly_credits=9999,monthly_bonus_credits=999 WHERE id=plan;
  SELECT credits INTO initial_balance FROM profiles WHERE id=actor;
  SET LOCAL ROLE service_role;
  SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,p_amount_total=>1999,
    p_grant_period_key=>'annual:2026-10-05T00:00:00.000Z:01',p_billing_cycle=>'yearly',
    p_grant_type=>'annual_monthly_release',p_period_index=>1,p_total_periods=>12,p_period_start=>'2026-10-05T00:00:00Z',
    p_period_end=>'2027-10-05T00:00:00Z',p_credits_granted=>101,p_membership_level=>'pro',
    p_idempotency_key=>'subscription_grant:monthly:in_initial_fixture');
  PERFORM pg_temp.assert_true(result.granted AND result.credits_granted=101 AND result.invoice_order_id=original.id,
    'first invoice uses frozen credits and original admitted order');
  SELECT subscription_id INTO sub FROM payment_provider_refs WHERE object_type='subscription' AND external_id='sub_invoice_fixture';
  PERFORM pg_temp.assert_true(sub IS NOT NULL,'real internal subscription mapped atomically');
  PERFORM pg_temp.assert_true((SELECT subscription_id=sub AND source_order_id=original.id
    AND grant_snapshot=original.purchase_snapshot FROM subscription_credit_grants WHERE id=result.grant_id),
    'grant snapshots and foreign keys refer to the original invoice');
  PERFORM pg_temp.assert_true((SELECT credits=initial_balance+101 AND membership_level='pro' FROM profiles WHERE id=actor),
    'balance and membership level commit together');
  SELECT * INTO result FROM atomic_grant_annual_subscription_credits(
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,
    p_grant_period_key=>'annual:2026-10-05T00:00:00.000Z:02',p_period_start=>'2026-11-05T00:00:00Z',
    p_period_end=>'2026-12-05T00:00:00Z',p_period_index=>2,p_total_periods=>12,p_credits_granted=>101,
    p_idempotency_key=>'annual-02',p_description=>'Fixture release',p_source_type=>'stripe_invoice',
    p_source_id=>'in_initial_fixture',p_now=>'2026-11-05T00:00:00Z');
  PERFORM pg_temp.assert_true(result.granted AND result.credits_granted=101,'cron uses period-01 frozen annual total');
  PERFORM pg_temp.assert_true((SELECT grant_snapshot=original.purchase_snapshot AND subscription_id=sub
    AND source_order_id=original.id FROM subscription_credit_grants WHERE id=result.grant_id),'cron preserves immutable grant provenance');
  SELECT * INTO result FROM atomic_grant_annual_subscription_credits(
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,
    p_grant_period_key=>'annual:2026-10-05T00:00:00.000Z:02',p_period_start=>'2026-11-05T00:00:00Z',
    p_period_end=>'2026-12-05T00:00:00Z',p_period_index=>2,p_total_periods=>12,p_credits_granted=>101,
    p_idempotency_key=>'annual-02',p_description=>'Fixture release',p_source_type=>'stripe_invoice',
    p_source_id=>'in_initial_fixture',p_now=>'2026-11-05T00:00:00Z');
  PERFORM pg_temp.assert_true(result.is_idempotent AND NOT result.granted,'same annual period settles once');
  refused:=false;
  BEGIN PERFORM atomic_grant_annual_subscription_credits(
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,
    p_grant_period_key=>'annual:2026-10-05T00:00:00.000Z:03',p_period_start=>'2026-12-05T00:00:00Z',
    p_period_end=>'2027-01-05T00:00:00Z',p_period_index=>3,p_total_periods=>12,p_credits_granted=>999,
    p_idempotency_key=>'annual-03',p_description=>'Fixture release',p_source_type=>'stripe_invoice',
    p_source_id=>'in_initial_fixture',p_now=>'2026-12-05T00:00:00Z');
    EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_GRANT_SNAPSHOT_MISMATCH' THEN refused:=true; ELSE RAISE; END IF;
  END;
  PERFORM pg_temp.assert_true(refused,'changed catalog credits cannot poison a later period');
  RESET ROLE;
END $$;
ROLLBACK;
