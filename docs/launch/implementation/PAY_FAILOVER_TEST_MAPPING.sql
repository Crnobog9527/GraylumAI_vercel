-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- PAY-FAILOVER test catalog data only. Controller-reviewed application AFTER migration 0335.
-- Source: docs/launch/evidence/pay-failover-products-20261022/products.json (12 confirmed one-time USD products).
-- Execute ONLY on staging project gvcpmcunmfrbxuwimxfa, after checking the actual connection target.
-- This file cannot infer a Supabase project from a PostgreSQL connection; the executor must verify it.
-- All-or-nothing INSERT-only batch. No route/settings/order/user/legacy/live row is updated or deleted.
-- Exact existing current mappings are idempotent. Any conflicting/rebound/inactive mapping refuses the batch.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(7063,2);
CREATE TEMP TABLE pay_failover_test_manifest (
 sku text PRIMARY KEY,membership_plan_id uuid,credit_package_id uuid,
 billing_cycle text NOT NULL,offer_kind text NOT NULL,price_usage text NOT NULL,package_tier text NOT NULL,
 amount_minor integer NOT NULL,external_id text NOT NULL UNIQUE,merchant_namespace text
) ON COMMIT DROP;
INSERT INTO pay_failover_test_manifest(sku,membership_plan_id,credit_package_id,billing_cycle,offer_kind,
 price_usage,package_tier,amount_minor,external_id) VALUES
 ('pro-month','10000000-0000-4000-8000-000000000002',NULL,'monthly','standard','one_time','legacy',2900,'PROD_6FNYvZF8hqtUQ2eI2dYWn4'),
 ('pro-year','10000000-0000-4000-8000-000000000002',NULL,'yearly','standard','one_time','legacy',27900,'PROD_5H6xw582MO5LMlXDMdBaYV'),
 ('gold-month','10000000-0000-4000-8000-000000000003',NULL,'monthly','standard','one_time','legacy',6900,'PROD_28RcU7crNX1yWcNG6cUung'),
 ('gold-year','10000000-0000-4000-8000-000000000003',NULL,'yearly','standard','one_time','legacy',62100,'PROD_7jIVpWKLO8UPJCP1AYhvBf'),
 ('gold-first','10000000-0000-4000-8000-000000000003',NULL,'monthly','gold_first30','one_time','legacy',4900,'PROD_4eXN4ZE5tGcYrPijNWi1NN'),
 ('founder','10000000-0000-4000-8000-000000000003',NULL,'yearly','founder','one_time','legacy',49600,'PROD_2j3AkXSpKPucJveBZmnqB1'),
 ('pack990-pro',NULL,'30000000-0000-4000-8000-000000000001','one_time','standard','package','pro',940,'PROD_3XO2qfUvb0XOroaT4aBAKV'),
 ('pack990-gold',NULL,'30000000-0000-4000-8000-000000000001','one_time','standard','package','gold',890,'PROD_5YIBXJgdZU0f6k30auvzXc'),
 ('pack2990-pro',NULL,'30000000-0000-4000-8000-000000000002','one_time','standard','package','pro',2840,'PROD_1752aMIkaA3xBtS9k6nx3Y'),
 ('pack2990-gold',NULL,'30000000-0000-4000-8000-000000000002','one_time','standard','package','gold',2690,'PROD_4v5lv0dtor8i8yx5rPvfLq'),
 ('pack10990-pro',NULL,'30000000-0000-4000-8000-000000000003','one_time','standard','package','pro',9490,'PROD_1qYZ4XFhJdY9Dy8sBap3fJ'),
 ('pack10990-gold',NULL,'30000000-0000-4000-8000-000000000003','one_time','standard','package','gold',8990,'PROD_5LB9TxN6Khruy6YyuPEFu6');
DO $mapping$
DECLARE merchant text; matches integer; namespaces integer;
BEGIN
 IF to_regprocedure('public.pay_failover_fulfill(uuid,text,text,text,text,integer,text,timestamptz,timestamptz,timestamptz,text)') IS NULL
  OR to_regprocedure('public.pay_failover_set_channel(uuid,bigint,text)') IS NULL THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_REQUIRES_0335'; END IF;
 -- Lock catalog rows before references: this matches catalog maintenance's row -> reference lock order.
 PERFORM 1 FROM public.membership_plans WHERE id IN (
  '10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003') ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.credit_packages WHERE id IN (
  '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003') ORDER BY id FOR SHARE;
 LOCK TABLE public.payment_provider_refs IN SHARE ROW EXCLUSIVE MODE;
 IF (SELECT count(*) FROM public.membership_plans WHERE is_active='true' AND (
  id='10000000-0000-4000-8000-000000000002' AND level='pro' AND monthly_price=2900 AND yearly_price=27900
   AND monthly_credits=3480 AND yearly_credits=41760
  OR id='10000000-0000-4000-8000-000000000003' AND level='gold' AND monthly_price=6900 AND yearly_price=62100
   AND monthly_credits=8970 AND yearly_credits=107640))<>2
  OR (SELECT count(*) FROM public.credit_packages p JOIN (VALUES
   ('30000000-0000-4000-8000-000000000001'::uuid,990,990,0),
   ('30000000-0000-4000-8000-000000000002'::uuid,2990,2990,0),
   ('30000000-0000-4000-8000-000000000003'::uuid,9990,9990,1000)
  ) expected(id,price,credits,bonus) ON p.id=expected.id WHERE p.active='true'
   AND p.price=expected.price AND p.credits_amount=expected.credits AND p.bonus_credits=expected.bonus)<>3 THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_CATALOG_CHANGED'; END IF;
 -- Bind to the same namespace as all six verified original test subscription products.
 -- These old refs are evidence of the test binding only; they remain current and unchanged.
 SELECT count(*),count(DISTINCT r.merchant_namespace),min(r.merchant_namespace)
 INTO matches,namespaces,merchant FROM public.payment_provider_refs r JOIN (VALUES
  ('PROD_3JKZPZdJtcSdu9dXdNuJQT','10000000-0000-4000-8000-000000000002'::uuid,'monthly','standard'),
  ('PROD_2qOnkXjXAGhsxLrbTGsUSb','10000000-0000-4000-8000-000000000002'::uuid,'yearly','standard'),
  ('PROD_3FNIDuKdkVgvIfd0O4vUzZ','10000000-0000-4000-8000-000000000003'::uuid,'monthly','standard'),
  ('PROD_0ZleshD5LEYuTruuiVEBNs','10000000-0000-4000-8000-000000000003'::uuid,'yearly','standard'),
  ('PROD_6bacQZwfKBSKqsuRzGmYaN','10000000-0000-4000-8000-000000000003'::uuid,'monthly','gold_first30'),
  ('PROD_25Zmm7PVC68mtzM2XkZZAC','10000000-0000-4000-8000-000000000003'::uuid,'yearly','founder')
 ) old(external_id,plan_id,cycle,offer) ON r.external_id=old.external_id
  AND r.membership_plan_id=old.plan_id AND r.billing_cycle=old.cycle AND r.offer_kind=old.offer
 WHERE r.channel='waffo' AND r.mode='test' AND r.object_type='price' AND r.price_usage='subscription'
  AND r.package_tier='legacy' AND r.is_current;
 IF matches<>6 OR namespaces<>1 OR merchant IS DISTINCT FROM 'waffo_test' THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_TEST_BINDING_CHANGED'; END IF;
 UPDATE pay_failover_test_manifest SET merchant_namespace=merchant;
 IF (SELECT count(*) FROM pay_failover_test_manifest)<>12 OR EXISTS(SELECT 1 FROM pay_failover_test_manifest
  WHERE external_id !~ '^PROD_[A-Za-z0-9]+$' OR amount_minor<=0
   OR membership_plan_id IS NOT NULL AND (price_usage<>'one_time' OR package_tier<>'legacy')
   OR credit_package_id IS NOT NULL AND (price_usage<>'package' OR package_tier NOT IN ('pro','gold'))) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_MANIFEST_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM pay_failover_test_manifest m JOIN public.credit_packages p ON p.id=m.credit_package_id
  WHERE m.amount_minor<>floor(p.price::numeric*CASE m.package_tier WHEN 'pro' THEN 95 ELSE 90 END/100/10)::integer*10) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_PACKAGE_PRICE_CHANGED'; END IF;
 -- No old subscription product or live reference may be relabelled as this new one-time catalog.
 IF EXISTS(SELECT 1 FROM public.payment_provider_refs r JOIN pay_failover_test_manifest m ON r.external_id=m.external_id
  WHERE r.channel='waffo' AND (r.mode='live' OR r.price_usage='subscription')) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_PRODUCT_ALREADY_LEGACY_OR_LIVE'; END IF;
 -- First reject every conflict, then insert. Never silently deactivate a different current price.
 IF EXISTS(SELECT 1 FROM public.payment_provider_refs r JOIN pay_failover_test_manifest m
  ON r.channel='waffo' AND r.mode='test' AND r.merchant_namespace=m.merchant_namespace AND r.object_type='price'
   AND r.membership_plan_id IS NOT DISTINCT FROM m.membership_plan_id
   AND r.credit_package_id IS NOT DISTINCT FROM m.credit_package_id AND r.billing_cycle=m.billing_cycle
   AND r.offer_kind=m.offer_kind AND r.price_usage=m.price_usage AND r.package_tier=m.package_tier
  WHERE r.is_current AND r.external_id<>m.external_id) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_CURRENT_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM public.payment_provider_refs r JOIN pay_failover_test_manifest m ON r.external_id=m.external_id
  WHERE r.channel='waffo' AND r.mode='test' AND (
   r.merchant_namespace IS DISTINCT FROM m.merchant_namespace OR r.object_type IS DISTINCT FROM 'price'
   OR r.membership_plan_id IS DISTINCT FROM m.membership_plan_id OR r.credit_package_id IS DISTINCT FROM m.credit_package_id
   OR r.billing_cycle IS DISTINCT FROM m.billing_cycle OR r.offer_kind IS DISTINCT FROM m.offer_kind
   OR r.price_usage IS DISTINCT FROM m.price_usage OR r.package_tier IS DISTINCT FROM m.package_tier
   OR r.is_current IS DISTINCT FROM true)) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_EXISTING_ID_CONFLICT'; END IF;
 INSERT INTO public.payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
  membership_plan_id,credit_package_id,billing_cycle,is_current,offer_kind,price_usage,package_tier)
 SELECT 'waffo',m.merchant_namespace,'test','price',m.external_id,m.membership_plan_id,m.credit_package_id,
  m.billing_cycle,true,m.offer_kind,m.price_usage,m.package_tier FROM pay_failover_test_manifest m
 WHERE NOT EXISTS(SELECT 1 FROM public.payment_provider_refs r WHERE r.channel='waffo'
  AND r.merchant_namespace=m.merchant_namespace AND r.mode='test' AND r.object_type='price' AND r.external_id=m.external_id);
 IF (SELECT count(*) FROM public.payment_provider_refs r JOIN pay_failover_test_manifest m
  ON r.channel='waffo' AND r.merchant_namespace=m.merchant_namespace AND r.mode='test' AND r.object_type='price'
   AND r.external_id=m.external_id AND r.membership_plan_id IS NOT DISTINCT FROM m.membership_plan_id
   AND r.credit_package_id IS NOT DISTINCT FROM m.credit_package_id AND r.billing_cycle=m.billing_cycle
   AND r.is_current AND r.offer_kind=m.offer_kind AND r.price_usage=m.price_usage AND r.package_tier=m.package_tier)<>12 THEN
  RAISE EXCEPTION 'PAY_FAILOVER_MAPPING_POSTCHECK_FAILED'; END IF;
END $mapping$;
SELECT m.sku,m.amount_minor AS expected_usd_minor,r.id AS mapping_id,r.external_id,r.channel,r.merchant_namespace,
 r.mode,r.billing_cycle,r.offer_kind,r.price_usage,r.package_tier
FROM pay_failover_test_manifest m JOIN public.payment_provider_refs r ON r.external_id=m.external_id
 AND r.channel='waffo' AND r.merchant_namespace=m.merchant_namespace AND r.mode='test' AND r.object_type='price'
ORDER BY m.sku;
COMMIT;
