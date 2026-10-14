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
-- The seeded catalog is the decided one (MASTER_PLAN 2.1 item 51; Owner 2026-10-14: free users get no monthly credits).
DO $$
BEGIN
  IF (SELECT jsonb_agg(jsonb_build_array(level, monthly_price, yearly_price, monthly_credits, yearly_credits,
        monthly_bonus_credits, package_discount, features) ORDER BY sort_order) FROM public.membership_plans)
     <> '[["free",0,0,0,0,0,100,["注册赠送500积分（一次性）"]],["pro",2900,27900,3480,41760,0,95,[]],["gold",6900,62100,8970,107640,0,90,[]]]'::jsonb
  THEN RAISE EXCEPTION 'staging seed catalog mismatch'; END IF;
  -- Only the seed's own packages: the harness's preview fixture adds a synthetic one of its own.
  IF (SELECT jsonb_agg(jsonb_build_array(price, credits_amount, bonus_credits, active::text) ORDER BY sort_order)
        FROM public.credit_packages WHERE id::text LIKE '30000000-0000-4000-8000-00000000000_')
     <> '[[990,990,0,"true"],[2990,2990,0,"true"],[9990,9990,1000,"true"]]'::jsonb
  THEN RAISE EXCEPTION 'staging seed credit packages mismatch'; END IF;
END $$;
