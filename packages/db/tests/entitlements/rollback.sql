-- LOCAL-ONLY recovery drill. A real rollback needs controller/Owner approval and a config backup.
-- Roll back application code first; this drops only the new configuration, not membership facts.
BEGIN;
ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_fusion_compare_max_models_check;
DELETE FROM public.system_settings WHERE key = 'fusion_compare_max_models';
ALTER TABLE public.membership_plans
  DROP COLUMN IF EXISTS allow_fusion_review,
  DROP COLUMN IF EXISTS allow_fusion_compare,
  DROP COLUMN IF EXISTS library_storage_bytes;
COMMIT;
