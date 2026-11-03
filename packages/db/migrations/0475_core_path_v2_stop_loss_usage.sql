-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B10: runtime_stop_loss_usage also counts the core-path tables, so the admin stop-loss page and the threshold alerts
-- (runtime_stop_loss_observe) see the new path's spend. Until batch F removes the old BILL2 path, its part stays exactly as it was (the
-- old call guard, runtime_stop_loss_call_guard -> runtime_stop_loss_assert, still reads this function): the result is the old ledger figure
-- (credit_transactions rows with reason_code='bill2_release') PLUS the new path's. Same signature and keys; one key is new (reservedUsd).
--   siteUsd     = old BILL2 settled cost of today (UTC) + daily_spend.spent_usd of the day (all buckets): the known provider cost of the
--                 calls of core-path turns that already closed (turn_close adds it). It does NOT include calls still in flight.
--   reservedUsd = daily_spend.reserved_usd of the day: the upper bounds still held for open core-path turns and for calls whose cost is
--                 unknown. It is not spent money and is reported apart so a page never shows a reservation as spent.
--   userUsd     = the account's old BILL2 figure + the account's closed core-path turns' known cost of the day, with the formula turn_close
--                 uses for daily_spend (turn_call_spent_usd for ok calls, actual_usd for unusable ones) so the sum of the accounts never
--                 falls below the site figure. a = null gives the old zero plus nothing.
-- Read-only (STABLE; SECURITY DEFINER because service_role cannot read the core-path tables directly). Compatible: same signature, same
-- keys plus one. Repeatable: CREATE OR REPLACE. Recovery: re-apply the 0202 text of the function.
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
 ), old AS (
  SELECT coalesce(sum((t.metadata->>'providerCostUsd')::numeric) FILTER(WHERE t.user_id=a),0) AS user_usd,
   coalesce(sum((t.metadata->>'providerCostUsd')::numeric),0) AS site_usd
  FROM day LEFT JOIN credit_transactions t ON
   t.reason_code='bill2_release' AND t.metadata->>'providerCostUsd' IS NOT NULL
   AND t.created_at >= (day.utc_date::timestamp AT TIME ZONE 'UTC')
   AND t.created_at < ((day.utc_date+1)::timestamp AT TIME ZONE 'UTC')
 )
 SELECT jsonb_build_object('utcDate',day.utc_date,
  'userUsd',(old.user_usd+coalesce((SELECT sum(CASE WHEN k.status='ok' THEN turn_call_spent_usd(k.call_kind,k.nominal_usd,k.actual_usd)
      WHEN k.status='unusable' THEN k.actual_usd END) FROM turns t
    JOIN turn_calls k ON k.actor_id=t.actor_id AND k.turn_id=t.id
    WHERE a IS NOT NULL AND t.actor_id=a AND t.state='closed' AND (t.policy->>'day')::date=day.utc_date),0))::text,
  'siteUsd',(old.site_usd+coalesce((SELECT sum(s.spent_usd) FROM daily_spend s WHERE s.day=day.utc_date),0))::text,
  'reservedUsd',coalesce((SELECT sum(s.reserved_usd) FROM daily_spend s WHERE s.day=day.utc_date),0)::text)
 FROM day, old;
$function$;

-- SECURITY DEFINER because service_role has no direct access to the core-path tables; the grants stay service-only.
REVOKE ALL ON FUNCTION public.runtime_stop_loss_usage(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_stop_loss_usage(uuid) TO service_role;

COMMIT;
