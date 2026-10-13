-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MODEL-IDENTITY-GUARD layer 4. Allocation: controller 2026-10-12 (0217, after 0216).
-- Signed-in clients must not read real model names or provider model ids through the
-- database API (Owner: the data never carries real names).
--  1. ai_models: 0142 left every column except api_key client-readable; revoke them all.
--     No client code reads ai_models; the server uses service_role (unchanged).
--  2. token_stats stays client-readable for own rows (0148 grants table SELECT and must
--     stay a no-op on re-apply), so its model fields store an opaque alias instead:
--     model_used, every metadata value naming a model vendor/route, and the metadata
--     model-id fields become "m_<16 hex>". The alias map is server-only; admin reports resolve it.
--     A BEFORE trigger aliases every write; existing rows are backfilled below.
-- Re-running is a no-op (aliases are idempotent; the backfill selects unaliased rows only).
-- Recovery: forward only. To restore real strings, drop the trigger and run
-- packages/db/tests/model-identity-redact/rollback.sql (the map keeps every aliased original).
-- Not restorable: legacy count_source/preflight_count_source vendor values (non-financial counter
-- labels with no reader) are normalised to provider_usage; token and credit figures are unchanged.
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

-- Every value naming a model vendor, model family or route provider is aliased, anywhere in the
-- metadata (legacy rows carry e.g. count_method "gemini_count_tokens", tokenizer names, routing
-- reasons). The known model-id fields are aliased whatever they say. search_evidence is public
-- search provenance shown to the user by design; it is kept.
CREATE OR REPLACE FUNCTION public.model_usage_vendor_pattern() RETURNS text
LANGUAGE sql IMMUTABLE AS $p$
 SELECT '(claude|anthropic|openai|chat ?gpt|gpt[-_ ]?[0-9]|\mgpt\M|\mo[134](-mini|-pro)?\M|gemini|google|deepmind|bard|'
  ||'qwen|tongyi|alibaba|deepseek|llama|meta-llama|mistral|mixtral|grok|x-ai|\mxai\M|openrouter|deepinfra|'
  ||'together|fireworks|groq|novita|azure|bedrock|vertex|moonshot|kimi|zhipu|chatglm|\mglm|z-ai|doubao|'
  ||'bytedance|baidu|ernie|hunyuan|tencent|minimax|cohere|perplexity|nvidia|nemotron|phi-[0-9]|'
  ||'通义|千问|文心|豆包|混元|智谱|深度求索|月之暗面)'
$p$;

CREATE OR REPLACE FUNCTION public.model_usage_jsonb(v jsonb,p_model_field boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text;x jsonb;o jsonb;pattern text:=model_usage_vendor_pattern();
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'string' THEN
  IF p_model_field OR (v#>>'{}') ~* pattern THEN RETURN to_jsonb(model_usage_alias(v#>>'{}'));END IF;
  RETURN v;
 WHEN 'object' THEN
  o:='{}'::jsonb;
  FOR k,x IN SELECT key,value FROM jsonb_each(v) LOOP
   -- Erasure keeps these two as a fixed list (0188) that names vendors; an alias would make the
   -- ledger row unerasable, so a vendor-specific counter becomes the neutral listed provider_usage.
   IF k IN ('count_source','preflight_count_source') AND jsonb_typeof(x)='string' AND (x#>>'{}') ~* pattern THEN
    o:=o||jsonb_build_object(k,'provider_usage');CONTINUE;
   END IF;
   -- Keys stay as written: erasure keeps listed keys (e.g. provider_usage.openRouterCost, a cost
   -- record) and would drop a renamed one. Keys name the route, never the model.
   o:=o||jsonb_build_object(k,
    CASE WHEN k='search_evidence' THEN x ELSE model_usage_jsonb(x,k IN ('modelId','providerModel','model','modelUsed')) END);
  END LOOP;
  RETURN o;
 WHEN 'array' THEN
  SELECT coalesce(jsonb_agg(model_usage_jsonb(e) ORDER BY n),'[]'::jsonb) INTO o
  FROM jsonb_array_elements(v) WITH ORDINALITY AS t(e,n);
  RETURN o;
 ELSE RETURN v;
 END CASE;
END $$;

CREATE OR REPLACE FUNCTION public.model_usage_metadata(m jsonb) RETURNS jsonb
LANGUAGE sql SET search_path=public,pg_temp AS $$ SELECT model_usage_jsonb(m) $$;

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
 public.model_usage_jsonb(jsonb,boolean),public.model_usage_vendor_pattern(),
 public.token_stats_model_alias() FROM PUBLIC,anon,authenticated,service_role;
-- Writers reach these through the trigger; service_role writes token_stats in tests and fallbacks.
GRANT EXECUTE ON FUNCTION public.model_usage_alias(text),public.model_usage_metadata(jsonb),
 public.model_usage_jsonb(jsonb,boolean),public.model_usage_vendor_pattern() TO service_role;

-- Backfill: the trigger rewrites each touched row. Rows already fully aliased are not selected.
UPDATE public.token_stats SET model_used=model_used
WHERE (model_used IS NOT NULL AND model_used<>'' AND model_used !~ '^m_[0-9a-f]{16}$')
   OR (metadata IS NOT NULL AND (metadata - 'search_evidence')::text ~* model_usage_vendor_pattern());

COMMIT;
