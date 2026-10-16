-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Rollback for the ADMIN-SECRETS OR-1 migration (openrouter_key_to_vault). NOT a migration: run by hand, after
-- approval, BEFORE reverting the OR-1 code. It writes the key the platform currently uses (the Vault `openrouter`
-- slot, possibly replaced in the admin after OR-1) back into ai_models.api_key of every OpenRouter model row, so the
-- old code reads the key that is valid now, not a retired one left in the column. The value stays inside the
-- database. The Vault slot is left as it is (the old code ignores it). Refuses when the slot is empty.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$
DECLARE v text;
BEGIN
 v:=platform_secret_read('openrouter');
 IF v IS NULL THEN RAISE EXCEPTION 'OPENROUTER_KEY_ROLLBACK_SLOT_EMPTY' USING ERRCODE='55000'; END IF;
 -- OpenRouter rows: no endpoint (defaults to OpenRouter) or the OpenRouter endpoint.
 UPDATE ai_models SET api_key=v
  WHERE coalesce(btrim(api_endpoint),'')='' OR api_endpoint ILIKE 'https://openrouter.ai/%';
END $$;
COMMIT;
