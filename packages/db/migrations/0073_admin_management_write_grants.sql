-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Admin procedures authenticate active admins before using the server-only writer.
-- No client-role DML grants; no data changes. Safe to apply repeatedly.
BEGIN;
GRANT INSERT, UPDATE ON TABLE public.ai_models TO service_role;
GRANT DELETE ON TABLE public.modules TO service_role;
-- Preserve existing legacy rows without rewriting them. Enforce references for
-- new writes and prevent deleting any target still used by a feature card.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.modules'::regclass AND conname='modules_link_module_id_fkey') THEN
    ALTER TABLE public.modules ADD CONSTRAINT modules_link_module_id_fkey
      FOREIGN KEY (link_module_id) REFERENCES public.modules(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
COMMIT;
-- Recovery: revoke these same grants to restore the prior read-only model posture.
