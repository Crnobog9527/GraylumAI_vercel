-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local fixtures only; no payment network or environment configuration.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.denied(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=expected THEN RETURN; END IF;
    RAISE EXCEPTION 'Unexpected SQLSTATE %, wanted %, statement %',SQLSTATE,expected,statement;
  END;
  RAISE EXCEPTION 'EXPECTED_DENIAL: %',statement;
END $$;
DO $$
DECLARE a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); plan uuid;
  subscription uuid:=gen_random_uuid(); ord uuid:=gen_random_uuid(); grantid uuid:=gen_random_uuid();
  legacy uuid:=gen_random_uuid(); upgrade_subscription uuid:=gen_random_uuid(); upgraded_plan uuid;
  original_contract jsonb; quote jsonb; facts jsonb; captured jsonb; n integer;
BEGIN
  INSERT INTO profiles(id) VALUES(a),(b);
  INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES('Local fixture','test_pay_common',false,false,0) RETURNING id INTO plan;
  INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES('Upgrade fixture','test_pay_common_upgrade',false,false,0) RETURNING id INTO upgraded_plan;
  quote:=jsonb_build_object('version',1,'item_type','membership_plan','item_id',plan,
    'item_updated_at','2026-10-03T00:00:00.000Z','billing_cycle','yearly','currency','usd','unit','major','price','99.123456789012',
    'discount','0','tax_behavior','exclusive','credits',1200,'bonus_credits',0);
  facts:='[{"kind":"fee","amount":null,"currency":"usd","unit":"major","evidence_ref":"test_fee_unknown"}]';
  EXECUTE 'SET LOCAL ROLE service_role';
  INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,billing_cycle,status,cancel_at_period_end,
    current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
  VALUES(subscription,a,plan,'test_subscription','yearly','active','true',now(),now()+interval '1 year',
    'stripe','test_merchant','test',quote);
  -- An original opening contract stays immutable while the same subscription changes its current terms.
  original_contract:=quote||'{"billing_cycle":"monthly"}'::jsonb;
  INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,billing_cycle,status,cancel_at_period_end,
    current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
  VALUES(upgrade_subscription,a,plan,'test_upgrade_subscription','monthly','active','true',now(),now()+interval '1 month',
    'stripe','test_merchant','test',original_contract);
  UPDATE user_subscriptions SET membership_plan_id=upgraded_plan WHERE id=upgrade_subscription;
  SELECT count(*) INTO n FROM user_subscriptions WHERE id=upgrade_subscription AND membership_plan_id=upgraded_plan;
  PERFORM pg_temp.assert_true(n=1,'existing contract permits plan upgrade');
  UPDATE user_subscriptions SET billing_cycle='yearly' WHERE id=upgrade_subscription;
  SELECT count(*) INTO n FROM user_subscriptions WHERE id=upgrade_subscription AND billing_cycle='yearly';
  PERFORM pg_temp.assert_true(n=1,'existing contract permits monthly to yearly change');
  PERFORM pg_temp.denied(format('UPDATE user_subscriptions SET contract_snapshot=contract_snapshot||''{"billing_cycle":"yearly"}''
    WHERE id=%L',upgrade_subscription),'23514');
  PERFORM pg_temp.denied(format('UPDATE user_subscriptions SET contract_snapshot=contract_snapshot||jsonb_build_object(''item_id'',%L::text)
    WHERE id=%L',upgraded_plan,upgrade_subscription),'23514');
  SELECT contract_snapshot INTO captured FROM user_subscriptions WHERE id=upgrade_subscription;
  PERFORM pg_temp.assert_true(captured=original_contract,'upgrade preserves original opening contract');
  INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status)
  VALUES(legacy,a,'membership_plan',plan,'yearly','subscription','pending');
  UPDATE payment_orders SET status='completed' WHERE id=legacy;
  INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_channel,merchant_namespace,
    payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,subscription_id,payment_amount_facts)
  VALUES(ord,a,'membership_plan',plan,'yearly','subscription','completed','stripe','test_merchant','test',
    gen_random_uuid(),repeat('a',64),quote,subscription,facts);
  PERFORM pg_temp.denied(format('INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,mode,
    payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot)
    SELECT user_id,item_type,item_id,billing_cycle,mode,payment_channel,merchant_namespace,payment_mode,
    purchase_request_id,repeat(''b'',64),purchase_snapshot FROM payment_orders WHERE id=%L',ord),'23505');
  INSERT INTO subscription_credit_grants(user_id,membership_plan_id,stripe_subscription_id,billing_cycle,grant_type,
    grant_period_key,period_start,period_end,credits_granted,idempotency_key,subscription_id,source_order_id,grant_snapshot)
  VALUES(a,plan,'test_subscription','yearly','annual_monthly_release','test_period',now(),now()+interval '1 month',
    100,'test_grant_key',subscription,ord,quote) RETURNING id INTO grantid;
  PERFORM pg_temp.denied(format('UPDATE subscription_credit_grants SET source_order_id=NULL WHERE id=%L',grantid),'23514');
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
  VALUES('stripe','test_merchant','test','invoice','test_invoice',ord);
  -- Provider identity uniqueness deliberately excludes mode; a live/test mismatch is not another identity.
  PERFORM pg_temp.denied(format('INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES(''stripe'',''test_merchant'',''test'',''invoice'',''test_invoice'',%L)',ord),'23505');
  PERFORM pg_temp.denied(format('INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES(''stripe'',''test_merchant'',''live'',''invoice'',''test_live_mismatch'',%L)',ord),'23514');
  PERFORM pg_temp.denied(format('INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES(''waffo'',''test_merchant'',''test'',''invoice'',''test_wrong_channel'',%L)',ord),'23514');
  PERFORM pg_temp.denied(format('INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES(''stripe'',''test_merchant'',''test'',''price'',''test_wrong_target'',%L)',ord),'23514');
  PERFORM pg_temp.denied('INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle)
    VALUES(''stripe'',''test_merchant'',''test'',''price'',''test_missing_product'',''11111111-1111-4111-8111-111111111111'',''monthly'')','23503');
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle)
  VALUES('stripe','test_merchant','test','price','test_price',plan,'yearly');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET purchase_snapshot=purchase_snapshot||''{"credits":1}'' WHERE id=%L',ord),'23514');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET user_id=%L WHERE id=%L',b,ord),'23514');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET subscription_id=%L WHERE id=%L',gen_random_uuid(),legacy),'23503');
  PERFORM pg_temp.denied(format('INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,mode,subscription_id)
    VALUES(%L,''membership_plan'',%L,''yearly'',''subscription'',%L)',b,plan,subscription),'23503');
  PERFORM pg_temp.denied(format('INSERT INTO payment_orders(item_type,item_id,billing_cycle,mode,subscription_id)
    VALUES(''membership_plan'',%L,''yearly'',''subscription'',%L)',plan,subscription),'23514');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET payment_amount_facts=''[]'' WHERE id=%L',ord),'23514');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET payment_channel=''stripe'' WHERE id=%L',legacy),'23514');
  PERFORM pg_temp.assert_true(NOT pay_common_snapshot_valid(quote||'{"raw_event":{}}'),'reject raw snapshot data');
  PERFORM pg_temp.assert_true(NOT pay_common_snapshot_valid(quote||'{"price":12.3}'),'reject numeric coercion');
  PERFORM pg_temp.assert_true(NOT pay_common_snapshot_valid(quote||'{"price":"1e3"}'),'reject scientific notation');
  PERFORM pg_temp.assert_true(NOT pay_common_snapshot_valid(quote||'{"credits":null}'),'reject null required field');
  PERFORM pg_temp.assert_true(NOT pay_common_amount_facts_valid('[{"kind":"fee","amount":0,"currency":"usd","unit":"major","evidence_ref":"test"}]'),
    'reject lossy amount numbers');
  PERFORM pg_temp.denied(format('UPDATE payment_provider_refs SET external_id=''changed'' WHERE order_id=%L',ord),'42501');
  EXECUTE 'RESET ROLE';
  -- Direct row visibility is unchanged for existing columns; new private financial details are not exposed.
  PERFORM set_config('request.jwt.claim.sub',a::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(id) INTO n FROM payment_orders WHERE id=ord;
  PERFORM pg_temp.assert_true(n=1,'own legacy projection allowed');
  PERFORM pg_temp.denied('SELECT purchase_snapshot FROM payment_orders','42501');
  PERFORM pg_temp.denied('SELECT merchant_namespace FROM user_subscriptions','42501');
  PERFORM pg_temp.denied('SELECT grant_snapshot FROM subscription_credit_grants','42501');
  PERFORM pg_temp.denied('SELECT * FROM payment_provider_refs','42501');
  PERFORM pg_temp.denied(format('UPDATE payment_orders SET status=''failed'' WHERE id=%L',ord),'42501');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',b::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(id) INTO n FROM payment_orders WHERE id=ord;
  PERFORM pg_temp.assert_true(n=0,'other subject denied by RLS');
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE anon';
  PERFORM pg_temp.denied('SELECT id FROM payment_orders','42501');
  PERFORM pg_temp.denied('SELECT * FROM payment_provider_refs','42501');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.denied(format('DELETE FROM profiles WHERE id=%L',a),'23503');
  PERFORM pg_temp.denied(format('DELETE FROM payment_orders WHERE id=%L',ord),'23503');
  PERFORM pg_temp.denied(format('DELETE FROM user_subscriptions WHERE id=%L',subscription),'23503');
  -- Existing erasure confirmation closes the subject, preserves financial objects and does not dispatch anything.
  PERFORM public.account_erasure_confirm(a,gen_random_uuid());
  PERFORM set_config('request.jwt.claim.sub',a::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(id) INTO n FROM payment_orders WHERE id=ord;
  PERFORM pg_temp.assert_true(n=0,'erased subject cannot read old projection');
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE service_role';
  UPDATE payment_orders SET payment_amount_facts=payment_amount_facts||
    '[{"kind":"paid","amount":"99.123456789012","currency":"usd","unit":"major","evidence_ref":"test_late_paid"}]'
    WHERE id=ord;
  SELECT purchase_snapshot INTO captured FROM payment_orders WHERE id=ord;
  PERFORM pg_temp.assert_true(captured=quote,'late fact retains original snapshot');
  SELECT count(*) INTO n FROM profiles WHERE id=a AND status='deleted' AND is_deleted='true';
  PERFORM pg_temp.assert_true(n=1,'late fact does not restore closed subject');
  SELECT count(*) INTO n FROM payment_provider_refs WHERE order_id=ord;
  PERFORM pg_temp.assert_true(n=1,'mapping survived erasure');
  EXECUTE 'RESET ROLE';
END $$;
ROLLBACK;
