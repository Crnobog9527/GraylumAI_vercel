/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Diagnostics for executions that end before any model call (#945 follow-up).
-- failure_code is a stable upper-case code only: no user content, nothing reads it
-- for availability, and runtime_view never returns it. unavailable_reason keeps its
-- meaning (it revokes content/history availability, see 0136) and is not widened.
BEGIN;
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS failure_code text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.runtime_executions'::regclass
  AND conname='runtime_executions_failure_code_check') THEN
  ALTER TABLE public.runtime_executions ADD CONSTRAINT runtime_executions_failure_code_check
   CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{2,80}$');
 END IF;
END $$;

-- fail_before_dispatch also records the code, atomically with the proven pre-dispatch cancellation.
DO $$ DECLARE definition text;a1 text;b1 text;a2 text;b2 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);
 IF position('-- 0248 failure_code' IN definition)=0 THEN
  a1:=$a$  IF p_result IS NOT NULL AND p_result IS DISTINCT FROM '{"unavailable_reason":"provider_history"}'::jsonb THEN
   RAISE EXCEPTION 'RUNTIME_FAILURE_REASON_DENIED';$a$;
  b1:=$b$  -- 0248 failure_code: optional diagnostic code; unavailable_reason remains provider_history only.
  IF p_result IS NOT NULL AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object'
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('unavailable_reason','failure_code'))
   OR (p_result ? 'unavailable_reason' AND p_result->'unavailable_reason' IS DISTINCT FROM '"provider_history"'::jsonb)
   OR (p_result ? 'failure_code' AND (jsonb_typeof(p_result->'failure_code') IS DISTINCT FROM 'string'
    OR p_result->>'failure_code' !~ '^[A-Z][A-Z0-9_]{2,80}$'))) THEN
   RAISE EXCEPTION 'RUNTIME_FAILURE_REASON_DENIED';$b$;
  a2:=$a$    unavailable_reason=coalesce(e.unavailable_reason,p_result->>'unavailable_reason')$a$;
  b2:=a2||$b$,
    failure_code=coalesce(e.failure_code,p_result->>'failure_code')$b$;
  IF (length(definition)-length(replace(definition,a1,'')))/length(a1)<>1
   OR (length(definition)-length(replace(definition,a2,'')))/length(a2)<>1 THEN
   RAISE EXCEPTION 'RUNTIME_EXECUTION_SOURCE_MISMATCH: 0248'; END IF;
  EXECUTE replace(replace(definition,a1,b1),a2,b2);
 END IF;
END $$;

-- Cancellations decided outside the executor (stream policy refusal, closed test window)
-- record their code afterwards. Only a finished, still-visible execution without a code is
-- touched; state, billing and content are never changed.
CREATE OR REPLACE FUNCTION public.runtime_record_failure_code(p_actor_id uuid,p_execution_id uuid,p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_]{2,80}$' THEN RAISE EXCEPTION 'RUNTIME_FAILURE_CODE_INVALID';END IF;
 UPDATE runtime_executions SET failure_code=p_code
 WHERE id=p_execution_id AND actor_id=p_actor_id AND failure_code IS NULL AND state IN ('cancelled','cost_pending')
  AND erased_at IS NULL AND content_deleted_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.runtime_record_failure_code(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_record_failure_code(uuid,uuid,text) TO service_role;
COMMIT;
