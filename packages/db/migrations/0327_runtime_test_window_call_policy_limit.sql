/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- RUNTIME-PROD: staging test windows may hold up to 32 call policies.
-- Production does not use test windows; this changes no production admission or billing rules.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $migration$
DECLARE current_definition text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO current_definition
 FROM pg_constraint
 WHERE conrelid='public.runtime_test_windows'::regclass
  AND conname='runtime_test_windows_call_policies_check';
 IF current_definition LIKE '%jsonb_array_length(call_policies) <= 32%' THEN RETURN; END IF;
 IF current_definition NOT LIKE '%jsonb_array_length(call_policies) <= 16%' THEN
  RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_CALL_POLICIES_CONSTRAINT_MISMATCH';
 END IF;
 ALTER TABLE public.runtime_test_windows
  DROP CONSTRAINT runtime_test_windows_call_policies_check;
 ALTER TABLE public.runtime_test_windows
  ADD CONSTRAINT runtime_test_windows_call_policies_check
  CHECK(jsonb_typeof(call_policies)='array' AND jsonb_array_length(call_policies) BETWEEN 1 AND 32);
END $migration$;

COMMIT;
