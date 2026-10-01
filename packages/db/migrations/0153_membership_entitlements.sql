-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ENTITLEMENTS PR-1. Append after 0152; not yet applied, per controller approval.
-- Add configuration to the existing authorities; do not change membership/payment facts.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.membership_plans WHERE level IS NULL OR level NOT IN ('free','pro','gold'))
    OR EXISTS (SELECT 1 FROM public.membership_plans GROUP BY level HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ENTITLEMENTS_PLAN_CONFIGURATION_REQUIRES_REVIEW';
  END IF;
END $$;

ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS allow_fusion_review boolean,
  ADD COLUMN IF NOT EXISTS allow_fusion_compare boolean,
  ADD COLUMN IF NOT EXISTS library_storage_bytes bigint;

-- Fill only missing values, including on a repeated application; never reset admin edits.
UPDATE public.membership_plans
SET allow_fusion_review = COALESCE(allow_fusion_review, level <> 'free'),
    allow_fusion_compare = COALESCE(allow_fusion_compare, level <> 'free'),
    library_storage_bytes = COALESCE(library_storage_bytes,
      CASE level WHEN 'free' THEN 50000000 WHEN 'pro' THEN 500000000 WHEN 'gold' THEN 2000000000 END)
WHERE allow_fusion_review IS NULL OR allow_fusion_compare IS NULL OR library_storage_bytes IS NULL;

ALTER TABLE public.membership_plans
  ALTER COLUMN allow_fusion_review SET NOT NULL,
  ALTER COLUMN allow_fusion_compare SET NOT NULL,
  ALTER COLUMN library_storage_bytes SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.membership_plans'::regclass
                 AND conname = 'membership_plans_level_key') THEN
    ALTER TABLE public.membership_plans ADD CONSTRAINT membership_plans_level_key UNIQUE (level);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.membership_plans'::regclass
                 AND conname = 'membership_plans_library_storage_bytes_check') THEN
    ALTER TABLE public.membership_plans ADD CONSTRAINT membership_plans_library_storage_bytes_check
      CHECK (library_storage_bytes BETWEEN 0 AND 9007199254740991);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.system_settings'::regclass
                 AND conname = 'system_settings_fusion_compare_max_models_check') THEN
    ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_fusion_compare_max_models_check
      CHECK (key <> 'fusion_compare_max_models' OR
        (value IS NOT NULL AND jsonb_typeof(value) = 'number'
          AND CASE WHEN jsonb_typeof(value) = 'number' THEN
            (value::text)::numeric BETWEEN 2 AND 8 AND mod((value::text)::numeric, 1) = 0
          ELSE false END));
  END IF;
END $$;

INSERT INTO public.system_settings (key, value)
VALUES ('fusion_compare_max_models', '4'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- D3 is intentionally public for selector display; expose this key only.
-- Reuse the key-scoped SELECT policy pattern from 0075; no client write grant.
DROP POLICY IF EXISTS system_settings_select_fusion_compare ON public.system_settings;
CREATE POLICY system_settings_select_fusion_compare ON public.system_settings
  FOR SELECT TO anon, authenticated USING (key = 'fusion_compare_max_models');

COMMIT;
