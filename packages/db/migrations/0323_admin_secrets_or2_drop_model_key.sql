-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ADMIN-SECRETS OR-2: remove the legacy plaintext model credential after OR-1 moved OpenRouter to Vault.
-- Clear the column and its historical column-level grants before dropping it. The existence check guards the
-- UPDATE as well as the DROP so a second run is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_models'
      AND column_name = 'api_key'
  ) THEN
    UPDATE public.ai_models SET api_key = NULL;
    EXECUTE 'REVOKE SELECT (api_key) ON TABLE public.ai_models FROM PUBLIC, anon, authenticated';
    ALTER TABLE public.ai_models DROP COLUMN api_key;
  END IF;
END
$migration$;

COMMIT;
