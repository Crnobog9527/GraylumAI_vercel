-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MODEL-IDENTITY-GUARD 0217 recovery (only with Owner approval): restore real model strings in
-- token_stats from the server-only alias map, walking the whole metadata JSON (0217 aliases values
-- at any depth). The ai_models client revoke is kept on purpose. Not restorable by design:
-- count_source / preflight_count_source vendor values that 0217 normalised to provider_usage.
BEGIN;
DROP TRIGGER IF EXISTS mm_token_stats_model_alias ON public.token_stats;
CREATE FUNCTION pg_temp.model_usage_restore(v jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE k text;x jsonb;o jsonb;real text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'string' THEN
  IF (v#>>'{}') ~ '^m_[0-9a-f]{16}$' THEN
   SELECT model INTO real FROM public.model_usage_aliases WHERE alias=v#>>'{}';
   IF real IS NOT NULL THEN RETURN to_jsonb(real);END IF;
  END IF;
  RETURN v;
 WHEN 'object' THEN
  o:='{}'::jsonb;
  FOR k,x IN SELECT key,value FROM jsonb_each(v) LOOP o:=o||jsonb_build_object(k,pg_temp.model_usage_restore(x));END LOOP;
  RETURN o;
 WHEN 'array' THEN
  SELECT coalesce(jsonb_agg(pg_temp.model_usage_restore(e) ORDER BY n),'[]'::jsonb) INTO o
  FROM jsonb_array_elements(v) WITH ORDINALITY AS t(e,n);
  RETURN o;
 ELSE RETURN v;
 END CASE;
END $$;
UPDATE public.token_stats t
SET model_used=coalesce((SELECT a.model FROM public.model_usage_aliases a WHERE a.alias=t.model_used),t.model_used),
    metadata=pg_temp.model_usage_restore(t.metadata)
WHERE t.model_used ~ '^m_[0-9a-f]{16}$' OR t.metadata::text ~ 'm_[0-9a-f]{16}';
COMMIT;
