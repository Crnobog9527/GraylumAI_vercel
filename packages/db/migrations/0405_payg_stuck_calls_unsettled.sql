-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-PERF (number 0405 provisional; the controller assigns the final one before it goes to staging).
-- bill2_payg_stuck_calls (daily reconciliation alert, admin page) called bill2_payg_call_stuck for every call of every
-- run, twice (count and list): 2.3 s on staging, and the 2026-10-27 04:00 reconciliation reported scanFailed when it
-- collided with other work. The call can only be stuck while it is dispatched, unsettled, without a selected cost and not
-- rejected, and its run is cost_pending: a handful of rows next to the whole history.
-- This migration (1) adds the partial index bill2_calls_payg_unsettled on exactly the clock-independent call conditions and
-- (2) repeats those conditions (plus r.state='cost_pending') in both queries of bill2_payg_stuck_calls before the
-- predicate, so the planner reads only the unsettled calls. bill2_payg_call_stuck itself is unchanged and still decides
-- every row (time threshold, contract version, conflict flag); result shape and ordering are unchanged.
-- Compatibility: same signature, result and privileges; old and new application code are interchangeable.
-- Repeatable: CREATE INDEX IF NOT EXISTS and CREATE OR REPLACE only; no data change.
-- Recovery: DROP INDEX bill2_calls_payg_unsettled and re-apply bill2_payg_stuck_calls from packages/db/functions as of 0404
-- (slower, same results).
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS bill2_calls_payg_unsettled ON public.bill2_calls (dispatched_at, id)
 WHERE call_kind='model' AND dispatched_at IS NOT NULL AND settled_at IS NULL AND selected_cost_usd IS NULL AND NOT provider_rejected;

CREATE OR REPLACE FUNCTION public.bill2_payg_stuck_calls(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE total bigint;calls jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'BILL2_STUCK_CALLS_DENIED';END IF;
 -- 0405: the conditions of bill2_payg_call_stuck that do not depend on the clock come first and use the partial index
 -- bill2_calls_payg_unsettled, so only calls still waiting for a cost are examined; the predicate still decides each one.
 SELECT count(*) INTO total FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
  WHERE c.call_kind='model' AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND c.selected_cost_usd IS NULL AND NOT c.provider_rejected AND r.state='cost_pending' AND bill2_payg_call_stuck(c,r);
 -- Content-free evidence only: statuses and reasons, never bodies or conversation text.
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'dispatchedAt'),'[]') INTO calls FROM (
  SELECT jsonb_build_object('callId',c.id,'runId',r.id,'actorId',r.actor_id,'model',c.model,'phase',c.payload->>'phase',
   'upperUsd',c.upper_usd,'reservedCredits',c.reserved_credits,'dispatchedAt',c.dispatched_at,
   'recoveryDeadline',c.recovery_deadline,'recoveryAttempts',c.recovery_attempts,'fusionVerdict',c.fusion_verdict,
   'receipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('source',rc.payload->>'source',
     'httpStatus',CASE WHEN rc.payload#>>'{transport,httpStatus}' ~ '^[1-5][0-9]{2}$' THEN (rc.payload#>>'{transport,httpStatus}')::integer END,
     'rejectedReason',rc.payload->>'rejectedReason','observedAt',rc.created_at) ORDER BY rc.created_at),'[]')
    FROM bill2_receipts rc WHERE rc.call_id=c.id)) x
  FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
  WHERE c.call_kind='model' AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND c.selected_cost_usd IS NULL AND NOT c.provider_rejected AND r.state='cost_pending' AND bill2_payg_call_stuck(c,r)
  ORDER BY c.dispatched_at LIMIT p_limit) s;
 RETURN jsonb_build_object('total',total,'calls',calls);
END $function$;

COMMIT;
