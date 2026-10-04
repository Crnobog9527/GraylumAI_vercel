-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local, synthetic purchase admission fixtures only; no provider operations.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.denied(statement text,expected text,expected_message text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=expected AND (expected_message IS NULL OR SQLERRM=expected_message) THEN RETURN; END IF;
    RAISE EXCEPTION 'Unexpected SQLSTATE %, expected %: %',SQLSTATE,expected,SQLERRM;
  END;
  RAISE EXCEPTION 'EXPECTED_DENIAL: %',statement;
END $$;
DO $$
DECLARE buyer uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); plan uuid; package uuid;
  first_order public.payment_orders; replay public.payment_orders; free_order public.payment_orders; other_package uuid;
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
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_fixture',package,'one_time',true);
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
  free_order:=pay_common_create_purchase(outsider,'credit_package',package,'one_time','acct_fixture','test','free');
  PERFORM pg_temp.assert_true(free_order.amount_total=1999,'free buyer remains allowed at full price');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET price_ref_id=NULL WHERE id=%L',first_order.id),'42501');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET purchase_closed_at=now() WHERE id=%L',first_order.id),'42501');
  UPDATE payment_orders SET metadata=metadata||'{"attemptClosed":true}'::jsonb WHERE id=first_order.id;
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','pro');
  PERFORM pg_temp.assert_true(first_order.id=replay.id,'metadata cannot retire an intent');
  EXECUTE 'RESET ROLE';
  UPDATE credit_packages SET price=2999,credits_amount=500 WHERE id=package;
  UPDATE payment_orders SET status='canceled' WHERE id=first_order.id;
  EXECUTE 'SET LOCAL ROLE service_role';
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','pro');
  PERFORM pg_temp.assert_true(first_order.id=replay.id AND replay.purchase_snapshot=first_order.purchase_snapshot,
    'catalog edits and browser cancellation cannot create another attempt');
  EXECUTE 'RESET ROLE';
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe','acct_fixture','test','checkout','cs_expiry_fixture',first_order.id);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,''cs_expiry_fixture'',
    ''acct_fixture'',''test'',''open'',''unpaid'')',buyer,first_order.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,''cs_other'',
    ''acct_fixture'',''test'',''expired'',''unpaid'')',buyer,first_order.id),'23514','PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  PERFORM pg_temp.assert_true(pay_common_close_checkout(buyer,first_order.id,'cs_expiry_fixture',
    'acct_fixture','test','expired','unpaid'),'verified expiry closes intent');
  PERFORM pg_temp.assert_true(NOT pay_common_close_checkout(buyer,first_order.id,'cs_expiry_fixture',
    'acct_fixture','test','expired','unpaid'),'closure replay is idempotent');
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','pro');
  PERFORM pg_temp.assert_true(first_order.id<>replay.id AND first_order.purchase_request_id<>replay.purchase_request_id,
    'authoritative expiry allows a fresh attempt with a distinct identity');
  PERFORM pg_temp.assert_true(replay.amount_total=2699,'new attempt freezes current catalog');
  EXECUTE 'RESET ROLE';
  UPDATE payment_orders SET status='completed',payment_status='paid' WHERE id=first_order.id;
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,''cs_expiry_fixture'',
    ''acct_fixture'',''test'',''expired'',''unpaid'')',buyer,first_order.id),'23514','PAY_COMMON_ATTEMPT_ALREADY_PAID');
  EXECUTE 'RESET ROLE';
  INSERT INTO credit_packages(name,price,credits_amount,active) VALUES('Other',1000,100,'true') RETURNING id INTO other_package;
  -- No mapping: domain error, not the PL/pgSQL STRICT no-row exception.
  INSERT INTO profiles(id) VALUES('44444444-4444-4444-8444-444444444444');
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(''44444444-4444-4444-8444-444444444444'',
    ''credit_package'',%L,''one_time'',''acct_fixture'',''test'',''free'')',other_package),
    '23514','PAY_COMMON_PRICE_MAPPING_MISSING');
  EXECUTE 'RESET ROLE';
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_other_a',other_package,'one_time',true);
  PERFORM pg_temp.denied(format('INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,
    external_id,credit_package_id,billing_cycle,is_current) VALUES(''stripe'',''acct_fixture'',''test'',''price'',
    ''price_other_b'',%L,''one_time'',true)',other_package),'23505');
  -- Simulated damaged uniqueness protection still fails with an explicit business error.
  DROP INDEX public.pay_common_current_package_price;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_other_b',other_package,'one_time',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(''44444444-4444-4444-8444-444444444444'',
    ''credit_package'',%L,''one_time'',''acct_fixture'',''test'',''free'')',other_package),
    '23514','PAY_COMMON_PRICE_MAPPING_AMBIGUOUS');
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
