-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local, synthetic purchase admission fixtures only; no provider operations.
BEGIN;
-- Isolated test setup: explicitly select Stripe; the surrounding rollback restores the prior setting.
INSERT INTO public.system_settings(key,value)
SELECT 'payment_new_purchase_channel',jsonb_build_object('channel','stripe','version',
  coalesce((SELECT (value->>'version')::bigint FROM public.system_settings WHERE key='payment_new_purchase_channel'),0)+1)
ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('channel','stripe',
  'version',(public.system_settings.value->>'version')::bigint+1);
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
-- Closure and switching are exercised with real roles, locks and protected columns.
DO $$
DECLARE buyer uuid; package uuid; other_package uuid; intent payment_orders; replay payment_orders;
  delay_seconds integer; old_status text;
BEGIN
  INSERT INTO credit_packages(name,price,credits_amount,active) VALUES('Closure',1000,100,'true') RETURNING id INTO package;
  INSERT INTO credit_packages(name,price,credits_amount,active) VALUES('Replacement',2000,200,'true') RETURNING id INTO other_package;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_closure','test','price','price_closure',package,'one_time',true),
      ('stripe','acct_closure','test','price','price_replacement',other_package,'one_time',true);
  -- One second inside grace is denied; one second beyond grace is allowed.
  FOREACH delay_seconds IN ARRAY ARRAY[3599,3601] LOOP
    buyer:=gen_random_uuid(); INSERT INTO profiles(id) VALUES(buyer);
    SET LOCAL ROLE service_role;
    intent:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_closure','test','free');
    PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_closure'',''test'',''never_created'',''unpaid'')',
      buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
    RESET ROLE;
    -- Synthetic already elapsed immutable request; production preparation only accepts future expiry.
    UPDATE payment_orders SET checkout_request=jsonb_build_object('expires_at',floor(extract(epoch FROM now()))-delay_seconds)
      WHERE id=intent.id;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.denied(format('UPDATE payment_orders SET purchase_close_reason=''stripe_checkout_never_created'' WHERE id=%L',intent.id),'42501');
    IF delay_seconds=3599 THEN
      PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_closure'',''test'',''never_created'',''unpaid'')',
        buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
    ELSE
      PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_other'',''test'',''never_created'',''unpaid'')',
        buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
      PERFORM pg_temp.assert_true(pay_common_close_checkout(buyer,intent.id,NULL,'acct_closure','test','never_created','unpaid'),
        'complete absence after grace permits protected closure');
      PERFORM pg_temp.assert_true(NOT pay_common_close_checkout(buyer,intent.id,NULL,'acct_closure','test','never_created','unpaid'),
        'never-created closure is idempotent');
      PERFORM pg_temp.assert_true((SELECT purchase_close_reason='stripe_checkout_never_created' AND purchase_close_ref IS NULL
        FROM payment_orders WHERE id=intent.id),'distinct protected absence reason');
      replay:=pay_common_create_purchase(buyer,'credit_package',other_package,'one_time','acct_closure','test','free');
      PERFORM pg_temp.assert_true(replay.id<>intent.id AND replay.item_id=other_package,'absence closure permits new product');
    END IF;
    RESET ROLE;
  END LOOP;
  buyer:=gen_random_uuid(); INSERT INTO profiles(id) VALUES(buyer);
  SET LOCAL ROLE service_role;
  intent:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_closure','test','free');
  replay:=pay_common_create_purchase(buyer,'credit_package',other_package,'one_time','acct_closure','test','free');
  PERFORM pg_temp.assert_true(replay.id=intent.id AND replay.item_id=package,'switch returns existing intent for retirement, no second order');
  RESET ROLE;
  UPDATE payment_orders SET checkout_request=jsonb_build_object('expires_at',floor(extract(epoch FROM now()))-7200) WHERE id=intent.id;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe','acct_closure','test','checkout','cs_switch',intent.id);
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_closure'',''test'',''never_created'',''unpaid'')',
    buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,''cs_switch'',''acct_closure'',''test'',''open'',''unpaid'')',
    buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,''cs_switch'',''acct_closure'',''test'',''expired'',''paid'')',
    buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  PERFORM pay_common_close_checkout(buyer,intent.id,'cs_switch','acct_closure','test','expired','unpaid');
  replay:=pay_common_create_purchase(buyer,'credit_package',other_package,'one_time','acct_closure','test','free');
  PERFORM pg_temp.assert_true(replay.id<>intent.id AND replay.item_id=other_package,'confirmed unpaid expiry permits requested replacement');
  RESET ROLE;
  -- Historical terminal unpaid attempts no longer block unrelated new purchases; paid/unknown still do.
  FOREACH old_status IN ARRAY ARRAY['expired','canceled','failed','pending','completed'] LOOP
    buyer:=gen_random_uuid(); INSERT INTO profiles(id) VALUES(buyer);
    INSERT INTO payment_orders(user_id,item_type,item_id,amount_total,currency,mode,status,payment_status)
      VALUES(buyer,'credit_package',package,1000,'usd','payment',old_status,CASE WHEN old_status='completed' THEN 'paid' ELSE 'unpaid' END);
    SET LOCAL ROLE service_role;
    IF old_status IN ('pending','completed') THEN
      PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',''acct_closure'',''test'',''free'')',
        buyer,package),'23514','PAY_COMMON_LEGACY_ORDER_UNRESOLVED');
    ELSE
      replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_closure','test','free');
      PERFORM pg_temp.assert_true(replay.payment_channel='stripe','terminal unpaid legacy order does not block');
    END IF;
    RESET ROLE;
  END LOOP;
END $$;
-- An unprepared attempt may be closed; the same lock boundary blocks a racing prepare.
DO $$
DECLARE buyer uuid:=gen_random_uuid(); package uuid; intent payment_orders; replay payment_orders;
BEGIN
  INSERT INTO profiles(id) VALUES(buyer);
  INSERT INTO credit_packages(name,price,credits_amount,active) VALUES('Unprepared',1000,100,'true') RETURNING id INTO package;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_unprepared','test','price','price_unprepared',package,'one_time',true);
  SET LOCAL ROLE service_role;
  intent:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_unprepared','test','free');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET purchase_close_reason=''stripe_checkout_not_prepared'' WHERE id=%L',intent.id),'42501');
  PERFORM pg_temp.assert_true(pay_common_close_checkout(buyer,intent.id,NULL,'acct_unprepared','test','not_prepared','unpaid'),
    'unprepared attempt closes immediately without provider evidence');
  PERFORM pg_temp.assert_true(NOT pay_common_close_checkout(buyer,intent.id,NULL,'acct_unprepared','test','not_prepared','unpaid'),
    'unprepared close replay is idempotent');
  PERFORM pg_temp.assert_true((SELECT purchase_close_reason='stripe_checkout_not_prepared' AND purchase_close_ref IS NULL
    FROM payment_orders WHERE id=intent.id),'protected reason is persisted');
  PERFORM pg_temp.denied(format('SELECT pay_common_prepare_checkout(%L,%L,''{}'')',buyer,intent.id),
    '23514','PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_unprepared','test','free');
  PERFORM pg_temp.assert_true(replay.id<>intent.id,'new attempt follows safe close');
  RESET ROLE;
  UPDATE payment_orders SET checkout_request=jsonb_build_object('expires_at',floor(extract(epoch FROM now()))+3600) WHERE id=replay.id;
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_unprepared'',''test'',''not_prepared'',''unpaid'')',
    buyer,replay.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_unprepared'',''test'',''not_prepared'',''unpaid'')',
    buyer,replay.id),'42501');
  RESET ROLE;
  -- Even an unprepared row with a known provider reference or paid fact cannot be retired this way.
  buyer:=gen_random_uuid(); INSERT INTO profiles(id) VALUES(buyer);
  SET LOCAL ROLE service_role;
  intent:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_unprepared','test','free');
  RESET ROLE;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe','acct_unprepared','test','checkout','cs_known_unprepared',intent.id);
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_unprepared'',''test'',''not_prepared'',''unpaid'')',
    buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  RESET ROLE;
  buyer:=gen_random_uuid(); INSERT INTO profiles(id) VALUES(buyer);
  SET LOCAL ROLE service_role;
  intent:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_unprepared','test','free');
  RESET ROLE;
  UPDATE payment_orders SET payment_status='paid',status='completed' WHERE id=intent.id;
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_unprepared'',''test'',''not_prepared'',''unpaid'')',
    buyer,intent.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  RESET ROLE;
END $$;
-- Requote decisions are computed under the existing admission locks, not trusted metadata.
DO $$
DECLARE buyer uuid:=gen_random_uuid(); package uuid; plan uuid; initial payment_orders; replay payment_orders;
BEGIN
  INSERT INTO profiles(id,membership_level) VALUES(buyer,'free');
  UPDATE membership_plans SET is_active='false' WHERE level='gold';
  INSERT INTO membership_plans(name,level,package_discount,allow_fusion_review,allow_fusion_compare,library_storage_bytes,is_active)
    VALUES('Requote discount','gold',90,false,false,0,'true')
    ON CONFLICT(level) DO UPDATE SET package_discount=90,is_active='true' RETURNING id INTO plan;
  INSERT INTO credit_packages(name,price,credits_amount,active)
    VALUES('Requote package',100,100,'true') RETURNING id INTO package;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_requote','test','price','price_requote',package,'one_time',true);
  SET LOCAL ROLE service_role;
  initial:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_requote','test','free');
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_requote','test','free');
  PERFORM pg_temp.assert_true(replay.id=initial.id AND replay.metadata->'requoteRequired'='false','same quote reuses');
  RESET ROLE;
  UPDATE profiles SET membership_level='gold' WHERE id=buyer;
  SET LOCAL ROLE service_role;
  UPDATE payment_orders SET metadata=metadata||'{"requoteRequired":false}' WHERE id=initial.id;
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_requote','test','gold');
  PERFORM pg_temp.assert_true(replay.id=initial.id AND replay.metadata->'requoteRequired'='true','tier change requires closure');
  PERFORM pg_temp.assert_true(replay.purchase_snapshot=initial.purchase_snapshot,'old monetary snapshot remains frozen');
  PERFORM pg_temp.assert_true(pay_common_close_checkout(buyer,initial.id,NULL,'acct_requote','test','not_prepared','unpaid'),
    'existing protected closure retires unprepared quote');
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_requote','test','gold');
  PERFORM pg_temp.assert_true(replay.id<>initial.id AND replay.amount_total=90,'new quote is discounted');
  initial:=replay;
  RESET ROLE;
  UPDATE membership_plans SET package_discount=89 WHERE id=plan;
  SET LOCAL ROLE service_role;
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_requote','test','gold');
  PERFORM pg_temp.assert_true(replay.metadata->'requoteRequired'='true','discount input change requires closure');
  RESET ROLE;
  UPDATE payment_orders SET payment_status='paid',status='completed' WHERE id=initial.id;
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.denied(format('SELECT pay_common_close_checkout(%L,%L,NULL,''acct_requote'',''test'',''not_prepared'',''unpaid'')',
    buyer,initial.id),'23514','PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  RESET ROLE;
END $$;
-- Deactivation must return the frozen attempt for verified retirement before denying a new quote.
DO $$
DECLARE buyer uuid:=gen_random_uuid(); package uuid; initial payment_orders; replay payment_orders;
BEGIN
  INSERT INTO profiles(id,membership_level) VALUES(buyer,'free');
  INSERT INTO credit_packages(name,price,credits_amount,active)
    VALUES('Retire unavailable',100,100,'true') RETURNING id INTO package;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_inactive','test','price','price_inactive',package,'one_time',true);
  SET LOCAL ROLE service_role;
  initial:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_inactive','test','free');
  RESET ROLE;
  UPDATE credit_packages SET active='false' WHERE id=package;
  SET LOCAL ROLE service_role;
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_inactive','test','free');
  PERFORM pg_temp.assert_true(replay.id=initial.id AND replay.metadata->'requoteRequired'='true',
    'inactive product returns unresolved quote for retirement');
  PERFORM pg_temp.assert_true(pay_common_close_checkout(buyer,initial.id,NULL,'acct_inactive','test','not_prepared','unpaid'),
    'inactive unprepared quote safely closes');
  PERFORM pg_temp.denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,''one_time'',
    ''acct_inactive'',''test'',''free'')',buyer,package),'23514','PAY_COMMON_PRODUCT_UNAVAILABLE');
  PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM payment_orders WHERE user_id=buyer),'no replacement for disabled product');
  RESET ROLE;
END $$;
ROLLBACK;
