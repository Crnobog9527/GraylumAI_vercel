-- BENCHMARK-COVERAGE (#1294): billing_provider_prices is written by two callers, the admin "third-party prices" page and
-- the daily research price refresh (billing-reconcile). saveProviderPrices compared the stored hash and wrote in two
-- statements, so a save landing between them could be silently overwritten with a stale snapshot. This writer compares
-- and writes under one row lock. The hash is the one saveProviderPrices computes: sha256 of the stored JSON text (the
-- value is stored as a JSON string; any other shape never matches and must be replaced through the admin page's hash).
-- Only adds a function: no table, data or grant on the table changes. Repeatable (CREATE OR REPLACE).
-- Rollback: DROP FUNCTION IF EXISTS public.billing_provider_prices_swap(text,text); and deploy the code before #1294
-- (saveProviderPrices then writes with its old upsert). No stored data depends on the function.
CREATE OR REPLACE FUNCTION public.billing_provider_prices_swap(p_expected_hash text, p_value text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_value jsonb; current_hash text;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value::jsonb) IS DISTINCT FROM 'object'
   OR (p_expected_hash IS NOT NULL AND p_expected_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'BILLING_UNIT_PROVIDER_PRICES_INVALID' USING ERRCODE='22023';
  END IF;
  -- The row may not exist yet (first save): the advisory lock serializes that case too.
  PERFORM pg_advisory_xact_lock(hashtext('billing_provider_prices'));
  SELECT value INTO current_value FROM system_settings WHERE key='billing_provider_prices' FOR UPDATE;
  current_hash:=CASE WHEN current_value IS NULL THEN NULL
    WHEN jsonb_typeof(current_value)='string' THEN encode(sha256(convert_to(current_value #>> '{}','UTF8')),'hex')
    ELSE encode(sha256(convert_to(current_value::text,'UTF8')),'hex') END;
  IF current_hash IS DISTINCT FROM p_expected_hash THEN
    RAISE EXCEPTION 'BILLING_UNIT_PROVIDER_PRICES_CONFLICT' USING ERRCODE='40001';
  END IF;
  INSERT INTO system_settings(key,value) VALUES('billing_provider_prices',to_jsonb(p_value))
  ON CONFLICT (key) DO UPDATE SET value=excluded.value;
  RETURN encode(sha256(convert_to(p_value,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION public.billing_provider_prices_swap(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_provider_prices_swap(text,text) TO service_role;
