-- PAY-STRIPE-MP staging catalog mapping: rollback. Rows are never deleted (orders may reference them);
-- the new mappings stop being current and the 4 previous Stripe membership prices become current again.
-- Afterwards staging-catalog-check.sql shows the "Before" state.
BEGIN;
UPDATE payment_provider_refs SET is_current = false
  WHERE channel = 'stripe' AND mode = 'test' AND external_id IN (
    'graylum_mp_gold_first_month','price_1UQ1zD3i2f0AJbrQ0FmnEkAH','price_1UQ1zD3i2f0AJbrQ1uW9XUcR','price_1UQ1zD3i2f0AJbrQuMFiEo6u','price_1UQ1zE3i2f0AJbrQZzs285d2','price_1UQ1zE3i2f0AJbrQwWvhAlRi','price_1UQ1zF3i2f0AJbrQ25oOZDGe','price_1UQ1zF3i2f0AJbrQ50NWX6ZD','price_1UQ1zF3i2f0AJbrQBS0krmt7','price_1UQ1zG3i2f0AJbrQTCLPqF1L','price_1UQ1zG3i2f0AJbrQXIbvGyyk','price_1UQ1zG3i2f0AJbrQmTz7SOxs');
UPDATE payment_provider_refs SET is_current = true
  WHERE channel = 'stripe' AND mode = 'test' AND object_type = 'price' AND external_id IN (
    'price_1UFGbh3i2f0AJbrQxgMNnzvp', 'price_1UFGbh3i2f0AJbrQKxGmvJPY',
    'price_1UFGbi3i2f0AJbrQChuH7v5M', 'price_1UFGbi3i2f0AJbrQldgPvDbq');
COMMIT;
