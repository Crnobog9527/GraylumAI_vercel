-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B10 (account erasure): the erasure job's money checks also count the account's core-path turns that are still open
-- or settling (state<>'closed' or settlement='pending'), so an erasure with a turn in flight stays 'billing_pending' and is not
-- completed. Changed: account_erasure_financial_proof, _financial_batch (totalPending/oldestPendingAt/reasons only; items are still the
-- old runs), _note_error (BILLING_CLEAR refused while a turn is open) and _preview (runsInFlight). Nothing is removed: the old BILL2
-- run handling (work_batch run list, the processor's bill2_cancel/finalize/read and runtime_financial_recovery calls, scrub_run/_calls/
-- _receipts, detach_runtime) stays until batch F (the erasure-completion Fusion case fails without the processor's finalize), because bill2_runs.session_ref
-- points at runtime_sessions and staging still holds thousands of old runs (Owner-side check 2026-11-02); the old rows are removed with
-- their tables in F. Signatures and result keys are unchanged.
-- Compatible: result shapes are the same. Repeatable: whole-function CREATE OR REPLACE.
-- Recovery: re-apply the previous text of the four functions from git history; no data is written or removed.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.account_erasure_financial_proof(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE pending bigint:=0; manual bigint:=0; n bigint; entry record;
BEGIN
 SELECT count(*) INTO pending FROM bill2_runs WHERE actor_id=p_profile_id
  AND (NOT closed OR state NOT IN ('settled','refunded') OR conflict);
 -- CORE-PATH-V2 V2-12: plus the account's core-path turns still open or settling (a frozen hold, an unsettled close).
 SELECT count(*) INTO n FROM turns WHERE actor_id=p_profile_id AND (state<>'closed' OR settlement='pending');
 pending:=pending+n;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id
  AND (NOT erasure_payment_terminal(to_jsonb(payment_orders))
    OR (refund_approval IS NOT NULL AND coalesce(refund_approval->>'status','') NOT IN ('rejected','succeeded','failed')));
 pending:=pending+n+CASE WHEN account_erasure_renewing(p_profile_id) THEN 1 ELSE 0 END;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id AND (
  (status IN ('completed','refunded','partially_refunded') AND (amount_total IS NULL OR currency IS NULL))
  OR jsonb_path_exists(metadata,'$.**.reviewRequired ? (@ == true)')
  OR metadata->'paymentConflicts' IS NOT NULL AND metadata->'paymentConflicts'<>'[]'::jsonb
  OR jsonb_path_exists(payment_amount_facts,'$[*] ? (@.amount == null)'));
 manual:=manual+n;
 SELECT count(*) INTO n FROM subscription_credit_grants WHERE user_id=p_profile_id
  AND accounting_state IS DISTINCT FROM 'trusted';
 manual:=manual+n;
 SELECT count(*) INTO n FROM bill2_runs b WHERE b.actor_id=p_profile_id AND
  (b.content_erased_at IS NULL OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND
    (c.content_erased_at IS NULL OR EXISTS(SELECT 1 FROM bill2_receipts r WHERE r.call_id=c.id
      AND r.financial_projected_at IS NULL))));
 manual:=manual+n;
 FOR entry IN SELECT * FROM (VALUES
  ('credit_transactions','user_id'),('billing_history','user_id'),('token_stats','user_id'),('ai_usage_logs','user_id')
 ) v(tbl,owner_col) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I=$1 AND content_erased_at IS NULL',entry.tbl,entry.owner_col)
   INTO n USING p_profile_id;
  manual:=manual+n;
 END LOOP;
 FOR entry IN SELECT unnest(ARRAY['payment_orders','user_subscriptions','subscription_credit_grants']) tbl LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1 AND
   (metadata_scrubbed_at IS NULL OR (erasure_payment_metadata(metadata,%L)->>''manualReview'')::int>0)',entry.tbl,entry.tbl)
   INTO n USING p_profile_id;
  manual:=manual+n;
 END LOOP;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id AND
  ((request_erased_at IS NULL AND (checkout_request IS NOT NULL OR purchase_change_request IS NOT NULL)) OR (refund_approval IS NOT NULL AND NOT monthly_refund_erasure_safe(refund_approval)));
 manual:=manual+n;
 -- Older generations/slices have original provider evidence not covered by BILL2 projections.
 -- Do not infer that a terminal state proves those arbitrary objects contain no private body.
 SELECT count(*) INTO n FROM artifact_generations g JOIN artifact_projects p ON p.id=g.project_id WHERE p.actor_id=p_profile_id;
 manual:=manual+n;
 SELECT count(*) INTO n FROM agent_slice_calls c JOIN agent_slice_executions x ON x.request_id=c.execution_id
  JOIN artifact_projects p ON p.id=x.project_id WHERE p.actor_id=p_profile_id;
 manual:=manual+n;
 SELECT count(*) INTO n FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  -- 0263 runtime research: a settled runtime search is finished money.
  WHERE p.actor_id=p_profile_id AND (o.erased_at IS NULL OR NOT research_operation_settled(o));
 pending:=pending+n;
 -- 0271 legacy chat tables
 SELECT count(*) INTO n FROM fusion_review_fees WHERE actor_id=p_profile_id AND state='held';
 pending:=pending+n;
 SELECT count(*) INTO n FROM report_fees WHERE actor_id=p_profile_id AND state='held';
 pending:=pending+n;
 RETURN jsonb_build_object('financialPending',pending,'manualReview',manual);
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_financial_batch(p_limit integer DEFAULT 20, p_profile_id uuid DEFAULT NULL::uuid, p_after_run_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_erasure_requests a
  JOIN profiles p ON p.id=a.profile_id WHERE p.id=p_profile_id
  AND p.status='deleted' AND p.is_deleted='true') THEN
  RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
 END IF;
 WITH candidates AS MATERIALIZED (
  SELECT r.*, e.id execution_id,e.state execution_state,s.active_execution,
   a.confirmed_at,a.stage_updated_at,
   CASE
    WHEN r.conflict THEN 'BILLING_CONFLICT'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.provider_id IS NULL) THEN 'BILLING_NO_PROVIDER_ID'
    WHEN r.deadline+interval '24 hours'<clock_timestamp() THEN 'BILLING_EXPIRED'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.recovery_attempts>=3) THEN 'BILLING_ATTEMPTS_EXHAUSTED'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.payload->>'lookupSupported' IS DISTINCT FROM 'true')
     THEN 'BILLING_LOOKUP_UNSUPPORTED'
    ELSE 'BILLING_PENDING' END reason,
   (NOT r.closed OR e.state NOT IN ('completed','cancelled','cost_pending') OR s.active_execution=e.id
    OR (r.state IN ('settled','refunded') AND e.state NOT IN ('completed','cancelled'))
    OR (r.state NOT IN ('settled','refunded') AND NOT r.conflict AND
     (NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id
       AND c.dispatched_at IS NOT NULL AND c.selected_cost_usd IS NULL)
      OR (r.deadline+interval '24 hours'>=clock_timestamp() AND EXISTS(
       SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
       AND c.selected_cost_usd IS NULL AND c.provider_id IS NOT NULL AND c.recovery_attempts<3
       AND c.payload->>'lookupSupported'='true'))))) needs_work
  FROM account_erasure_requests a JOIN profiles p ON p.id=a.profile_id
  JOIN bill2_runs r ON r.actor_id=p.id
  JOIN runtime_executions e ON e.billing_run_id=r.id AND e.actor_id=p.id
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=p.id AND r.session_ref=s.id
  WHERE p.status='deleted' AND p.is_deleted='true'
   AND bill2_erasure_closed(p.id,coalesce(r.pre_deduct_id,r.id))
   AND (p_profile_id IS NULL OR p.id=p_profile_id)
   AND (r.state NOT IN ('settled','refunded') OR NOT r.closed
    OR e.state NOT IN ('completed','cancelled') OR s.active_execution=e.id)
 ), open_turns AS (
  -- CORE-PATH-V2 V2-12: a deleted account's core-path turns still open or settling are pending too; turn recovery settles them
  -- (it does not look at the account's status), so they are reported here and never listed as work.
  SELECT count(*) n,min(a.confirmed_at) oldest FROM account_erasure_requests a JOIN profiles p ON p.id=a.profile_id
  JOIN turns t ON t.actor_id=p.id
  WHERE p.status='deleted' AND p.is_deleted='true' AND (p_profile_id IS NULL OR p.id=p_profile_id)
   AND (t.state<>'closed' OR t.settlement='pending')
 ), chosen AS (
  SELECT actor_id FROM candidates WHERE needs_work
  ORDER BY stage_updated_at,actor_id,id LIMIT 1
 ), page AS MATERIALIZED (
  SELECT c.* FROM candidates c JOIN chosen a USING(actor_id)
  WHERE c.needs_work AND (p_after_run_id IS NULL OR c.id>p_after_run_id)
  ORDER BY c.id LIMIT p_limit
 )
 SELECT jsonb_build_object(
  'selectedActorId',(SELECT actor_id FROM chosen),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'actorId',actor_id,'executionId',execution_id,'runId',id,'sessionId',session_ref,
   'state',state,'executionState',execution_state,'closed',closed,'reason',reason,
   'confirmedAt',confirmed_at,
   'recoveryPolicy',jsonb_build_object('id',test_window_id,'expiresAt',deadline,
    'creditsPerUsd',credits_per_usd::text,'multiplier',multiplier::text,
    'callPolicies',(SELECT jsonb_agg(jsonb_build_object(
     'modelId',v->>'modelId','provider',v->>'provider','account',v->>'account','model',v->>'model',
     'protocol',v->>'protocol','upperUsd',v->>'upperUsd','inputLimit',v->'inputLimit',
     'outputLimit',v->'outputLimit','automaticRetry',v->'automaticRetry',
     'hiddenTools',v->'hiddenTools','lookupSupported',v->'lookupSupported'))
     FROM jsonb_array_elements(payload->'callPolicy') v))) ORDER BY id) FROM page),'[]'::jsonb),
  'nextRunId',CASE WHEN (SELECT count(*) FROM page)=p_limit
   THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END,
  'totalPending',(SELECT count(*) FROM candidates)+(SELECT n FROM open_turns),
  'oldestPendingAt',(SELECT min(m) FROM (SELECT min(confirmed_at) m FROM candidates UNION ALL SELECT oldest FROM open_turns) u),
  'reasons',coalesce((SELECT jsonb_object_agg(reason,n) FROM
    (SELECT reason,sum(n)::bigint n FROM (SELECT reason,count(*) n FROM candidates GROUP BY reason
      UNION ALL SELECT 'BILLING_PENDING',n FROM open_turns WHERE n>0) r GROUP BY reason) counts),'{}'::jsonb)) INTO result;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_note_error(p_profile_id uuid, p_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE billing boolean:=p_code LIKE 'BILLING_%';pending boolean;
BEGIN
 IF billing AND p_code NOT IN ('BILLING_PENDING','BILLING_NO_PROVIDER_ID','BILLING_EXPIRED',
  'BILLING_ATTEMPTS_EXHAUSTED','BILLING_CONFLICT','BILLING_LOOKUP_UNSUPPORTED',
  'BILLING_CREDENTIAL_UNAVAILABLE','BILLING_RECOVERY_FAILED','BILLING_CLEAR') THEN
  RAISE EXCEPTION 'ERASURE_BILLING_CODE_INVALID' USING ERRCODE='22023';
 END IF;
 IF billing THEN
  IF NOT EXISTS(SELECT 1 FROM profiles p JOIN account_erasure_requests a ON a.profile_id=p.id
   WHERE p.id=p_profile_id AND p.status='deleted' AND p.is_deleted='true') THEN
   RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT EXISTS(SELECT 1 FROM bill2_runs r WHERE r.actor_id=p_profile_id
   AND (NOT r.closed OR r.state NOT IN ('settled','refunded')
    OR EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
     WHERE e.billing_run_id=r.id AND e.actor_id=p_profile_id
     AND (e.state NOT IN ('completed','cancelled') OR s.active_execution=e.id)))) INTO pending;
  -- CORE-PATH-V2 V2-12: an open or unsettled core-path turn is money in flight too.
  pending:=pending OR EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_profile_id AND (t.state<>'closed' OR t.settlement='pending'));
  IF p_code='BILLING_CLEAR' AND pending THEN
   RAISE EXCEPTION 'ERASURE_BILLING_STILL_PENDING';
  END IF;
 END IF;
 UPDATE account_erasure_requests SET
  stage=CASE WHEN billing AND pending THEN 'billing_pending'
   WHEN billing AND stage='billing_pending' THEN 'closed' ELSE stage END,
  -- Finance progress must not hide an outstanding Auth ban failure.
  last_error_code=CASE WHEN billing AND last_error_code='AUTH_BAN_FAILED' THEN last_error_code
   WHEN p_code='BILLING_CLEAR' THEN NULL ELSE p_code END,
  retry_count=retry_count+1,stage_updated_at=clock_timestamp()
 WHERE profile_id=p_profile_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_ERASURE_REQUEST_MISSING' USING ERRCODE='P0002';END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_preview(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'credits', coalesce((SELECT p.credits FROM public.profiles p WHERE p.id = p_profile_id), 0),
    'subscriptionRenewing', public.account_erasure_renewing(p_profile_id),
    'renewalChannels', public.account_erasure_renewal_channels(p_profile_id),
    'subscriptionActiveUntil', (
      SELECT max(s.current_period_end) FROM public.user_subscriptions s
      WHERE s.user_id = p_profile_id
        AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')),
    'pendingPayments', (SELECT count(*) FROM public.payment_orders o
      WHERE o.user_id = p_profile_id AND o.status = 'pending'),
    'runsInFlight', (SELECT count(*) FROM public.bill2_runs r
      WHERE r.actor_id = p_profile_id AND r.state IN ('prepared', 'dispatched', 'unknown', 'cost_pending')) +
      -- CORE-PATH-V2 V2-12: plus the core-path turns still open or settling.
      (SELECT count(*) FROM public.turns t WHERE t.actor_id = p_profile_id AND (t.state <> 'closed' OR t.settlement = 'pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id)
  );
$function$;

COMMIT;
