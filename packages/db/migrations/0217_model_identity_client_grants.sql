-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MODEL-IDENTITY-GUARD layer 4. Allocation: controller 2026-10-12 (0217, after 0216).
-- Signed-in clients must not read real model names, provider model ids or prices directly
-- through the database API. 0142 left every ai_models column except api_key readable; no
-- client code reads ai_models any more (the server uses service_role, unchanged).
-- token_stats.model_used is not narrowed here: 0148 (convergence, must stay a no-op on
-- re-apply) grants table-level SELECT on token_stats to authenticated. See PR notes.
-- Recovery: forward only; re-granting these columns exposes provider model ids again.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$
DECLARE model_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO model_columns
  FROM pg_attribute WHERE attrelid='public.ai_models'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE SELECT (%s) ON TABLE public.ai_models FROM PUBLIC, anon, authenticated', model_columns);
  REVOKE SELECT ON TABLE public.ai_models FROM PUBLIC, anon, authenticated;
END $$;

COMMIT;
