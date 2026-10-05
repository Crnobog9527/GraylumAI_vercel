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
    'amount_total',1999,'currency','usd','payment_status','paid','status','complete','customer','cus_fixture','invoice','in_initial_fixture');
  PERFORM pay_common_record_checkout(original.id,'acct_fixture','test',paid_evidence);
  RESET ROLE;
  UPDATE membership_plans SET monthly_credits=999,monthly_bonus_credits=999 WHERE id=plan;
  SELECT credits INTO initial_balance FROM profiles WHERE id=actor;
  SET LOCAL ROLE service_role;
  SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
    p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
    p_stripe_invoice_id=>'in_initial_fixture',p_source_order_id=>original.id,p_amount_total=>1999,
    p_stripe_customer_id=>'cus_fixture',
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
  DECLARE candidate record;
  BEGIN
    FOR candidate IN SELECT * FROM (VALUES
      ('2026-11-05T00:00:00Z'::timestamptz,'2026-11-06T00:00:00Z'::timestamptz,'cus_fixture'),
      ('2026-11-05T00:00:00Z'::timestamptz,'2026-12-05T01:00:00Z'::timestamptz,'cus_fixture'),
      ('2026-11-05T00:00:00Z'::timestamptz,'2026-12-05T00:00:00Z'::timestamptz,'cus_other'),
      ('2026-11-05T00:00:00Z'::timestamptz,'2026-12-05T00:00:00Z'::timestamptz,NULL))
      AS invalid_receipts(term_start,term_end,customer) LOOP
      refused:=false;
      BEGIN
        PERFORM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
          p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
          p_stripe_invoice_id=>'in_invalid_receipt',p_source_order_id=>original.id,p_amount_total=>1999,
          p_stripe_customer_id=>candidate.customer,p_grant_period_key=>'invoice:in_invalid_receipt',
          p_period_start=>candidate.term_start,p_period_end=>candidate.term_end,p_credits_granted=>120,
          p_membership_level=>'pro',p_idempotency_key=>'subscription_grant:monthly:in_invalid_receipt');
        EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_INVOICE_RECEIPT_MISMATCH' THEN refused:=true; ELSE RAISE; END IF;
      END;
      PERFORM pg_temp.assert_true(refused,'noncanonical period and mismatched or missing known customer denied');
    END LOOP;
    PERFORM pg_temp.assert_true((SELECT credits=initial_balance+120 FROM profiles WHERE id=actor),
      'rejected receipts leave financial balance unchanged');
  END;
  DECLARE evidence jsonb; failed_order uuid; current_status text;
  BEGIN
    evidence:=jsonb_build_object('id','in_initial_fixture','object','invoice','livemode',false,
      'user_id',actor,'subscription_id','sub_invoice_fixture','price_id','price_invoice_fixture',
      'amount_due',1999,'currency','usd','status','open');
    failed_order:=pay_common_record_failed_invoice(original.id,'acct_fixture','test',evidence);
    PERFORM pg_temp.assert_true(failed_order=original.id AND (SELECT status='completed' AND payment_status='paid'
      FROM payment_orders WHERE id=original.id),'late failed event preserves paid terminal order');
    failed_order:=pay_common_record_failed_invoice(original.id,'acct_fixture','test',evidence||'{"id":"in_failure_fixture"}');
    PERFORM pg_temp.assert_true(failed_order<>original.id AND (SELECT status='failed' AND subscription_id=sub
      AND purchase_snapshot=original.purchase_snapshot FROM payment_orders WHERE id=failed_order),
      'new unpaid renewal freezes terms and maps its own invoice');
    PERFORM pg_temp.assert_true(pay_common_record_failed_invoice(original.id,'acct_fixture','test',
      evidence||'{"id":"in_failure_fixture"}')=failed_order,'failed invoice replay has one identity');
    evidence:=jsonb_build_object('id','sub_invoice_fixture','object','subscription','livemode',false,
      'user_id',actor,'customer','cus_fixture','status','active','cancel_at_period_end',true,'period_start','2026-11-05T00:00:00Z');
    PERFORM pg_temp.assert_true(pay_common_sync_subscription('acct_fixture','test',evidence),'authoritative cancellation schedule recorded');
    PERFORM pg_temp.assert_true((SELECT cancel_at_period_end='true' AND current_period_start='2026-10-05T00:00:00Z'
      FROM user_subscriptions WHERE id=sub),'unpaid lifecycle event cannot advance paid term');
    PERFORM pay_common_sync_subscription('acct_fixture','test',evidence||'{"status":"canceled"}');
    PERFORM pg_temp.assert_true((SELECT membership_level='free' FROM profiles WHERE id=actor),
      'cancellation status and membership downgrade commit together');
    SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
      p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
      p_stripe_invoice_id=>'in_paid_after_cancellation',p_source_order_id=>original.id,p_amount_total=>1999,
      p_stripe_customer_id=>'cus_fixture',p_grant_period_key=>'invoice:in_paid_after_cancellation',
      p_period_start=>'2026-11-05T00:00:00Z',p_period_end=>'2026-12-05T00:00:00Z',
      p_credits_granted=>120,p_membership_level=>'pro',p_idempotency_key=>'subscription_grant:monthly:in_paid_after_cancellation');
    PERFORM pg_temp.assert_true(result.granted AND (SELECT membership_level='free' FROM profiles WHERE id=actor)
      AND (SELECT status='canceled' FROM user_subscriptions WHERE id=sub),
      'late paid invoice settles owed credits without resurrecting canceled membership');
    SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
      p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
      p_stripe_invoice_id=>'in_month_anchor_restored',p_source_order_id=>original.id,p_amount_total=>1999,
      p_stripe_customer_id=>'cus_fixture',p_grant_period_key=>'invoice:in_month_anchor_restored',
      p_period_start=>'2027-02-28T00:00:00Z',p_period_end=>'2027-03-31T00:00:00Z',
      p_credits_granted=>120,p_membership_level=>'pro',p_idempotency_key=>'subscription_grant:monthly:in_month_anchor_restored');
    PERFORM pg_temp.assert_true(result.granted,'monthly calendar anchor can recover February 28 to March 31');
    PERFORM pg_temp.assert_true(NOT pay_common_sync_subscription('acct_fixture','test',evidence),
      'terminal cancellation rejects stale active snapshot');
  END;
  RESET ROLE;
  UPDATE membership_plans SET yearly_price=19990,yearly_credits=1200 WHERE id=plan;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_year_lifecycle',plan,'yearly',true);
  SET LOCAL ROLE service_role;
  original:=pay_common_create_purchase(other_actor,'membership_plan',plan,'yearly','acct_fixture','test','free');
  DECLARE term_end timestamptz; cancellation jsonb;
  BEGIN
    cancellation:=jsonb_build_object('id','sub_year_lifecycle','object','subscription','livemode',false,
      'user_id',other_actor,'customer',NULL,'status','canceled','cancel_at_period_end',false,
      'period_start','2027-03-01T00:00:00Z');
    refused:=false;
    BEGIN PERFORM pay_common_sync_subscription('acct_fixture','test',cancellation);
      EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING' THEN refused:=true; ELSE RAISE; END IF;
    END;
    PERFORM pg_temp.assert_true(refused,'cancellation arriving before the initial invoice mapping must retry');
    refused:=false;
    BEGIN
      PERFORM atomic_grant_subscription_invoice_credits(
        p_user_id=>other_actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_year_lifecycle',
        p_stripe_invoice_id=>'in_year_lifecycle',p_source_order_id=>original.id,p_amount_total=>19990);
      EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH' THEN refused:=true; ELSE RAISE; END IF;
    END;
    PERFORM pg_temp.assert_true(refused,'missing fresh subscription status is rejected without defaulting to active');
    refused:=false;
    BEGIN
      PERFORM atomic_grant_subscription_invoice_credits(
        p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
        p_user_id=>other_actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_year_lifecycle',
        p_stripe_invoice_id=>'in_year_lifecycle',p_source_order_id=>original.id,p_amount_total=>19990);
      EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH' THEN refused:=true; ELSE RAISE; END IF;
    END;
    PERFORM pg_temp.assert_true(refused,'fresh subscription owner must match the admitted payment owner');
    FOREACH term_end IN ARRAY ARRAY['2028-02-28T00:00:00Z'::timestamptz,'2028-02-29T01:00:00Z'::timestamptz] LOOP
      refused:=false;
      BEGIN
        PERFORM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',other_actor),
          p_user_id=>other_actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_year_lifecycle',
          p_stripe_invoice_id=>'in_year_lifecycle',p_source_order_id=>original.id,p_amount_total=>19990,
          p_grant_period_key=>'annual:2027-03-01T00:00:00.000Z:01',p_period_start=>'2027-03-01T00:00:00Z',
          p_period_end=>term_end,p_credits_granted=>100,p_membership_level=>'pro',p_billing_cycle=>'yearly',
          p_grant_type=>'annual_monthly_release',p_period_index=>1,p_total_periods=>12,
          p_idempotency_key=>'subscription_grant:annual:year_lifecycle');
        EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_INVOICE_RECEIPT_MISMATCH' THEN refused:=true; ELSE RAISE; END IF;
      END;
      PERFORM pg_temp.assert_true(refused,'annual short duration and changed UTC time rejected');
    END LOOP;
    SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','canceled','stripeSubscriptionUserId',other_actor),
      p_user_id=>other_actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_year_lifecycle',
      p_stripe_invoice_id=>'in_year_lifecycle',p_source_order_id=>original.id,p_amount_total=>19990,
      p_grant_period_key=>'annual:2027-03-01T00:00:00.000Z:01',p_period_start=>'2027-03-01T00:00:00Z',
      p_period_end=>'2028-03-01T00:00:00Z',p_credits_granted=>100,p_membership_level=>'pro',p_billing_cycle=>'yearly',
      p_grant_type=>'annual_monthly_release',p_period_index=>1,p_total_periods=>12,
      p_idempotency_key=>'subscription_grant:annual:year_lifecycle');
    PERFORM pg_temp.assert_true(result.granted,'annual leap-year 366-day term accepted');
    PERFORM pg_temp.assert_true((SELECT membership_level='free' FROM profiles WHERE id=other_actor)
      AND (SELECT status='canceled' FROM user_subscriptions WHERE id=(SELECT subscription_id FROM payment_orders WHERE id=original.id))
      AND (SELECT payment_status='paid' AND fulfilled_at IS NOT NULL FROM payment_orders WHERE id=original.id),
      'first paid invoice after provider cancellation closes finances without granting active membership');
    PERFORM pg_temp.assert_true(pay_common_sync_subscription('acct_fixture','test',cancellation),
      'retried cancellation succeeds after invoice establishes the original subscription mapping');
  END;
  RESET ROLE;
END $$;
ROLLBACK;
