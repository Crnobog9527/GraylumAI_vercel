-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
LOCK TABLE public.bill2_calls IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bill2_calls WHERE content_erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ERASURE_CALL_ROLLBACK_REQUIRES_FORWARD_FIX';
  END IF;
END $$;
DROP TRIGGER bill2_call_erasure_guard ON public.bill2_calls;
DROP FUNCTION public.account_erasure_scrub_calls(uuid,uuid);
DROP FUNCTION public.bill2_call_erasure_guard();
DROP FUNCTION public.bill2_erasure_call_payload(jsonb);
ALTER TABLE public.bill2_calls DROP COLUMN content_erased_at;
COMMIT;
