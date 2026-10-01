-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-UNIT draft kept outside packages/db/migrations so the ledger check and CI tests keep running.
-- Move into packages/db/migrations with the next free number after #497 (0155) and #550 (0156) merge.
-- Local development only until host integration, final validation, review and Owner authorization.
--
-- Per-model price multiplier m. NULL means "inherit the site-wide default"
-- (system_settings.billing_token_price_multiplier); existing rows stay NULL so inheritance is not
-- masked by a back-filled value. Unconstrained numeric plus a CHECK (instead of numeric(p,2))
-- so an over-precise value is rejected rather than silently rounded before the check.
-- No column grant to anon/authenticated: only service-role admin endpoints read or write it.
--
-- Rollback: stop new BILL-UNIT admission first, then `UPDATE ai_models SET price_multiplier = NULL`
-- restores site-wide inheritance. Do not drop the column once a frozen call has recorded an m_i:
-- frozen calls keep their own m_i, but forward-fix instead of deploying code that cannot read it.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS price_multiplier numeric;

-- ADD COLUMN IF NOT EXISTS silently keeps a pre-existing column of another type; refuse that.
DO $$
BEGIN
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.ai_models'::regclass AND attname = 'price_multiplier' AND NOT attisdropped)
     IS DISTINCT FROM 'numeric' THEN
    RAISE EXCEPTION 'BILL_UNIT_PRICE_MULTIPLIER_TYPE_MISMATCH';
  END IF;
END $$;

ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_price_multiplier_check;
ALTER TABLE public.ai_models ADD CONSTRAINT ai_models_price_multiplier_check CHECK (
  price_multiplier IS NULL
  OR (price_multiplier >= 1 AND price_multiplier <= 20 AND scale(price_multiplier) <= 2)
);

COMMENT ON COLUMN public.ai_models.price_multiplier IS
  'BILL-UNIT per-model price multiplier (1-20, at most 2 decimals); NULL inherits billing_token_price_multiplier.';

COMMIT;
