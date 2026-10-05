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
  DECLARE req jsonb; persisted jsonb; evidence jsonb; outcome jsonb;
  BEGIN
    req:=jsonb_build_object('mode','payment','client_reference_id',buyer,'customer_creation','always',
      'expires_at',extract(epoch FROM now())::bigint+3600,
      'metadata',jsonb_build_object('orderId',first_order.id,'userId',buyer,'itemId',package,
        'itemType','credit_package','billingCycle','one_time','priceId','price_fixture'),
      'line_items',jsonb_build_array(jsonb_build_object('quantity',1,'price_data',jsonb_build_object('currency','usd','unit_amount',1799))));
    PERFORM pg_temp.denied(format('SELECT pay_common_prepare_checkout(%L,%L,%L)',buyer,first_order.id,
      req||'{"automatic_tax":{"enabled":true}}'::jsonb), '23514','PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    PERFORM pg_temp.denied(format('SELECT pay_common_prepare_checkout(%L,%L,%L)',buyer,first_order.id,
      req||'{"payment_intent_data":{"application_fee_amount":50}}'::jsonb), '23514','PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    persisted:=pay_common_prepare_checkout(buyer,first_order.id,req);
    PERFORM pg_temp.assert_true(persisted=req,'exact request saved before dispatch');
    PERFORM pg_temp.assert_true(pay_common_prepare_checkout(buyer,first_order.id,'{}')=req,'request replay cannot mutate envelope');
    PERFORM pg_temp.denied(format('UPDATE payment_orders SET checkout_request=NULL WHERE id=%L',first_order.id),'42501');
    evidence:=jsonb_build_object('id','cs_extension_fixture','object','checkout.session','livemode',false,'mode','payment',
      'client_reference_id',buyer,'metadata',req->'metadata','amount_total',1799,'currency','usd',
      'payment_status','unpaid','status','open');
    outcome:=pay_common_record_checkout(first_order.id,'acct_fixture','test',evidence||'{"amount_total":1}');
    PERFORM pg_temp.assert_true(outcome->>'ok'='false','mismatch rejected with persisted conflict');
    PERFORM pg_temp.assert_true((SELECT jsonb_array_length(metadata->'paymentConflicts')=1 FROM payment_orders WHERE id=first_order.id),
      'safe conflict evidence persisted');
    PERFORM pg_temp.assert_true((SELECT metadata->'paymentConflicts'->0->>'code'='PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'
      FROM payment_orders WHERE id=first_order.id),'conflict has stable alert code');
    outcome:=pay_common_record_checkout(first_order.id,'acct_fixture','test',evidence);
    PERFORM pg_temp.assert_true(outcome->>'ok'='true','authoritative session accepted');
    PERFORM pg_temp.assert_true((SELECT stripe_checkout_session_id='cs_extension_fixture' AND stripe_price_id='price_fixture'
      FROM payment_orders WHERE id=first_order.id),'derived IDs commit with mapping');
    PERFORM pg_temp.denied(format('UPDATE payment_orders SET stripe_checkout_session_id=%L WHERE id=%L',
      'cs_forged_fixture',first_order.id),'42501','PAY_COMMON_DERIVED_COLUMN_WRITE_DENIED');
    PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM payment_provider_refs WHERE order_id=first_order.id AND object_type='checkout'),
      'one authoritative checkout mapping');
    outcome:=pay_common_record_checkout(first_order.id,'acct_fixture','test',evidence);
    PERFORM pg_temp.assert_true(outcome->>'ok'='true','callback replay uses original mapping');
    outcome:=pay_common_record_checkout(first_order.id,'acct_fixture','test',evidence||'{"payment_status":"paid"}');
    PERFORM pg_temp.assert_true(outcome->>'ok'='true','paid evidence accepted');
    PERFORM pg_temp.assert_true((SELECT jsonb_array_length(payment_amount_facts)=3 FROM payment_orders WHERE id=first_order.id),
      'payment fact with unknown fee and net');
    outcome:=pay_common_record_checkout(first_order.id,'acct_fixture','test',evidence||'{"payment_status":"paid"}');
    PERFORM pg_temp.assert_true((SELECT jsonb_array_length(payment_amount_facts)=3 FROM payment_orders WHERE id=first_order.id),
      'duplicate paid callback does not append duplicate facts');
    outcome:=pay_common_record_checkout(first_order.id,'acct_fixture','test',evidence);
    PERFORM pg_temp.assert_true((SELECT payment_status='paid' FROM payment_orders WHERE id=first_order.id),
      'late unpaid cannot regress paid');
    EXECUTE 'RESET ROLE';
    UPDATE credit_packages SET credits_amount=900 WHERE id=package;
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM pg_temp.assert_true((SELECT granted_credits=120 FROM atomic_fulfill_credit_package('cs_extension_fixture','paid')),
      'fulfillment uses original frozen credits');
    PERFORM pg_temp.assert_true((SELECT already_fulfilled AND granted_credits=0 FROM atomic_fulfill_credit_package('cs_extension_fixture','paid')),
      'fulfillment replay grants once');

  END;


  EXECUTE 'RESET ROLE';
END $$;
ROLLBACK;
