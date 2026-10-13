-- PAY-STRIPE-MP sandbox credit packs (staging only). Generated; review before running.
BEGIN;
DO $$ BEGIN IF (SELECT count(DISTINCT merchant_namespace) FROM payment_provider_refs WHERE channel='stripe' AND mode='test')<>1
  THEN RAISE EXCEPTION 'expected exactly one Stripe test merchant'; END IF; END $$;
INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits,sort_order,
  is_popular,active) VALUES('30000000-0000-4000-8000-000000000001','积分包 小',990,990,0,1,
  'false','true') ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,
  credits_amount=excluded.credits_amount,bonus_credits=excluded.bonus_credits,sort_order=excluded.sort_order,
  is_popular=excluded.is_popular,active='true',updated_at=now();
INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits,sort_order,
  is_popular,active) VALUES('30000000-0000-4000-8000-000000000002','积分包 中',2990,2990,0,2,
  'false','true') ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,
  credits_amount=excluded.credits_amount,bonus_credits=excluded.bonus_credits,sort_order=excluded.sort_order,
  is_popular=excluded.is_popular,active='true',updated_at=now();
INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits,sort_order,
  is_popular,active) VALUES('30000000-0000-4000-8000-000000000003','积分包 大',9990,9990,1000,3,
  'false','true') ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,
  credits_amount=excluded.credits_amount,bonus_credits=excluded.bonus_credits,sort_order=excluded.sort_order,
  is_popular=excluded.is_popular,active='true',updated_at=now();
UPDATE credit_packages SET active='false',updated_at=now() WHERE active='true' AND id NOT IN ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003');
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND credit_package_id='30000000-0000-4000-8000-000000000001' AND billing_cycle='one_time' AND package_tier='pro'
  AND is_current AND external_id<>'price_1UQ4Mb3i2f0AJbrQ2Uokc8Rz';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ4Mb3i2f0AJbrQ2Uokc8Rz','30000000-0000-4000-8000-000000000001',
  'one_time',true,'standard','package','pro') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND credit_package_id='30000000-0000-4000-8000-000000000001' AND billing_cycle='one_time' AND package_tier='gold'
  AND is_current AND external_id<>'price_1UQ4Mb3i2f0AJbrQTVLP6aoX';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ4Mb3i2f0AJbrQTVLP6aoX','30000000-0000-4000-8000-000000000001',
  'one_time',true,'standard','package','gold') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND credit_package_id='30000000-0000-4000-8000-000000000002' AND billing_cycle='one_time' AND package_tier='pro'
  AND is_current AND external_id<>'price_1UQ4Mc3i2f0AJbrQfwPgd9ab';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ4Mc3i2f0AJbrQfwPgd9ab','30000000-0000-4000-8000-000000000002',
  'one_time',true,'standard','package','pro') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND credit_package_id='30000000-0000-4000-8000-000000000002' AND billing_cycle='one_time' AND package_tier='gold'
  AND is_current AND external_id<>'price_1UQ4Mc3i2f0AJbrQzO4lanwD';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ4Mc3i2f0AJbrQzO4lanwD','30000000-0000-4000-8000-000000000002',
  'one_time',true,'standard','package','gold') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND credit_package_id='30000000-0000-4000-8000-000000000003' AND billing_cycle='one_time' AND package_tier='pro'
  AND is_current AND external_id<>'price_1UQ4Mc3i2f0AJbrQnJhZL07M';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ4Mc3i2f0AJbrQnJhZL07M','30000000-0000-4000-8000-000000000003',
  'one_time',true,'standard','package','pro') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND credit_package_id='30000000-0000-4000-8000-000000000003' AND billing_cycle='one_time' AND package_tier='gold'
  AND is_current AND external_id<>'price_1UQ4Md3i2f0AJbrQk3yGEN16';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ4Md3i2f0AJbrQk3yGEN16','30000000-0000-4000-8000-000000000003',
  'one_time',true,'standard','package','gold') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
COMMIT;
