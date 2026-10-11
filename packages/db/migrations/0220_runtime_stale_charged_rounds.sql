-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Daily backstop (Owner 2026-10-12, fallback A): a read-only report of PAYG rounds still open
-- after the cutoff whose settled calls charged credits, with no call of unknown outcome and no
-- operator refund marked `stale-round:<runId>`. service_role has no direct access to these
-- tables (0105/0106), so the daily reconciliation reads them only through this function.
-- Every filter runs before the limit; `total` counts all matches so a truncated page is visible.
-- No data is changed. No remote database use.
BEGIN;
CREATE OR REPLACE FUNCTION public.runtime_stale_charged_rounds(p_cutoff timestamptz, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_cutoff IS NULL OR p_cutoff>clock_timestamp() THEN RAISE EXCEPTION 'STALE_ROUND_CUTOFF_INVALID' USING ERRCODE='22023';END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'STALE_ROUND_LIMIT_INVALID' USING ERRCODE='22023';END IF;
 WITH charged AS (
  SELECT e.id execution_id,r.id run_id,e.created_at since,
   (SELECT coalesce(sum(c.charged_delta),0) FROM bill2_calls c WHERE c.run_id=r.id
     AND c.settled_at IS NOT NULL AND c.compensated_at IS NULL AND c.charged_delta>0)::integer credits
  FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
  WHERE e.state IN ('prepared','running','interrupted') AND e.created_at<p_cutoff
   AND r.contract_version='bill2.v2' AND NOT r.closed
   AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id
     AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND NOT c.provider_rejected)
   AND NOT EXISTS(SELECT 1 FROM credit_transactions t WHERE t.user_id=e.actor_id AND t.amount>0
     AND (t.idempotency_key LIKE 'admin\_adjustment:%stale-round:'||r.id::text
      OR t.description LIKE '%stale-round:'||r.id::text||'%'))
 ), found AS (
  SELECT *,row_number() OVER (ORDER BY since,run_id) n FROM charged WHERE credits>0
 )
 SELECT jsonb_build_object('total',count(*),'rounds',coalesce(jsonb_agg(jsonb_build_object(
   'executionId',execution_id,'runId',run_id,'chargedCredits',credits,'since',since) ORDER BY n)
   FILTER (WHERE n<=p_limit),'[]'::jsonb)) INTO result FROM found;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.runtime_stale_charged_rounds(timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_stale_charged_rounds(timestamptz,integer) TO service_role;
COMMIT;
