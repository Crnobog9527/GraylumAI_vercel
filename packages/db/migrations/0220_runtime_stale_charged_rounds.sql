-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Daily backstop (Owner 2026-10-12, fallback A) for rounds that charged credits but ended without
-- an answer for an unclassified Graylum-side reason. service_role has no direct access to these
-- tables (0105/0106), so the reconciliation and the operator action use only these functions.
--  * runtime_stale_charged_rounds: read-only report of PAYG rounds still open after the cutoff
--    whose settled calls charged credits, with no call of unknown outcome and not stopped by the
--    user. Every filter runs before the limit; `total` counts all matches. Each round carries
--    content-free review evidence: model, whether its output streamed to the user, execution
--    state and reason, calls, output tokens from provider receipts, saved reply length.
--  * runtime_stale_round_compensate: after an operator verified a reported round, closes it as a
--    confirmed failure and lets bill2_finalize compensate each charged call once (compensated_at),
--    the same path fail_platform (0215) uses. Idempotent; a closed round can never be refunded again.
-- No remote database use.
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
     AND c.settled_at IS NOT NULL AND c.compensated_at IS NULL AND c.charged_delta>0)::integer credits,
   e.payload->>'model' model,e.state execution_state,e.unavailable_reason,
   coalesce(e.payload->>'providerRequestFormat','') IN ('serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream') streamed,
   (SELECT count(*) FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL)::integer calls,
   -- Display only (settlement stays on final evidence): a non-final response receipt still shows
   -- generated output when the cost was recovered later from a lookup without token counts.
   (SELECT coalesce(sum((SELECT max(CASE WHEN rec.payload->'usage'->>'outputTokens' ~ '^[0-9]{1,12}$'
      THEN (rec.payload->'usage'->>'outputTokens')::bigint END) FROM bill2_receipts rec
      WHERE rec.call_id=c.id AND NOT rec.conflict AND (rec.payload->>'final'='true' OR rec.payload->>'source'='response'))),0)
    FROM bill2_calls c WHERE c.run_id=r.id)::bigint output_tokens,
   length(coalesce(e.result->>'body',e.primary_result->>'body',''))::integer saved_reply_chars,
   (SELECT max(c.settled_at) FROM bill2_calls c WHERE c.run_id=r.id) last_activity,
   -- How the last answered call ended; `tool_calls` with no later call means the next request never
   -- went out (an unclassified Graylum failure, or content beyond capacity, which is not refunded).
   -- Any validated response receipt carries it; a cost recovered later arrives in a lookup receipt
   -- without the response, so the finish reason is never required to come from the final receipt.
   (SELECT left(rec.payload->'usage'->'sdkResponse'->'choices'->0->>'finish_reason',64) FROM bill2_calls c
     JOIN bill2_receipts rec ON rec.call_id=c.id WHERE c.run_id=r.id AND NOT rec.conflict
     AND rec.payload->>'source'='response' AND rec.payload->'usage'->'sdkResponse'->'choices'->0->>'finish_reason' IS NOT NULL
     ORDER BY c.sequence DESC,rec.created_at DESC,rec.id DESC LIMIT 1) last_finish_reason
  FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
  -- cost_pending: receipt recovery settled the last unknown call but the round was never closed.
  WHERE e.state IN ('prepared','running','interrupted','cost_pending') AND e.created_at<p_cutoff
   AND r.contract_version='bill2.v2' AND NOT r.closed AND NOT r.cancel_requested
   -- Any pause (user stop, insufficient credits, a resumable HTTP budget) is user-side or
   -- resumable, never a Graylum failure to refund. Erased accounts belong to erasure recovery.
   AND r.paused_reason IS NULL
   AND EXISTS(SELECT 1 FROM profiles p WHERE p.id=e.actor_id AND p.is_deleted='false')
   -- Quiet since the cutoff: no live dispatch lease and no call created, sent or settled since.
   AND (r.runtime_dispatch_deadline IS NULL OR r.runtime_dispatch_deadline<clock_timestamp())
   AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND greatest(c.created_at,
     coalesce(c.dispatched_at,c.created_at),coalesce(c.settled_at,c.created_at))>=p_cutoff)
   AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id
     AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND NOT c.provider_rejected)
 ), found AS (
  SELECT *,row_number() OVER (ORDER BY since,run_id) n FROM charged WHERE credits>0
 )
 SELECT jsonb_build_object('total',count(*),'rounds',coalesce(jsonb_agg(jsonb_build_object(
   'executionId',execution_id,'runId',run_id,'chargedCredits',credits,'since',since,
   'evidence',jsonb_build_object('model',model,'streamed',streamed,'executionState',execution_state,
    'unavailableReason',unavailable_reason,'calls',calls,'outputTokens',output_tokens,
    'savedReplyChars',saved_reply_chars,'lastActivityAt',last_activity,'lastFinishReason',last_finish_reason)) ORDER BY n)
   FILTER (WHERE n<=p_limit),'[]'::jsonb)) INTO result FROM found;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.runtime_stale_charged_rounds(timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_stale_charged_rounds(timestamptz,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.runtime_stale_round_compensate(p_run_id uuid, p_cutoff timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;evidence text;
BEGIN
 IF p_run_id IS NULL OR p_cutoff IS NULL OR p_cutoff>clock_timestamp() THEN
  RAISE EXCEPTION 'STALE_ROUND_CUTOFF_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO e FROM runtime_executions WHERE billing_run_id=p_run_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'STALE_ROUND_NOT_FOUND' USING ERRCODE='P0002';END IF;
 -- No active-user admission: a later disabled or banned account is still owed its refund;
 -- bill2_close/bill2_finalize support restricted actors. Erased accounts stay with erasure recovery.
 -- Same lock order as runtime_execution: Session, execution, run.
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=e.id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=p_run_id FOR UPDATE;
 -- A repeated or concurrent request after the compensation returns the original outcome.
 IF b.closed AND b.outcome='confirmed_failure' AND b.result->>'evidenceRef'='stale-round:'||b.id::text THEN
  RETURN jsonb_build_object('state','already_compensated','runId',b.id,'executionId',e.id,'actorId',e.actor_id,
   'executionState',e.state,'compensatedCredits',b.compensation_credits);
 END IF;
 IF b.contract_version<>'bill2.v2' OR b.closed OR b.cancel_requested OR b.paused_reason IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM profiles p WHERE p.id=e.actor_id AND p.is_deleted='false')
  -- A retry just before the operator confirmed revives the round: it must still be quiet.
  OR (b.runtime_dispatch_deadline IS NOT NULL AND b.runtime_dispatch_deadline>=clock_timestamp())
  OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND greatest(c.created_at,
   coalesce(c.dispatched_at,c.created_at),coalesce(c.settled_at,c.created_at))>=p_cutoff)
  OR e.state NOT IN ('prepared','running','interrupted','cost_pending') OR e.created_at>=p_cutoff
  OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id
   AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND NOT c.provider_rejected)
  OR NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id
   AND c.settled_at IS NOT NULL AND c.compensated_at IS NULL AND c.charged_delta>0)
 THEN RAISE EXCEPTION 'STALE_ROUND_NOT_ELIGIBLE' USING ERRCODE='P0001';END IF;
 evidence:='stale-round:'||b.id::text;
 v:=bill2_close(e.actor_id,b.id,'confirmed_failure',jsonb_build_object('kind','confirmed_delivery_failure',
  'evidenceRef',evidence,'evidenceHash',encode(sha256(convert_to(evidence,'UTF8')),'hex')));
 v:=bill2_finalize(e.actor_id,b.id);
 UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'cancelled' ELSE 'cost_pending' END,
  unavailable_reason=CASE WHEN v->>'state' IN ('settled','refunded')
   THEN coalesce(e.unavailable_reason,'platform_review') ELSE e.unavailable_reason END
 WHERE id=e.id RETURNING * INTO e;
 IF e.state='cancelled' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
 SELECT * INTO b FROM bill2_runs WHERE id=b.id;
 RETURN jsonb_build_object('state','compensated','runId',b.id,'executionId',e.id,'actorId',e.actor_id,
  'executionState',e.state,'compensatedCredits',b.compensation_credits);
END $function$;
REVOKE ALL ON FUNCTION public.runtime_stale_round_compensate(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_stale_round_compensate(uuid,timestamptz) TO service_role;
COMMIT;
