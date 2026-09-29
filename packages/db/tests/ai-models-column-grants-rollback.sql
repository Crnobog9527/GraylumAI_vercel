-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- STAGING RECOVERY ONLY: restores S1 ACL-02 SELECT posture, reopening B01.
-- Do not apply without separate Owner authorization.
BEGIN;
REVOKE SELECT ON TABLE public.ai_models FROM PUBLIC, anon, authenticated;
DO $$
DECLARE columns_sql text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_sql
  FROM pg_attribute WHERE attrelid = 'public.ai_models'::regclass
    AND attnum > 0 AND NOT attisdropped;
  EXECUTE format(
    'REVOKE SELECT (%s) ON TABLE public.ai_models FROM PUBLIC, anon, authenticated', columns_sql
  );
END $$;
GRANT SELECT ON TABLE public.ai_models TO authenticated;
COMMIT;
