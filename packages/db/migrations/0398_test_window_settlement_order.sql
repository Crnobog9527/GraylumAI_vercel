-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-PERF round 3: one lock order for the staging test window row and the stop-loss key (201,1), on the settlement side.
--
-- A claim locks the test window row (runtime_test_window_allowed, FOR UPDATE) and then takes (201,1) shared in the
-- bill2_calls insert trigger; 0389 gave dispatch the same order. A settlement takes (201,1) exclusive first (the
-- bill2_release ledger row trigger, a metering flag, or the tool pending guard) and then updates its bill2_runs row a
-- second time in the same transaction; that update re-checks the test_window_id foreign key, which locks the window row
-- FOR KEY SHARE. Opposite order: claim (window, waits (201,1)) and settlement ((201,1), waits window) deadlock. Reproduced
-- locally with 30-70 concurrent rounds on one shared window (33-69 deadlocks per run); it was the 40P01 in the 75/100
-- user staging load tests. Each of the three (201,1)-exclusive takers now locks the run's window row FOR KEY SHARE before
-- (201,1), the same lock the foreign key check takes later in that transaction.
-- Production has no test window: bill2_runs.test_window_id is NULL there, so the added statement finds no row and locks
-- nothing (one primary-key lookup of bill2_runs). Locally, 100 concurrent production-shaped rounds (no window, 1-2 calls,
-- recovery jobs running, users sharing accounts) produced no deadlock before or after this change.
--
-- Compatibility: function bodies only; signatures, results, error codes and ACLs are unchanged, so old and new code both
-- work. Repeatable: CREATE OR REPLACE only. Recovery: re-apply the previous bodies from packages/db/functions as of 0397.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NEW.reason_code<>'bill2_release' THEN RETURN NEW;END IF;
 IF TG_WHEN='BEFORE' THEN
  -- DB-PERF 0398: the staging test window row before (201,1), as claim and dispatch take them.
  PERFORM 1 FROM runtime_test_windows w JOIN bill2_runs r ON r.test_window_id=w.id WHERE r.id=NEW.bill2_run_id FOR KEY SHARE OF w;
  PERFORM pg_advisory_xact_lock(201,1);
  RETURN NEW;
 END IF;
 -- Reservation-release ledger rows freeze actual provider cost once, including refunded calls.
 -- A disabled/broken monitor cannot prevent financial completion.
 BEGIN PERFORM runtime_stop_loss_observe(NEW.user_id);
 EXCEPTION WHEN OTHERS THEN
  BEGIN
   PERFORM runtime_stop_loss_alert('runtime_stop_loss_monitor_unavailable',jsonb_build_object(
    'dedupeKey',(clock_timestamp() AT TIME ZONE 'UTC')::date::text,'code','RUNTIME_STOP_LOSS_MONITOR_UNAVAILABLE'));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'RUNTIME_STOP_LOSS_MONITOR_UNAVAILABLE';
  END;
 END;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_payg_block_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF (NEW.budget_conflict OR NEW.metering_missing OR NEW.metering_exit) AND NEW.metering_review_audit_id IS NULL
  AND (TG_OP='INSERT' OR NOT ((OLD.budget_conflict OR OLD.metering_missing OR OLD.metering_exit)
   AND OLD.metering_review_audit_id IS NULL)) THEN
  -- DB-PERF 0398: the staging test window row before (201,1), as claim and dispatch take them.
  PERFORM 1 FROM runtime_test_windows w JOIN bill2_runs r ON r.test_window_id=w.id WHERE r.id=NEW.run_id FOR KEY SHARE OF w;
  PERFORM pg_advisory_xact_lock(201,1);
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_tool_pending_guard(p_call_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c bill2_calls;
BEGIN
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id;
  IF c.call_kind<>'tool' OR c.supplier_cost_state IS DISTINCT FROM 'pending' THEN RETURN;END IF;
  -- DB-PERF 0398: the staging test window row before (201,1), as claim and dispatch take them.
  PERFORM 1 FROM runtime_test_windows w JOIN bill2_runs r ON r.test_window_id=w.id WHERE r.id=c.run_id FOR KEY SHARE OF w;
  -- DB-PERF 0362 guard lock: count and flag one guard at a time.
  PERFORM pg_advisory_xact_lock(201,1);
  IF (SELECT count(*) FROM bill2_calls x WHERE x.call_kind='tool' AND x.model=c.model
      -- Counted by when the call became pending (its settlement; this call is not settled yet), not by when it
      -- was created: a call settled as unknown at its recovery deadline may be up to a day old.
      AND x.supplier_cost_state='pending' AND coalesce(x.settled_at,clock_timestamp())>clock_timestamp()-interval '1 hour'
      AND coalesce(x.settled_at,clock_timestamp())>coalesce((SELECT max(l.created_at) FROM user_activity_logs l
        WHERE l.action='bill2_metering_review' AND l.details->>'model'=c.model),'-infinity'::timestamptz))>=5
  THEN UPDATE bill2_calls SET metering_missing=true WHERE id=c.id;END IF;
END $function$;

COMMIT;
