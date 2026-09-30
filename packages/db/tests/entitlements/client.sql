-- Each role's test runs in its own new psql session (runner supplies SET ROLE).
DO $$
BEGIN
  IF (SELECT count(*) FROM public.membership_plans WHERE allow_fusion_compare AND library_storage_bytes >= 0) <> 2
    THEN RAISE EXCEPTION 'public active-plan entitlement read denied'; END IF;
  BEGIN
    UPDATE public.membership_plans SET allow_fusion_compare = true WHERE level = 'free';
    RAISE EXCEPTION 'client membership write accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.system_settings SET value = '8'::jsonb WHERE key = 'fusion_compare_max_models';
    RAISE EXCEPTION 'client system setting write accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
