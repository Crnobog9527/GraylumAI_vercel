-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
CREATE FUNCTION pg_temp.check_channel(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.channel_denied(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM=expected THEN RETURN; END IF;
    RAISE EXCEPTION 'Unexpected error: % expected %',SQLERRM,expected;
  END;
  RAISE EXCEPTION 'EXPECTED_DENIAL';
END $$;
DO $$
DECLARE buyer uuid:=gen_random_uuid(); other_buyer uuid:=gen_random_uuid(); package uuid;
  original public.payment_orders; replay public.payment_orders; before_limits jsonb;
BEGIN
  INSERT INTO profiles(id,membership_level) VALUES(buyer,'free'),(other_buyer,'free');
  INSERT INTO credit_packages(name,price,credits_amount,active)
    VALUES('Fixture',1200,100,'true') RETURNING id INTO package;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price','price_channel',package,'one_time',true);
  SELECT value INTO before_limits FROM system_settings WHERE key='runtime_rate_limits';
  PERFORM pg_temp.channel_denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,
    ''one_time'',''acct_fixture'',''test'',''free'')',buyer,package),'PAY_COMMON_CHANNEL_NOT_READY');
  PERFORM pg_temp.check_channel(NOT EXISTS(SELECT 1 FROM payment_orders WHERE user_id=buyer),'missing default has no order');
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM pg_temp.channel_denied($q$INSERT INTO system_settings(key,value) VALUES
    ('payment_new_purchase_channel','{"channel":"other","version":1}')$q$,'PAY_COMMON_CHANNEL_SETTING_INVALID');
  PERFORM pg_temp.channel_denied($q$INSERT INTO system_settings(key,value) VALUES
    ('payment_new_purchase_channel','{"channel":"stripe","version":2}')$q$,'PAY_COMMON_CHANNEL_VERSION_CONFLICT');
  INSERT INTO system_settings(key,value) VALUES('payment_new_purchase_channel','{"channel":"stripe","version":1}')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  original:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','free');
  PERFORM pg_temp.channel_denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,
    ''one_time'',''acct_fixture'',''live'',''free'')',other_buyer,package),'PAY_COMMON_LIVE_PURCHASE_DISABLED');
  PERFORM pg_temp.channel_denied($q$INSERT INTO system_settings(key,value) VALUES
    ('pr3_atomic_fixture','"not saved"'),('payment_new_purchase_channel','{"channel":"waffo","version":1}')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value$q$,'PAY_COMMON_CHANNEL_VERSION_CONFLICT');
  PERFORM pg_temp.check_channel(NOT EXISTS(SELECT 1 FROM system_settings WHERE key='pr3_atomic_fixture'),'batch rolls back');
  INSERT INTO system_settings(key,value) VALUES('pr3_atomic_fixture','"saved"'),
    ('payment_new_purchase_channel','{"channel":"waffo","version":2}')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  replay:=pay_common_create_purchase(buyer,'credit_package',package,'one_time','acct_fixture','test','free');
  PERFORM pg_temp.check_channel(replay.id=original.id AND replay.payment_channel='stripe','original intent survives switch');
  PERFORM pg_temp.channel_denied(format('SELECT pay_common_create_purchase(%L,''credit_package'',%L,
    ''one_time'',''acct_fixture'',''test'',''free'')',other_buyer,package),'PAY_COMMON_CHANNEL_NOT_READY');
  PERFORM pg_temp.channel_denied($q$UPDATE system_settings SET value='{"channel":"stripe","version":2}'
    WHERE key='payment_new_purchase_channel'$q$,'PAY_COMMON_CHANNEL_VERSION_CONFLICT');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.check_channel((SELECT value FROM system_settings WHERE key='runtime_rate_limits')
    IS NOT DISTINCT FROM before_limits,'rate limits unchanged');
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE system_settings SET value='{"channel":"stripe","version":3}' WHERE key='payment_new_purchase_channel';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.check_channel((SELECT value->>'channel' FROM system_settings WHERE key='payment_new_purchase_channel')='waffo',
    'direct authenticated write denied');
END $$;
ROLLBACK;
