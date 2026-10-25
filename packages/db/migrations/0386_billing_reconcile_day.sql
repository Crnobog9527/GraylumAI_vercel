-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ARCH-FIX E2 (Owner 2026-10-25, "架构审计上线前按 A 做"; audit item 6): the daily billing reconciliation counts in
-- the database and checks each call and both credit-source ledgers.
--
-- Before: runDailyBillingReconciliation read token_stats, ai_usage_logs, payment_orders and billing_history rows for the
-- day without paging and summed them in the app. Above the API row cap the two sides were cut at different places
-- (false alarms), and "deductions >= accounted" passed whenever the accounted side was cut (real problems hidden).
-- Nothing compared a call's charge with its ledger rows, or credit_source_entries with the sources' consumed_amount.
-- After: billing_reconcile_day(start, end) returns, in one read-only statement:
--   * the same totals the four existing checks use (token stats count/credits/web searches, successful AI logs,
--     completed payment orders count/amount, billing settle + abort_settle sum); credit_transactions stays paged in
--     the app, so its spend/top-up classification is unchanged;
--   * calls: every call settled in the window whose ledger rows (bill2_call_id) do not sum to -charged_delta plus its
--     compensation, plus any period credits the settlement could not return (reserve -H, release +restored+charge,
--     spend -charge, compensation +restored; refundInterceptedRestoration; staging 10-25: 0 of 2522);
--   * sources: for accounts active in the window, every credit pack whose consumed_amount differs from its applied
--     credit_source_entries, and every subscription grant whose consumed_amount differs from its current-period share
--     in billing_history (pre_deduct amountToPeriod, settle/abort_settle periodConsumedDelta, refund amountToPeriod
--     less refundInterceptedRestoration, compensation period part) plus its applied entries (staging 10-25: 0 of 34
--     grants, 0 of 6 packs);
--   * unattributed and not-applied entry counts of the window (reported, not alarms: opening grants and admin credits
--     are spent unattributed by design).
-- New function only; no table or data changes. Recovery: drop it (the app falls back to nothing: deploy the previous
-- app version first).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.billing_reconcile_day(p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE totals jsonb;calls jsonb;sources jsonb;entries jsonb;
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

 RETURN totals||jsonb_build_object('calls',calls,'sources',sources,'entries',entries);
END $$;
REVOKE ALL ON FUNCTION public.billing_reconcile_day(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.billing_reconcile_day(timestamptz,timestamptz) TO service_role;
COMMIT;
