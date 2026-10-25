-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-PERF: one lock order for the staging test window and the stop-loss key.
--
-- A claim locks the test window row (runtime_test_window_allowed, FOR UPDATE) and then takes the stop-loss key (201,1)
-- shared in the bill2_calls insert trigger. A dispatch updates dispatched_at; its BEFORE UPDATE triggers fire in name
-- order, so runtime_stop_loss_call_guard (takes (201,1) shared) ran before runtime_test_dispatch_guard (locks the
-- window row): the opposite order. A settlement waiting for (201,1) exclusive blocks later shared requests, which
-- closes the cycle claim -> settlement -> dispatch -> claim (deadlock 40P01 at 75 concurrent users on staging).
-- Production has no test window row, so this only affects staging. The old per-model exclusive lock hid it.
--
-- The trigger is renamed so it fires first: window row, then (201,1), in both paths. Function body unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.bill2_calls'::regclass AND NOT tgisinternal
  AND tgname IN ('runtime_test_dispatch_guard','runtime_a_test_dispatch_guard'))<>1 THEN
  RAISE EXCEPTION 'DB_PERF_0399_ANCHOR_MISSING: runtime_test_dispatch_guard trigger';END IF;
END $$;
DROP TRIGGER IF EXISTS runtime_test_dispatch_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_a_test_dispatch_guard ON public.bill2_calls;
CREATE TRIGGER runtime_a_test_dispatch_guard BEFORE UPDATE OF dispatched_at ON public.bill2_calls
 FOR EACH ROW EXECUTE FUNCTION public.runtime_test_dispatch_guard();
COMMIT;
