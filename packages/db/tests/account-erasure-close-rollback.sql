-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-A rollback. Refuses once any account was closed: rolling back would let a closed
-- profile (status='deleted') be treated as usable by older code. Separately authorize remote use.
BEGIN;
DO $$
DECLARE
  rel record;
BEGIN
  IF to_regclass('public.account_erasure_requests') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.account_erasure_requests) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ROLLBACK_REFUSED: closed accounts exist';
  END IF;
  FOR rel IN
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'account_open_required'
  LOOP
    EXECUTE format('DROP POLICY account_open_required ON public.%I', rel.tablename);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS account_erasure_profile_guard ON public.profiles;
DROP FUNCTION IF EXISTS public.account_erasure_note_error(uuid, text);
DROP FUNCTION IF EXISTS public.account_erasure_confirm(uuid, uuid);
DROP FUNCTION IF EXISTS public.account_erasure_preview(uuid);
DROP FUNCTION IF EXISTS public.account_erasure_renewing(uuid);
DROP FUNCTION IF EXISTS public.account_erasure_profile_guard();
DROP FUNCTION IF EXISTS public.current_account_is_closed();
DROP TABLE IF EXISTS public.account_erasure_requests;
COMMIT;
