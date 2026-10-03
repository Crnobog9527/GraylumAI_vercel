DO $$
BEGIN
  IF (SELECT value FROM public.system_settings WHERE key = 'fusion_compare_max_models') <> '4'::jsonb
    THEN RAISE EXCEPTION 'D3 default'; END IF;
  IF EXISTS (SELECT 1 FROM public.membership_plans WHERE
      allow_fusion_review <> (level <> 'free') OR allow_fusion_compare <> (level <> 'free') OR
      library_storage_bytes <> CASE level WHEN 'free' THEN 50000000 WHEN 'pro' THEN 500000000 ELSE 2000000000 END)
    THEN RAISE EXCEPTION 'D4 defaults'; END IF;
  IF (SELECT monthly_price FROM public.membership_plans WHERE level = 'pro') <> 990
    OR (SELECT monthly_credits FROM public.membership_plans WHERE level = 'pro') <> 200
    OR (SELECT allow_export FROM public.membership_plans WHERE level = 'pro') <> 'true'
    THEN RAISE EXCEPTION 'unrelated fields changed'; END IF;
END $$;

SET ROLE service_role;
UPDATE public.membership_plans SET allow_fusion_review = false, library_storage_bytes = 123 WHERE level = 'pro';
UPDATE public.system_settings SET value = '8'::jsonb WHERE key = 'fusion_compare_max_models';
DO $$
DECLARE invalid_value jsonb;
BEGIN
  IF (SELECT library_storage_bytes FROM public.membership_plans WHERE level = 'pro') <> 123
    THEN RAISE EXCEPTION 'service write/read'; END IF;
  FOREACH invalid_value IN ARRAY ARRAY['1'::jsonb,'9','2.5','"4"','true','[]','{}','null',NULL] LOOP
    BEGIN
      UPDATE public.system_settings SET value = invalid_value WHERE key = 'fusion_compare_max_models';
      RAISE EXCEPTION 'invalid D3 accepted';
    EXCEPTION WHEN check_violation OR not_null_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE public.membership_plans SET library_storage_bytes = -1 WHERE level = 'pro';
    RAISE EXCEPTION 'negative bytes accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.membership_plans SET library_storage_bytes = 9007199254740992 WHERE level = 'pro';
    RAISE EXCEPTION 'unsafe integer accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.membership_plans SET allow_fusion_review = NULL WHERE level = 'pro';
    RAISE EXCEPTION 'null permission accepted';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
  UPDATE public.membership_plans SET library_storage_bytes = 0 WHERE level = 'free';
  UPDATE public.membership_plans SET library_storage_bytes = 9007199254740991 WHERE level = 'gold';
  UPDATE public.system_settings SET value = '2'::jsonb WHERE key = 'fusion_compare_max_models';
  UPDATE public.system_settings SET value = '8'::jsonb WHERE key = 'fusion_compare_max_models';
END $$;
RESET ROLE;

-- The database, not a preflight read, arbitrates duplicate inserts and tier moves.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.membership_plans (name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES ('duplicate','pro',true,true,500000000);
    RAISE EXCEPTION 'duplicate level accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE public.membership_plans SET level = 'gold' WHERE level = 'pro';
    RAISE EXCEPTION 'occupied tier move accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE public.membership_plans SET name = 'Renamed', is_active = 'false' WHERE level = 'pro';
  IF (SELECT count(*) FROM public.membership_plans WHERE level = 'pro' AND name = 'Renamed' AND is_active = 'false') <> 1
    THEN RAISE EXCEPTION 'rename/off-sale failed'; END IF;
  -- Restore catalog visibility before the separate anon/authenticated ACL probes.
  UPDATE public.membership_plans SET is_active = 'true' WHERE level = 'pro';
END $$;
