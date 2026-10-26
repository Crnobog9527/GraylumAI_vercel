-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- Independent expected catalog: REL-1-BUILD-PREP §1.3/1.4; MASTER_PLAN §2.1 item 51 F/G/J/S/T.
DO $$ BEGIN
  IF (SELECT jsonb_agg(jsonb_build_array(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
      monthly_bonus_credits,package_discount,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
      allow_publish,own_data_window_days,allow_benchmark_monitor,allow_weekly_auto_review,
      positioning_profile_limit,history_retention_days,is_active,sort_order) ORDER BY sort_order) FROM membership_plans)
    IS DISTINCT FROM '[
      ["Free","free",0,0,0,0,0,100,false,false,50000000,false,0,false,false,1,7,"true",10],
      ["Pro","pro",2900,27900,3480,41760,0,95,false,false,500000000,true,30,false,false,3,30,"true",20],
      ["Gold","gold",6900,62100,8970,107640,0,90,true,true,2000000000,true,90,true,true,6,90,"true",30]
    ]'::jsonb THEN RAISE EXCEPTION 'plan values/types differ'; END IF;
  IF (SELECT jsonb_agg(jsonb_build_array(name,price,credits_amount,bonus_credits,sort_order,is_popular,active)
    ORDER BY sort_order) FROM credit_packages)
    IS DISTINCT FROM '[["积分包 小",990,990,0,1,"false","true"],
      ["积分包 中",2990,2990,0,2,"false","true"],
      ["积分包 大",9990,9990,1000,3,"false","true"]]'::jsonb THEN
    RAISE EXCEPTION 'pack values/types differ'; END IF;
  IF EXISTS (SELECT 1 FROM membership_plans WHERE stripe_monthly_price_id IS NOT NULL OR stripe_yearly_price_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM credit_packages WHERE stripe_price_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM payment_provider_refs)
    OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p)
      IS DISTINCT FROM (SELECT value FROM seed_identities_before) THEN
    RAISE EXCEPTION 'seed created identity/provider mapping'; END IF;
  IF NOT coalesce((model_identity_guard_config()->>'enabled')::boolean,false) THEN
    RAISE EXCEPTION 'identity guard default not enabled'; END IF;
  PERFORM * FROM publish_monitor_quota_period();
END $$;
