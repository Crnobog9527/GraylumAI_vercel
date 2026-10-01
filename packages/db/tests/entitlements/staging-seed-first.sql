-- Only run by the disposable local harness after 0153 and the real staging seed.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.membership_plans) <> 3 OR EXISTS (
    SELECT 1 FROM public.membership_plans WHERE
      allow_fusion_review <> (level <> 'free') OR allow_fusion_compare <> (level <> 'free') OR
      library_storage_bytes <> CASE level WHEN 'free' THEN 50000000 WHEN 'pro' THEN 500000000 ELSE 2000000000 END
  ) THEN RAISE EXCEPTION 'staging seed D4 mismatch'; END IF;
END $$;
-- Simulate an existing plan with a different id plus administrator edits.
UPDATE public.membership_plans SET id = '00000000-0000-4000-8000-00000000e022',
  allow_fusion_review = false, allow_fusion_compare = false, library_storage_bytes = 123 WHERE level = 'pro';
