-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B01: keep model credentials server-only. No RLS, data or service_role changes.
BEGIN;

REVOKE SELECT ON TABLE public.ai_models FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  all_columns text;
  safe_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum),
         string_agg(quote_ident(attname), ', ' ORDER BY attnum)
           FILTER (WHERE attname <> 'api_key')
  INTO all_columns, safe_columns
  FROM pg_attribute
  WHERE attrelid = 'public.ai_models'::regclass
    AND attnum > 0 AND NOT attisdropped;

  -- Table revocation alone leaves historical column grants in place.
  EXECUTE format(
    'REVOKE SELECT (%s) ON TABLE public.ai_models FROM PUBLIC, anon, authenticated',
    all_columns
  );
  EXECUTE format(
    'GRANT SELECT (%s) ON TABLE public.ai_models TO authenticated', safe_columns
  );
END $$;

COMMIT;
