DO $$
BEGIN
  IF (SELECT count(*) FROM public.membership_plans) <> 3 OR NOT EXISTS (
    SELECT 1 FROM public.membership_plans WHERE level = 'pro'
      AND id = '00000000-0000-4000-8000-00000000e022'
      AND NOT allow_fusion_review AND NOT allow_fusion_compare AND library_storage_bytes = 123
  ) THEN RAISE EXCEPTION 'staging seed replay changed identity or administrator entitlements'; END IF;
END $$;
