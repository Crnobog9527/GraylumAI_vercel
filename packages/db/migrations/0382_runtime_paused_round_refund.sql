-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Owner 2026-10-25 ("暂停回合选 A：超过 24 小时没给回复的那一步自动退"): a round paused for the user (waiting_resume
-- after the HTTP budget, or waiting_credits) whose charged calls never delivered a reply was never refunded: the
-- 24-hour stale-round rule (0220/0284) excluded every paused round as user-side. Both the report and the locked
-- compensation now also take such a round, by the same rule: quiet for 24 hours, no call in flight, charged, account
-- not erased, not content beyond capacity, not a user stop. A round that saved a reply (an organizer still waiting
-- after its primary reply) is never refunded. Compensation closes the round as a confirmed failure, so a later
-- "continue" cannot replay it for free; the user starts again and is charged normally. Idempotent and serialized as
-- before (already_compensated; Session, execution, run lock order). Only these two functions change.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.runtime_stale_charged_rounds(p_cutoff timestamp with time zone, p_limit integer, p_created_since timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE result jsonb;
BEGIN
 IF p_cutoff IS NULL OR p_cutoff>clock_timestamp() THEN RAISE EXCEPTION 'STALE_ROUND_CUTOFF_INVALID' USING ERRCODE='22023';END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'STALE_ROUND_LIMIT_INVALID' USING ERRCODE='22023';END IF;
 WITH charged AS (
  SELECT e.id execution_id,r.id run_id,e.actor_id,e.created_at since,
   (SELECT coalesce(sum(c.charged_delta),0) FROM bill2_calls c WHERE c.run_id=r.id
     AND c.settled_at IS NOT NULL AND c.compensated_at IS NULL AND c.charged_delta>0)::integer credits,
   e.payload->>'model' model,e.state execution_state,e.unavailable_reason,
   (coalesce(e.payload->>'providerRequestFormat','') IN ('serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream')
    OR coalesce(e.payload->>'textStream','')='plain-text-v1') streamed,
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
  -- 0382 (Owner 2026-10-25 "暂停回合选 A"): a round paused for the user (continue or top up) whose charged step
  -- never delivered a reply is refunded by the same rule once it has been quiet for 24 hours.
  WHERE (e.state IN ('prepared','running','interrupted','cost_pending') OR (e.state IN ('waiting_resume','waiting_credits') AND r.paused_reason IN ('http_budget','insufficient_credits')
    AND e.primary_result IS NULL AND e.result IS NULL))
   AND e.created_at<p_cutoff
   AND (p_created_since IS NULL OR e.created_at>=p_created_since)
   AND r.contract_version='bill2.v2' AND NOT r.closed AND NOT r.cancel_requested
   -- Any pause (user stop, insufficient credits, a resumable HTTP budget) is user-side or
   -- resumable, never a Graylum failure to refund. Erased accounts belong to erasure recovery.
   AND (r.paused_reason IS NULL OR (e.state IN ('waiting_resume','waiting_credits') AND r.paused_reason IN ('http_budget','insufficient_credits')
     AND e.primary_result IS NULL AND e.result IS NULL))
   -- 0284: content beyond capacity (user material too long) is not refunded (Owner 2026-10-12).
   AND coalesce(e.failure_code,'') NOT IN ('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY','RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY')
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
   -- The account id lets the operator match the round to user feedback; contact details stay out of the report.
   'executionId',execution_id,'runId',run_id,'actorId',actor_id,'chargedCredits',credits,'since',since,
   'evidence',jsonb_build_object('model',model,'streamed',streamed,'executionState',execution_state,
    'unavailableReason',unavailable_reason,'calls',calls,'outputTokens',output_tokens,
    'savedReplyChars',saved_reply_chars,'lastActivityAt',last_activity,'lastFinishReason',last_finish_reason)) ORDER BY n)
   FILTER (WHERE n<=p_limit),'[]'::jsonb)) INTO result FROM found;
 RETURN result;
END $fn$;
CREATE OR REPLACE FUNCTION public.runtime_stale_round_compensate(p_run_id uuid, p_cutoff timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
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
 -- 0382: a paused round qualifies only while it still waits for the user and never saved a reply.
 IF b.contract_version<>'bill2.v2' OR b.closed OR b.cancel_requested
  OR (b.paused_reason IS NOT NULL AND NOT (e.state IN ('waiting_resume','waiting_credits') AND b.paused_reason IN ('http_budget','insufficient_credits')
   AND e.primary_result IS NULL AND e.result IS NULL))
  -- 0284: content beyond capacity is user-side and never refunded.
  OR coalesce(e.failure_code,'') IN ('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY','RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY')
  OR NOT EXISTS(SELECT 1 FROM profiles p WHERE p.id=e.actor_id AND p.is_deleted='false')
  -- A retry just before the operator confirmed revives the round: it must still be quiet.
  OR (b.runtime_dispatch_deadline IS NOT NULL AND b.runtime_dispatch_deadline>=clock_timestamp())
  OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND greatest(c.created_at,
   coalesce(c.dispatched_at,c.created_at),coalesce(c.settled_at,c.created_at))>=p_cutoff)
  OR e.state NOT IN ('prepared','running','interrupted','cost_pending','waiting_resume','waiting_credits')
  OR e.created_at>=p_cutoff
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
END $fn$;
COMMIT;
