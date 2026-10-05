-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
DO $$
DECLARE product jsonb; product_id uuid; failed boolean; snapshot_ref uuid;
BEGIN
  SET LOCAL ROLE service_role;
  product:=pay_common_save_catalog('credit_package',NULL,
    '{"name":"Fixture","price":1999,"credits_amount":100,"bonus_credits":20,"active":"true"}',
    '{"one_time":{"external_id":"price_catalog_one","unit_amount":1999,"currency":"usd","mode":"test","billing_cycle":"one_time"}}',
    'acct_fixture','test');
  product_id:=(product->>'id')::uuid;
  PERFORM pg_temp.assert_true(product->>'stripe_price_id'='price_catalog_one','catalog legacy ID derived atomically');
  SELECT id INTO snapshot_ref FROM payment_provider_refs WHERE credit_package_id=product_id AND is_current;
  PERFORM pg_temp.assert_true(snapshot_ref IS NOT NULL,'mapping is authoritative');
  product:=pay_common_save_catalog('credit_package',product_id,'{}',
    '{"one_time":{"external_id":"price_catalog_two","unit_amount":1999,"currency":"usd","mode":"test","billing_cycle":"one_time"}}',
    'acct_fixture','test');
  PERFORM pg_temp.assert_true(product->>'stripe_price_id'='price_catalog_two','current price changed');
  PERFORM pg_temp.assert_true((SELECT NOT is_current FROM payment_provider_refs WHERE id=snapshot_ref),'historical mapping retained');
  PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM payment_provider_refs WHERE credit_package_id=product_id AND is_current),'one current mapping');
  failed:=false;
  BEGIN
    PERFORM pay_common_save_catalog('credit_package',product_id,'{"price":9999}',
      '{"one_time":{"external_id":"price_catalog_bad","unit_amount":1999,"currency":"usd","mode":"test","billing_cycle":"one_time"}}',
      'acct_fixture','test');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='PAY_COMMON_PRICE_MISMATCH'; END;
  PERFORM pg_temp.assert_true(failed,'amount mismatch rejected');
  PERFORM pg_temp.assert_true((SELECT price=1999 AND stripe_price_id='price_catalog_two' FROM credit_packages WHERE id=product_id),
    'mismatch rolls back catalog and mapping together');
  failed:=false;
  BEGIN PERFORM pay_common_save_catalog('credit_package',product_id,'{"price":2999}','{}',NULL,NULL);
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='PAY_COMMON_PRICE_REPLACEMENT_REQUIRED'; END;
  PERFORM pg_temp.assert_true(failed,'amount-only package edit rejected');
  PERFORM pg_temp.assert_true((SELECT price=1999 AND stripe_price_id='price_catalog_two' FROM credit_packages WHERE id=product_id),
    'rejected amount-only update changes neither price nor mapping');
  product:=pay_common_save_catalog('credit_package',product_id,'{"price":1999,"name":"Renamed"}','{}',NULL,NULL);
  PERFORM pg_temp.assert_true(product->>'name'='Renamed','same amount and non-price edits allowed');
  product:=pay_common_save_catalog('credit_package',product_id,'{"price":2999}',
    '{"one_time":{"external_id":"price_catalog_three","unit_amount":2999,"currency":"usd","mode":"test","billing_cycle":"one_time"}}',
    'acct_fixture','test');
  PERFORM pg_temp.assert_true(product->>'price'='2999' AND product->>'stripe_price_id'='price_catalog_three','replacement matches new amount');
  product:=pay_common_save_catalog('credit_package',product_id,'{}','{"one_time":null}','acct_fixture','test');
  PERFORM pg_temp.assert_true(product->>'stripe_price_id' IS NULL,'clear mapping derives null ID');
  PERFORM pg_temp.assert_true((SELECT count(*)=3 FROM payment_provider_refs WHERE credit_package_id=product_id),'clear retains history');
  SET LOCAL ROLE authenticated;
  failed:=false;
  BEGIN PERFORM pay_common_save_catalog('credit_package',product_id,'{"price":1}','{}',NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  PERFORM pg_temp.assert_true(failed,'ordinary callers cannot bypass admin boundary');
  RESET ROLE;
END $$;
DO $$
DECLARE plan uuid; cycle text; price_field text; failed boolean; saved jsonb;
BEGIN
  SELECT id INTO plan FROM membership_plans WHERE level='pro';
  IF plan IS NULL THEN
    INSERT INTO membership_plans(name,level,monthly_price,yearly_price,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES('Fixture','pro',1999,19999,false,false,0) RETURNING id INTO plan;
  END IF;
  FOREACH cycle IN ARRAY ARRAY['monthly','yearly'] LOOP
    price_field:=CASE cycle WHEN 'monthly' THEN 'monthly_price' ELSE 'yearly_price' END;
    SET LOCAL ROLE service_role;
    failed:=false;
    BEGIN PERFORM pay_common_save_catalog('membership_plan',plan,jsonb_build_object(price_field,98765),'{}',NULL,NULL);
    EXCEPTION WHEN check_violation THEN failed:=SQLERRM='PAY_COMMON_PRICE_REPLACEMENT_REQUIRED'; END;
    PERFORM pg_temp.assert_true(failed,'membership amount edit requires cycle price');
    saved:=pay_common_save_catalog('membership_plan',plan,jsonb_build_object(price_field,98765),
      jsonb_build_object(cycle,NULL),'acct_fixture','test');
    PERFORM pg_temp.assert_true((saved->>price_field)::integer=98765,'explicitly clearing mapping permits new amount');
    PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE membership_plan_id=plan
      AND billing_cycle=cycle AND is_current),'cleared cycle unavailable');
    RESET ROLE;
  END LOOP;
END $$;
ROLLBACK;
