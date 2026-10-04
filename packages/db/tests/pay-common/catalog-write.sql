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
  product:=pay_common_save_catalog('credit_package',product_id,'{}','{"one_time":null}','acct_fixture','test');
  PERFORM pg_temp.assert_true(product->>'stripe_price_id' IS NULL,'clear mapping derives null ID');
  PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM payment_provider_refs WHERE credit_package_id=product_id),'clear retains history');
  SET LOCAL ROLE authenticated;
  failed:=false;
  BEGIN PERFORM pay_common_save_catalog('credit_package',product_id,'{"price":1}','{}',NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  PERFORM pg_temp.assert_true(failed,'ordinary callers cannot bypass admin boundary');
  RESET ROLE;
END $$;
ROLLBACK;
