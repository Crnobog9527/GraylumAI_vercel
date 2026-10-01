-- A separate new connection verifies service-role writes do not depend on a warm owner session.
SET ROLE service_role;
UPDATE public.membership_plans SET allow_fusion_review = false, library_storage_bytes = 321 WHERE level = 'gold';
UPDATE public.system_settings SET value = '8'::jsonb WHERE key = 'fusion_compare_max_models';
DO $$ BEGIN
  IF (SELECT library_storage_bytes FROM public.membership_plans WHERE level = 'gold') <> 321
    OR (SELECT allow_fusion_review FROM public.membership_plans WHERE level = 'gold') IS DISTINCT FROM false
    OR (SELECT value FROM public.system_settings WHERE key = 'fusion_compare_max_models') <> '8'::jsonb
    THEN RAISE EXCEPTION 'fresh service write/read rejected'; END IF;
END $$;
