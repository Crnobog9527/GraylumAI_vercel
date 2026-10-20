-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ADMIN-SECRETS OR-2 recovery. NOT a migration: run by hand before reverting OR-1 code.
-- Recreates the legacy column and restores the current Vault value to OpenRouter model rows. Other providers remain NULL.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS api_key text;

DO $rollback$
DECLARE
  current_key text;
BEGIN
  current_key := public.platform_secret_read('openrouter');
  IF current_key IS NULL THEN
    RAISE EXCEPTION 'OPENROUTER_KEY_ROLLBACK_SLOT_EMPTY' USING ERRCODE = '55000';
  END IF;
  UPDATE public.ai_models
  SET api_key = current_key
  WHERE coalesce(btrim(api_endpoint), '') = ''
     OR btrim(api_endpoint) ~* '^https://openrouter\.ai(:443)?/';
END
$rollback$;

COMMIT;
