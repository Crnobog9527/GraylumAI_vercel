-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Service-only inventory; billing claims, receipts and ledger remain authoritative.
BEGIN;
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure))
  <> '8b4ef3b787caf790ab5510c61dd07883' THEN
  RAISE EXCEPTION 'RUNTIME_RECOVERY_SOURCE_MISMATCH';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.runtime_pending_financial_batch(
 p_actor_id uuid DEFAULT NULL, p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
  RAISE EXCEPTION 'RUNTIME_RECOVERY_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY last_lookup NULLS FIRST,run_id),'[]'::jsonb) INTO result
 FROM (
  SELECT r.id run_id, pending.last_lookup,
   jsonb_build_object('actorId',r.actor_id,'executionId',e.id,'runId',r.id,
    'finishAllowed',(e.state IN ('cost_pending','cancelled') OR e.result IS NOT NULL),
    'recoveryPolicy',jsonb_build_object('id',r.test_window_id,'expiresAt',r.deadline,
     'creditsPerUsd',r.credits_per_usd::text,'multiplier',r.multiplier::text,
     'callPolicies',r.payload->'callPolicy')) item
  FROM bill2_runs r
  JOIN runtime_executions e ON e.billing_run_id=r.id AND e.actor_id=r.actor_id
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=r.actor_id AND r.session_ref=s.id
  CROSS JOIN LATERAL (
   SELECT min(c.rejection_recovery_at) last_lookup FROM bill2_calls c
   WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL AND c.provider_id IS NOT NULL
    AND c.payload->>'lookupSupported'='true'
    AND (c.selected_cost_usd IS NULL OR (r.contract_version='bill2.v2' AND c.settled_at IS NULL))
    AND clock_timestamp()<=CASE WHEN r.contract_version='bill2.v2'
     THEN c.created_at+interval '24 hours' ELSE r.deadline+interval '24 hours' END
    AND (c.rejection_recovery_at IS NULL OR c.rejection_recovery_at<=clock_timestamp()-interval '60 seconds')
   HAVING count(*)>0 OR (r.closed AND (e.state IN ('cost_pending','cancelled') OR e.result IS NOT NULL)
    AND NOT EXISTS(
    SELECT 1 FROM bill2_calls unknown_call WHERE unknown_call.run_id=r.id
     AND unknown_call.dispatched_at IS NOT NULL AND unknown_call.selected_cost_usd IS NULL)
    AND CASE WHEN r.contract_version='bill2.v2' THEN EXISTS(
     SELECT 1 FROM bill2_calls recent_call WHERE recent_call.run_id=r.id
      AND clock_timestamp()<=recent_call.created_at+interval '24 hours')
     ELSE clock_timestamp()<=r.deadline+interval '24 hours' END)
  ) pending
  WHERE (p_actor_id IS NULL OR r.actor_id=p_actor_id) AND NOT r.conflict
   AND r.state NOT IN ('settled','refunded')
  ORDER BY pending.last_lookup NULLS FIRST,r.id LIMIT p_limit
 ) chosen;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.runtime_pending_financial_batch(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_pending_financial_batch(uuid,integer) TO service_role;
COMMIT;
