-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-BASELINE (0148) rollback ONLY for staging as fingerprinted on 2026-09-30.
-- On staging 0148 re-creates 14 policies with identical definitions, re-issues GRANTs it already
-- holds and installs the 0027 profile credit guard; only the guard is new, so only it is removed.
-- Separately authorize remote use.
BEGIN;
DROP TRIGGER IF EXISTS trg_prevent_client_profile_credit_write ON public.profiles;
DROP FUNCTION IF EXISTS public.prevent_client_profile_credit_write();
COMMIT;
