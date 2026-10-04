-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local, synthetic purchase admission fixtures only; no provider operations.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.denied(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=expected THEN RETURN; END IF;
    RAISE EXCEPTION 'Unexpected SQLSTATE %, expected %: %',SQLSTATE,expected,SQLERRM;
  END;
  RAISE EXCEPTION 'EXPECTED_DENIAL: %',statement;
END $$;
DO $$
DECLARE buyer uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); plan uuid; package uuid;
  first_order public.payment_orders; replay public.payment_orders;
BEGIN
  INSERT INTO profiles(id,membership_level) VALUES(buyer,'pro'),(outsider,'free');
  SELECT id INTO plan FROM membership_plans WHERE level='pro';
  IF plan IS NULL THEN
    INSERT INTO membership_plans(name,level,package_discount,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES('Fixture','pro',90,false,false,0) RETURNING id INTO plan;
  ELSE UPDATE membership_plans SET package_discount=90,is_active='true' WHERE id=plan;
  END IF;
  INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active)
    VALUES('Fixture package',1999,100,20,'true') RETURNING id INTO package;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle)
    VALUES('stripe','acct_fixture','test','price','price_fixture',package,'one_time');
  EXECUTE 'SET LOCAL ROLE service_role';
  first_order:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','pro');
  PERFORM pg_temp.assert_true(first_order.id IS NOT NULL,'local order exists before provider dispatch');
  PERFORM pg_temp.assert_true(first_order.stripe_checkout_session_id IS NULL,'no invented external identity');
  PERFORM pg_temp.assert_true(first_order.amount_total=1799,'rounded discount captured in cents');
  PERFORM pg_temp.assert_true(first_order.purchase_snapshot->>'credits'='100','credits frozen');
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','pro');
  PERFORM pg_temp.assert_true(first_order.id=replay.id,'duplicate uses same order');
  PERFORM pg_temp.assert_true(first_order.purchase_request_id=replay.purchase_request_id,'stable durable identity');
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_other'',''test'',''pro'')',buyer,package),'23514');
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_fixture'',''live'',''pro'')',buyer,package),'23514');
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_fixture'',''test'',''free'')',outsider,package),'42501');
  EXECUTE 'RESET ROLE';
  UPDATE credit_packages SET price=2999,credits_amount=500 WHERE id=package;
  UPDATE payment_orders SET status='canceled' WHERE id=first_order.id;
  EXECUTE 'SET LOCAL ROLE service_role';
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','pro');
  PERFORM pg_temp.assert_true(first_order.id=replay.id AND replay.purchase_snapshot=first_order.purchase_snapshot,
    'catalog edits and browser cancellation cannot create another attempt');
  EXECUTE 'RESET ROLE';
  UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=buyer;
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_fixture'',''test'',''pro'')',buyer,package),'42501');
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_fixture'',''test'',''pro'')',buyer,package),'42501');
  EXECUTE 'SET LOCAL ROLE anon';
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_fixture'',''test'',''pro'')',buyer,package),'42501');
  EXECUTE 'RESET ROLE';
END $$;
ROLLBACK;
