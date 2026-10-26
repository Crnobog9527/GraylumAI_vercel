-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- Synthetic identifiers exist only in a disposable local database, never real provider objects.
BEGIN;
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
  membership_plan_id,billing_cycle,is_current)
SELECT 'stripe','local-only','test','price','local-only-plan',id,'monthly',true FROM membership_plans WHERE level='pro';
__FILLED_SEED__
UPDATE membership_plans SET monthly_price=3000 WHERE level='pro';
DO $test$ BEGIN
  BEGIN __FILLED_SEED__
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SEED_PRICE_REPLACEMENT_REQUIRED' THEN RAISE; END IF; RETURN; END;
  RAISE EXCEPTION 'mapped plan price overwritten';
END $test$;
ROLLBACK;
BEGIN;
INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,is_current)
VALUES('stripe','local-only','test','price','local-only-pack','30000000-0000-4000-8000-000000000001',true);
UPDATE credit_packages SET price=1000 WHERE id='30000000-0000-4000-8000-000000000001';
DO $test$ BEGIN
  BEGIN __FILLED_SEED__
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SEED_PRICE_REPLACEMENT_REQUIRED' THEN RAISE; END IF; RETURN; END;
  RAISE EXCEPTION 'mapped package price overwritten';
END $test$;
ROLLBACK;
