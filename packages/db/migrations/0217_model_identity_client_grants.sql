-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MODEL-IDENTITY-GUARD layer 4. Allocation: controller 2026-10-12 (0217, after 0216).
-- Signed-in clients must not read real model names or provider model ids through the
-- database API (Owner: the data never carries real names).
--  1. ai_models: 0142 left every column except api_key client-readable; revoke them all.
--     No client code reads ai_models; the server uses service_role (unchanged).
--  2. token_stats stays client-readable for own rows (0148 grants table SELECT and must
--     stay a no-op on re-apply), so its model fields store an opaque alias instead:
--     model_used and metadata modelId / pricing.modelId / pricing.providerModel become
--     "m_<16 hex>". The alias -> model map is server-only; admin reports resolve it.
--     A BEFORE trigger aliases every write; existing rows are backfilled below.
-- Re-running is a no-op (aliases are idempotent; the backfill selects unaliased rows only).
-- Recovery: forward only. To restore real strings, drop the trigger and run
-- packages/db/tests/model-identity-redact/rollback.sql (the map keeps every original).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$
DECLARE model_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO model_columns
  FROM pg_attribute WHERE attrelid='public.ai_models'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE SELECT (%s) ON TABLE public.ai_models FROM PUBLIC, anon, authenticated', model_columns);
  REVOKE SELECT ON TABLE public.ai_models FROM PUBLIC, anon, authenticated;
END $$;

CREATE TABLE IF NOT EXISTS public.model_usage_aliases(
  alias text PRIMARY KEY CHECK (alias ~ '^m_[0-9a-f]{16}$'),
  model text NOT NULL UNIQUE CHECK (model <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.model_usage_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.model_usage_aliases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.model_usage_aliases TO service_role;

-- Random (not hashed) aliases: a hash of a public model id could be guessed back.
CREATE OR REPLACE FUNCTION public.model_usage_alias(p_model text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a text;
BEGIN
 IF p_model IS NULL OR p_model='' THEN RETURN p_model;END IF;
 IF p_model ~ '^m_[0-9a-f]{16}$' AND EXISTS(SELECT 1 FROM model_usage_aliases WHERE alias=p_model) THEN
  RETURN p_model;
 END IF;
 SELECT alias INTO a FROM model_usage_aliases WHERE model=p_model;
 IF a IS NULL THEN
  INSERT INTO model_usage_aliases(alias,model)
  VALUES('m_'||substr(replace(gen_random_uuid()::text,'-',''),1,16),p_model) ON CONFLICT(model) DO NOTHING;
  SELECT alias INTO a FROM model_usage_aliases WHERE model=p_model;
 END IF;
 RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.model_usage_metadata(m jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(m) IS DISTINCT FROM 'object' THEN RETURN m;END IF;
 IF jsonb_typeof(m->'modelId')='string' THEN m:=jsonb_set(m,'{modelId}',to_jsonb(model_usage_alias(m->>'modelId')));END IF;
 IF jsonb_typeof(m->'pricing')='object' THEN
  IF jsonb_typeof(m#>'{pricing,modelId}')='string' THEN
   m:=jsonb_set(m,'{pricing,modelId}',to_jsonb(model_usage_alias(m#>>'{pricing,modelId}')));END IF;
  IF jsonb_typeof(m#>'{pricing,providerModel}')='string' THEN
   m:=jsonb_set(m,'{pricing,providerModel}',to_jsonb(model_usage_alias(m#>>'{pricing,providerModel}')));END IF;
 END IF;
 RETURN m;
END $$;

-- Runs between aa_erasure_usage_unlink and zz_erasure_ledger_guard; idempotent on aliased values.
CREATE OR REPLACE FUNCTION public.token_stats_model_alias() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 NEW.model_used:=model_usage_alias(NEW.model_used);
 NEW.metadata:=model_usage_metadata(NEW.metadata);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mm_token_stats_model_alias ON public.token_stats;
CREATE TRIGGER mm_token_stats_model_alias BEFORE INSERT OR UPDATE ON public.token_stats
 FOR EACH ROW EXECUTE FUNCTION public.token_stats_model_alias();

ALTER FUNCTION public.model_usage_alias(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.model_usage_alias(text),public.model_usage_metadata(jsonb),
 public.token_stats_model_alias() FROM PUBLIC,anon,authenticated,service_role;
-- Writers reach these through the trigger; service_role writes token_stats in tests and fallbacks.
GRANT EXECUTE ON FUNCTION public.model_usage_alias(text),public.model_usage_metadata(jsonb) TO service_role;

-- Backfill: the trigger rewrites each touched row. Already-aliased rows are not selected.
UPDATE public.token_stats SET model_used=model_used
WHERE (model_used IS NOT NULL AND model_used<>'' AND model_used !~ '^m_[0-9a-f]{16}$')
   OR (jsonb_typeof(metadata->'modelId')='string' AND metadata->>'modelId' !~ '^m_[0-9a-f]{16}$')
   OR (jsonb_typeof(metadata#>'{pricing,modelId}')='string' AND metadata#>>'{pricing,modelId}' !~ '^m_[0-9a-f]{16}$')
   OR (jsonb_typeof(metadata#>'{pricing,providerModel}')='string'
       AND metadata#>>'{pricing,providerModel}' !~ '^m_[0-9a-f]{16}$');

COMMIT;
