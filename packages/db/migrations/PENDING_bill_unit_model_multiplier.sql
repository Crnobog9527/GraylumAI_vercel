-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-UNIT draft: no migration number reserved. Rename after #497 (0155) and #550 (0156) merge.
-- Local development only until host integration, final validation, review and Owner authorization.
--
-- Per-model price multiplier m. NULL means "inherit the site-wide default"
-- (system_settings.billing_token_price_multiplier); existing rows stay NULL so inheritance is not
-- masked by a back-filled value. Unconstrained numeric plus a CHECK (instead of numeric(p,2))
-- so an over-precise value is rejected rather than silently rounded before the check.
-- No column grant to anon/authenticated: only service-role admin endpoints read or write it.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS price_multiplier numeric;

ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_price_multiplier_check;
ALTER TABLE public.ai_models ADD CONSTRAINT ai_models_price_multiplier_check CHECK (
  price_multiplier IS NULL
  OR (price_multiplier >= 1 AND price_multiplier <= 20 AND scale(price_multiplier) <= 2)
);

COMMENT ON COLUMN public.ai_models.price_multiplier IS
  'BILL-UNIT per-model price multiplier (1-20, at most 2 decimals); NULL inherits billing_token_price_multiplier.';

COMMIT;
