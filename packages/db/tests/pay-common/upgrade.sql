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
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
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
  DECLARE gold uuid; request jsonb; change_order public.payment_orders; next_order public.payment_orders;
  BEGIN
    RESET ROLE;
    SELECT id INTO gold FROM membership_plans WHERE level='gold';
    IF gold IS NULL THEN
      INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
        VALUES('Gold fixture','gold',false,false,0) RETURNING id INTO gold;
    END IF;
    UPDATE membership_plans SET monthly_price=2999,monthly_credits=300,monthly_bonus_credits=30,is_active='true' WHERE id=gold;
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle,is_current)
      VALUES('stripe','acct_fixture','test','price','price_gold_fixture',gold,'monthly',true);
    SET LOCAL ROLE service_role;
    RESET ROLE;
    UPDATE membership_plans SET yearly_price=19990,yearly_credits=1200 WHERE id=plan;
    UPDATE membership_plans SET yearly_price=29990,yearly_credits=3600 WHERE id=gold;
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle,is_current)
      VALUES('stripe','acct_fixture','test','price','price_pro_year_fixture',plan,'yearly',true),
        ('stripe','acct_fixture','test','price','price_gold_year_fixture',gold,'yearly',true);
    SET LOCAL ROLE service_role;
    DECLARE target record;
    BEGIN
      FOR target IN SELECT * FROM (VALUES(plan,19990,'price_pro_year_fixture'),(gold,29990,'price_gold_year_fixture'))
        AS candidates(plan_id,amount,price_id) LOOP
        request:=jsonb_build_object('quote',jsonb_build_object('amountDue',target.amount,'currency','usd'),
          'originalPrice','price_invoice_fixture','itemId','si_fixture','createdAt',1,
          'stripeMetadata',jsonb_build_object('userId',actor,'itemId',target.plan_id,'priceId',target.price_id,'billingCycle','yearly'));
        change_order:=pay_common_prepare_change(actor,sub,target.plan_id,'yearly',target.price_id,request,'{}');
        PERFORM pg_temp.assert_true(change_order.billing_cycle='yearly' AND change_order.purchase_membership_level=(SELECT level FROM membership_plans WHERE id=target.plan_id),'Pro monthly can upgrade to Pro or Gold annual');
        PERFORM pay_common_finish_change(change_order.id,change_order.metadata,change_order.metadata,'stripe_upgrade_not_applied');
      END LOOP;
    END;
    refused:=false;
    BEGIN PERFORM pay_common_prepare_change(actor,sub,plan,'monthly','price_invoice_fixture','{}','{}');
      EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_UPGRADE_NOT_ALLOWED' THEN refused:=true; ELSE RAISE; END IF;
    END;
    PERFORM pg_temp.assert_true(refused,'same tier and cycle is not an upgrade');
    request:=jsonb_build_object('quote',jsonb_build_object('amountDue',2999,'currency','usd'),
      'originalPrice','price_invoice_fixture','itemId','si_fixture','createdAt',1,
      'stripeMetadata',jsonb_build_object('userId',actor,'itemId',gold,'priceId','price_gold_fixture','billingCycle','monthly'));
    change_order:=pay_common_prepare_change(actor,sub,gold,'monthly','price_gold_fixture',request,'{}');
    PERFORM pg_temp.assert_true(change_order.purchase_action='subscription_change' AND change_order.subscription_id=sub
      AND change_order.stripe_checkout_session_id IS NULL AND change_order.stripe_price_id='price_gold_fixture'
      AND change_order.purchase_change_request=request,'upgrade stores real internal identity and frozen request');
    refused:=false;
    BEGIN PERFORM pay_common_prepare_change(actor,sub,gold,'monthly','price_gold_fixture',request,'{}');
      EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_PURCHASE_PENDING' THEN refused:=true; ELSE RAISE; END IF;
    END;
    PERFORM pg_temp.assert_true(refused,'concurrent upgrade keeps the existing unresolved order');
    PERFORM pg_temp.assert_true(pay_common_finish_change(change_order.id,change_order.metadata,change_order.metadata,
      'stripe_upgrade_rejected'),'verified explicit payment rejection closes original attempt');
    next_order:=pay_common_prepare_change(actor,sub,gold,'monthly','price_gold_fixture',request,'{}');
    PERFORM pg_temp.assert_true(next_order.id<>change_order.id,'verified rejected attempt permits a new identity');
    SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
      p_user_id=>actor,p_membership_plan_id=>gold,p_stripe_subscription_id=>'sub_invoice_fixture',
      p_stripe_invoice_id=>'in_upgrade_fixture',p_source_order_id=>next_order.id,p_amount_total=>2999,
      p_grant_period_key=>'invoice:in_upgrade_fixture',p_period_start=>'2026-11-01T00:00:00Z',
      p_period_end=>'2026-12-01T00:00:00Z',p_credits_granted=>330,p_membership_level=>'gold',
      p_idempotency_key=>'subscription_grant:monthly:in_upgrade_fixture');
    PERFORM pg_temp.assert_true(result.granted AND result.invoice_order_id=next_order.id,'upgrade invoice fulfills its admitted order');
    PERFORM pg_temp.assert_true((SELECT membership_level='gold' AND credits=initial_balance+450 FROM profiles WHERE id=actor),
      'paid upgrade applies full target rights and credits');
    PERFORM pg_temp.assert_true((SELECT contract_snapshot=original.purchase_snapshot AND membership_plan_id=gold
      FROM user_subscriptions WHERE id=sub),'opening contract remains immutable across an upgrade');
    -- Late settlement is newer by arrival time but belongs to the old Pro contract.
    SELECT * INTO result FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',actor),
      p_user_id=>actor,p_membership_plan_id=>plan,p_stripe_subscription_id=>'sub_invoice_fixture',
      p_stripe_invoice_id=>'in_old_pro_late',p_source_order_id=>original.id,p_amount_total=>1999,
      p_grant_period_key=>'invoice:in_old_pro_late',p_period_start=>'2026-09-05T00:00:00Z',
      p_period_end=>'2026-10-05T00:00:00Z',p_credits_granted=>120,p_membership_level=>'pro',
      p_idempotency_key=>'subscription_grant:monthly:in_old_pro_late');
    PERFORM pg_temp.assert_true(result.granted AND (SELECT membership_level='gold' FROM profiles WHERE id=actor),
      'late prior contract settles without replacing current Gold membership');
    refused:=false;
    BEGIN PERFORM pay_common_prepare_change(actor,sub,plan,'yearly','price_pro_year_fixture','{}','{}');
      EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAY_COMMON_UPGRADE_NOT_ALLOWED' THEN refused:=true; ELSE RAISE; END IF;
    END;
    PERFORM pg_temp.assert_true(refused,'Gold to Pro remains denied');
    request:=jsonb_build_object('quote',jsonb_build_object('amountDue',29990,'currency','usd'),
      'originalPrice','price_gold_fixture','itemId','si_fixture','createdAt',1,
      'stripeMetadata',jsonb_build_object('userId',actor,'itemId',gold,'priceId','price_gold_year_fixture','billingCycle','yearly'));
    change_order:=pay_common_prepare_change(actor,sub,gold,'yearly','price_gold_year_fixture',request,'{}');
    PERFORM pg_temp.assert_true(change_order.purchase_membership_level='gold' AND change_order.billing_cycle='yearly',
      'Gold monthly can upgrade to Gold annual');
    PERFORM pg_temp.assert_true(change_order.source_order_id=next_order.id,
      'upgrade source is the current paid Gold term, not the later-arriving old Pro invoice');
  END;
  RESET ROLE;
END $$;
ROLLBACK;
