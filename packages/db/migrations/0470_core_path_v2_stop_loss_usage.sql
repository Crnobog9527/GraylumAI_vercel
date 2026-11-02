-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B10: runtime_stop_loss_usage reads the core-path tables instead of the old BILL2 ledger (credit_transactions rows with
-- reason_code='bill2_release'), which the new path never writes, so the admin stop-loss page and the threshold alerts
-- (runtime_stop_loss_observe) would show 0 for every day of the new path. Same signature and the same keys the page reads
-- (utcDate, userUsd, siteUsd); one key is new (reservedUsd).
--   siteUsd     = daily_spend.spent_usd of today's UTC day, all buckets: the known provider cost of the calls of turns that already closed
--                 (turn_close adds it). It does NOT include calls still in flight.
--   reservedUsd = daily_spend.reserved_usd of the day: the upper bounds still held for open turns and for calls whose cost is unknown.
--                 It is not spent money and is reported apart so a page never shows a reservation as spent.
--   userUsd     = the same known cost for the given account (p = null gives 0): turn_calls of the account's turns that closed today.
-- Read-only (STABLE; SECURITY DEFINER because service_role cannot read the core-path tables directly). Compatible: same signature, same keys plus one. Repeatable: CREATE OR REPLACE. Recovery: re-apply the 0202 text of the function.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_usage(a uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH day AS MATERIALIZED (
  SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS utc_date
 )
 SELECT jsonb_build_object('utcDate',day.utc_date,
  'userUsd',coalesce((SELECT sum(coalesce(k.nominal_usd,0)) FROM turns t
    JOIN turn_calls k ON k.actor_id=t.actor_id AND k.turn_id=t.id
    WHERE a IS NOT NULL AND t.actor_id=a AND t.state='closed' AND (t.policy->>'day')::date=day.utc_date),0)::text,
  'siteUsd',coalesce((SELECT sum(s.spent_usd) FROM daily_spend s WHERE s.day=day.utc_date),0)::text,
  'reservedUsd',coalesce((SELECT sum(s.reserved_usd) FROM daily_spend s WHERE s.day=day.utc_date),0)::text)
 FROM day;
$function$;

-- SECURITY DEFINER because service_role has no direct access to the core-path tables; the grants stay service-only.
REVOKE ALL ON FUNCTION public.runtime_stop_loss_usage(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_stop_loss_usage(uuid) TO service_role;

COMMIT;
