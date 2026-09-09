-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Settings writes recheck the raw administrator deletion flag. Hardened
-- environments grant profile SELECT by column and previously omitted this flag.
-- Add only the missing server read; preserve client grants and all write guards.
BEGIN;
GRANT SELECT (is_deleted) ON TABLE public.profiles TO service_role;
COMMIT;
-- Idempotent; no rows, existing grants, RLS policies or functions are changed.
-- Recovery: REVOKE SELECT (is_deleted) ON public.profiles FROM service_role;
-- Recovery preserves data but settings saves fail closed again on hardened hosts.
