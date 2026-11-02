-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch R7: the daily reconciliation also checks every settled turn against the credit ledger.
-- A turn settled in the window must have turn_spend ledger rows that add up to its charged_credits, and its turn_intercepted
-- row (a freeze not returned because the subscription ended) must equal what the settle record in billing_history says.
-- The old per-call check (bill2_calls) stays until the old path is dropped. Accounts under erasure are skipped.
-- Compatible: the result gains a "turns" key; nothing else changes. Repeatable: whole-function CREATE OR REPLACE.
-- Recovery: re-apply the previous function text from git history; nothing is written.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.billing_reconcile_day(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE totals jsonb;calls jsonb;turn_check jsonb;sources jsonb;entries jsonb;
BEGIN
 IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<p_start
  OR p_end-p_start>interval '31 days' THEN RAISE EXCEPTION 'invalid reconciliation window'; END IF;
 SELECT jsonb_build_object(
  'tokenStatsCount',count(*),'tokenStatsCredits',coalesce(sum(total_credits),0),'webSearchCount',coalesce(sum(web_search_count),0))
 INTO totals FROM token_stats WHERE created_at>=p_start AND created_at<p_end;
 totals:=totals||jsonb_build_object(
  'successfulAiRequests',(SELECT count(*) FROM ai_usage_logs WHERE status='success' AND created_at>=p_start AND created_at<p_end),
  'settleCredits',(SELECT coalesce(sum(amount),0) FROM billing_history
    WHERE operation_type IN ('settle','abort_settle') AND created_at>=p_start AND created_at<p_end))
  ||(SELECT jsonb_build_object('completedPaymentOrders',count(*),'completedPaymentAmount',coalesce(sum(amount_total),0))
    FROM payment_orders WHERE status='completed' AND created_at>=p_start AND created_at<p_end);

 -- A grant reversed or a subscription ended between the hold and the settlement keeps its unreturned period credits:
 -- the settle/refund row records them (refundInterceptedRestoration), and the call's ledger nets that much more.
 WITH s AS (SELECT id,pre_deduct_id,charged_delta,compensation_credits FROM bill2_calls
   WHERE settled_at>=p_start AND settled_at<p_end),
 i AS (SELECT b.metadata->>'preDeductId' pid,sum((b.metadata->>'refundInterceptedRestoration')::int) n FROM billing_history b
   WHERE b.operation_type IN ('settle','refund','abort_settle') AND b.metadata->>'refundInterceptedRestoration' ~ '^[0-9]{1,9}$'
    AND b.metadata->>'preDeductId' IN (SELECT pre_deduct_id::text FROM s) GROUP BY 1),
 c AS (SELECT s.id,coalesce(s.charged_delta,0)+coalesce(i.n,0)-coalesce(s.compensation_credits,0) owed
   FROM s LEFT JOIN i ON i.pid=s.pre_deduct_id::text),
 bad AS (SELECT c.id FROM c LEFT JOIN LATERAL (SELECT sum(t.amount) net FROM credit_transactions t WHERE t.bill2_call_id=c.id) l ON true
   WHERE coalesce(l.net,0)<>-c.owed)
 SELECT jsonb_build_object('settledCalls',(SELECT count(*) FROM c),'mismatched',(SELECT count(*) FROM bad),
  'sample',coalesce((SELECT jsonb_agg(id) FROM (SELECT id FROM bad ORDER BY id LIMIT 20) s),'[]'))
 INTO calls;

 -- Turn path: a settled turn's charged credits must equal what the ledger booked for it as turn_spend.
 WITH t AS (SELECT x.actor_id,x.id,coalesce(x.charged_credits,0) charged FROM turns x
   WHERE x.settlement='done' AND x.closed_at>=p_start AND x.closed_at<p_end
    AND NOT EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id=x.actor_id)),
 l AS (SELECT t.*,
   coalesce((SELECT sum(-c.amount) FROM credit_transactions c WHERE c.user_id=t.actor_id
    AND c.source_type='ai_task' AND c.source_id=t.id::text AND c.reason_code='turn_spend'),0) booked,
   coalesce((SELECT sum(-c.amount) FROM credit_transactions c WHERE c.user_id=t.actor_id
    AND c.source_type='ai_task' AND c.source_id=t.id::text AND c.reason_code='turn_intercepted'),0) kept,
   coalesce((SELECT sum((b.metadata->>'refundInterceptedRestoration')::int) FROM billing_history b WHERE b.user_id=t.actor_id
    AND b.operation_type='settle' AND b.metadata->>'turnId'=t.id::text
    AND b.metadata->>'refundInterceptedRestoration' ~ '^[0-9]{1,9}$'),0) expected_kept FROM t),
 bad AS (SELECT * FROM l WHERE booked<>charged OR kept<>expected_kept)
 SELECT jsonb_build_object('settledTurns',(SELECT count(*) FROM t),'mismatched',(SELECT count(*) FROM bad),
  'sample',coalesce((SELECT jsonb_agg(jsonb_build_object('actorId',actor_id,'turnId',id,'charged',charged,'booked',booked,
      'intercepted',kept,'expectedIntercepted',expected_kept) ORDER BY id)
    FROM (SELECT * FROM bad ORDER BY id LIMIT 20) b),'[]'))
 INTO turn_check;

 WITH u AS (SELECT user_id FROM billing_history WHERE created_at>=p_start AND created_at<p_end
   UNION SELECT user_id FROM credit_source_entries WHERE created_at>=p_start AND created_at<p_end),
 e AS (SELECT source_kind,source_id,sum(amount) FILTER (WHERE applied) s FROM credit_source_entries
   WHERE user_id IN (SELECT user_id FROM u) AND source_id IS NOT NULL GROUP BY 1,2),
 h AS (
  SELECT (b.metadata->>'chargedGrantId')::uuid gid,CASE b.operation_type
    WHEN 'pre_deduct' THEN (b.metadata->>'amountToPeriod')::int
    WHEN 'settle' THEN (b.metadata->>'periodConsumedDelta')::int
    WHEN 'abort_settle' THEN (b.metadata->>'periodConsumedDelta')::int
    WHEN 'refund' THEN -((b.metadata->>'amountToPeriod')::int-coalesce((b.metadata->>'refundInterceptedRestoration')::int,0))
    ELSE 0 END p
  FROM billing_history b WHERE b.user_id IN (SELECT user_id FROM u)
   AND b.metadata->>'chargedGrantId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION ALL
  -- Compensation (bill2_payg_compensate) restores actualRestore: the part outside the period first, the rest to it.
  SELECT (o.metadata->>'chargedGrantId')::uuid,-((x.metadata->>'actualRestore')::int-((x.metadata->>'requestedCompensation')::int
    -least((x.metadata->>'requestedCompensation')::int,coalesce((o.metadata->>'amountToPeriod')::int,0))))
  FROM billing_history x JOIN billing_history o ON o.id=(x.metadata->>'originalPreDeductId')::uuid AND o.user_id=x.user_id
  WHERE x.user_id IN (SELECT user_id FROM u) AND x.operation_type='refund' AND x.metadata ? 'originalPreDeductId'
   AND o.metadata->>'chargedGrantId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 hs AS (SELECT gid,sum(p) p FROM h GROUP BY 1),
 bad AS (
  SELECT 'credit_package' kind,p.id FROM credit_package_sources p
   LEFT JOIN e ON e.source_kind='credit_package' AND e.source_id=p.id
   WHERE p.user_id IN (SELECT user_id FROM u) AND p.consumed_amount<>coalesce(e.s,0)
  UNION ALL
  SELECT 'subscription_grant',g.id FROM subscription_credit_grants g
   LEFT JOIN e ON e.source_kind='subscription_grant' AND e.source_id=g.id LEFT JOIN hs ON hs.gid=g.id
   WHERE g.user_id IN (SELECT user_id FROM u) AND g.consumed_amount<>coalesce(hs.p,0)+coalesce(e.s,0))
 SELECT jsonb_build_object('mismatched',(SELECT count(*) FROM bad),
  'sample',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'id',id)) FROM (SELECT * FROM bad ORDER BY 1,2 LIMIT 20) s),'[]'))
 INTO sources;

 SELECT jsonb_build_object('unattributed',count(*) FILTER (WHERE source_kind='unattributed'),'notApplied',count(*) FILTER (WHERE NOT applied))
 INTO entries FROM credit_source_entries WHERE created_at>=p_start AND created_at<p_end;

 RETURN totals||jsonb_build_object('calls',calls,'turns',turn_check,'sources',sources,'entries',entries);
END $function$;

COMMIT;
