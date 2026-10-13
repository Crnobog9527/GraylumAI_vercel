-- PAY-STRIPE-MP sandbox catalog mapping (staging only). Generated; review before running.
BEGIN;
DO $$ BEGIN IF (SELECT count(*) FROM membership_plans WHERE (level,monthly_price,yearly_price) IN
  (('pro',2900,27900),('gold',6900,62100)))<>2 THEN RAISE EXCEPTION 'membership_plans not on the approved catalog'; END IF;
  IF (SELECT count(DISTINCT merchant_namespace) FROM payment_provider_refs WHERE channel='stripe' AND mode='test')<>1 THEN
    RAISE EXCEPTION 'expected exactly one Stripe test merchant'; END IF; END $$;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='pro') AND billing_cycle='monthly'
  AND offer_kind='standard' AND price_usage='subscription' AND is_current AND external_id<>'price_1UQ1zD3i2f0AJbrQuMFiEo6u';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zD3i2f0AJbrQuMFiEo6u',(SELECT id FROM membership_plans WHERE level='pro'),
  'monthly',true,'standard','subscription') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='pro') AND billing_cycle='monthly'
  AND offer_kind='standard' AND price_usage='one_time' AND is_current AND external_id<>'price_1UQ1zD3i2f0AJbrQ0FmnEkAH';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zD3i2f0AJbrQ0FmnEkAH',(SELECT id FROM membership_plans WHERE level='pro'),
  'monthly',true,'standard','one_time') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='pro') AND billing_cycle='yearly'
  AND offer_kind='standard' AND price_usage='subscription' AND is_current AND external_id<>'price_1UQ1zD3i2f0AJbrQ1uW9XUcR';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zD3i2f0AJbrQ1uW9XUcR',(SELECT id FROM membership_plans WHERE level='pro'),
  'yearly',true,'standard','subscription') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='pro') AND billing_cycle='yearly'
  AND offer_kind='standard' AND price_usage='one_time' AND is_current AND external_id<>'price_1UQ1zE3i2f0AJbrQwWvhAlRi';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zE3i2f0AJbrQwWvhAlRi',(SELECT id FROM membership_plans WHERE level='pro'),
  'yearly',true,'standard','one_time') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='monthly'
  AND offer_kind='standard' AND price_usage='subscription' AND is_current AND external_id<>'price_1UQ1zE3i2f0AJbrQZzs285d2';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zE3i2f0AJbrQZzs285d2',(SELECT id FROM membership_plans WHERE level='gold'),
  'monthly',true,'standard','subscription') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='monthly'
  AND offer_kind='standard' AND price_usage='one_time' AND is_current AND external_id<>'price_1UQ1zF3i2f0AJbrQ50NWX6ZD';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zF3i2f0AJbrQ50NWX6ZD',(SELECT id FROM membership_plans WHERE level='gold'),
  'monthly',true,'standard','one_time') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='yearly'
  AND offer_kind='standard' AND price_usage='subscription' AND is_current AND external_id<>'price_1UQ1zF3i2f0AJbrQBS0krmt7';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zF3i2f0AJbrQBS0krmt7',(SELECT id FROM membership_plans WHERE level='gold'),
  'yearly',true,'standard','subscription') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='yearly'
  AND offer_kind='standard' AND price_usage='one_time' AND is_current AND external_id<>'price_1UQ1zF3i2f0AJbrQ25oOZDGe';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zF3i2f0AJbrQ25oOZDGe',(SELECT id FROM membership_plans WHERE level='gold'),
  'yearly',true,'standard','one_time') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='yearly'
  AND offer_kind='founder' AND price_usage='subscription' AND is_current AND external_id<>'price_1UQ1zG3i2f0AJbrQmTz7SOxs';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zG3i2f0AJbrQmTz7SOxs',(SELECT id FROM membership_plans WHERE level='gold'),
  'yearly',true,'founder','subscription') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='yearly'
  AND offer_kind='founder' AND price_usage='one_time' AND is_current AND external_id<>'price_1UQ1zG3i2f0AJbrQXIbvGyyk';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zG3i2f0AJbrQXIbvGyyk',(SELECT id FROM membership_plans WHERE level='gold'),
  'yearly',true,'founder','one_time') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='price' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='monthly'
  AND offer_kind='gold_first30' AND price_usage='one_time' AND is_current AND external_id<>'price_1UQ1zG3i2f0AJbrQTCLPqF1L';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','price','price_1UQ1zG3i2f0AJbrQTCLPqF1L',(SELECT id FROM membership_plans WHERE level='gold'),
  'monthly',true,'gold_first30','one_time') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')
  AND mode='test' AND object_type='coupon' AND membership_plan_id=(SELECT id FROM membership_plans WHERE level='gold') AND billing_cycle='monthly'
  AND offer_kind='gold_first30' AND price_usage='subscription' AND is_current AND external_id<>'graylum_mp_gold_first_month';
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test'),'test','coupon','graylum_mp_gold_first_month',(SELECT id FROM membership_plans WHERE level='gold'),
  'monthly',true,'gold_first30','subscription') ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;
COMMIT;
