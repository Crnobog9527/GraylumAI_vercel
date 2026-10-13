-- PAY-STRIPE-MP staging credit packs: rollback. Nothing is deleted (orders may reference packs and prices):
-- the new member prices stop being current, the three new packs are deactivated and the 4 old test packs
-- become active again. Afterwards staging-packs-check.sql shows the "Before" state.
BEGIN;
UPDATE payment_provider_refs SET is_current = false
  WHERE channel = 'stripe' AND mode = 'test' AND external_id IN (
    'price_1UQ4Mb3i2f0AJbrQ2Uokc8Rz','price_1UQ4Mb3i2f0AJbrQTVLP6aoX','price_1UQ4Mc3i2f0AJbrQfwPgd9ab','price_1UQ4Mc3i2f0AJbrQnJhZL07M','price_1UQ4Mc3i2f0AJbrQzO4lanwD','price_1UQ4Md3i2f0AJbrQk3yGEN16');
UPDATE credit_packages SET active = 'false', updated_at = now() WHERE id IN (
  '30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003');
UPDATE credit_packages SET active = 'true', updated_at = now() WHERE id IN (
  'cdc54a4e-3de7-4def-9d8e-b78147bd0f40', '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003');
COMMIT;
