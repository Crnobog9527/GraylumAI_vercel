-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Empty-fact rollback only. Erased bodies cannot be restored by schema rollback.
BEGIN;
LOCK TABLE public.bill2_runs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bill2_runs WHERE content_erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ERASURE_RUN_ROLLBACK_REQUIRES_FORWARD_FIX';
  END IF;
END $$;
DROP TRIGGER bill2_run_erasure_guard ON public.bill2_runs;
DROP FUNCTION public.account_erasure_scrub_run(uuid,uuid);
DROP FUNCTION public.bill2_run_erasure_guard();
DROP FUNCTION public.bill2_erasure_run_payload(jsonb);
DROP FUNCTION public.bill2_erasure_fields(jsonb,jsonb);
ALTER TABLE public.bill2_runs DROP CONSTRAINT bill2_run_erasure_facts;
ALTER TABLE public.bill2_runs DROP COLUMN content_erased_at;
ALTER TABLE public.bill2_runs DROP COLUMN original_payload_hash;
COMMIT;
