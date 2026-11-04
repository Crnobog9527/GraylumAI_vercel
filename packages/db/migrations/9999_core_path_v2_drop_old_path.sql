-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch F: IRREVERSIBLE. Drops the old runtime / BILL2 path: 15 tables and 175 functions, and the foreign keys
-- from kept tables to them. There is no way back after this migration except restoring a backup (CORE-PATH-V2-DELETE.md section 4).
-- Data: staging holds old-path TEST rows only (thousands of rows in runtime_executions, bill2_runs/calls/receipts, ...); the production database
-- has not been built yet, so no real user data is in these tables. Kept tables that pointed at them keep their column values (plain, unconstrained).
-- Kept on purpose (not old path): runtime_scope_material, runtime_session_names, runtime_session_results, runtime_test_windows.
-- The first statement is a guard: it refuses to run while any function that stays still names a dropped table or calls a dropped function
-- (plpgsql would otherwise fail only when called). Whole object lists are generated from the recomputed inventory; nothing is dropped with CASCADE.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE OR REPLACE FUNCTION public.opc_business_archive(p_actor_id uuid, p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE b opc_businesses;
BEGIN
 -- 0326 Fusion run archive guard
 PERFORM bill2_actor(p_actor_id);
 -- Exactly the same user row lock as opc_start_b1: archive/count/insert serialize.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DENIED'; END IF;
 -- Mutations/dispatch keep a KEY SHARE lock until commit. NOWAIT avoids reversing
 -- existing business -> financial profile lock order: the owner retries a busy archive.
 BEGIN
  SELECT * INTO b FROM opc_businesses WHERE id=p_business_id AND actor_id=p_actor_id
   AND erased_at IS NULL FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END;
 IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED'; END IF;
 IF b.archived_at IS NULL THEN
  -- A turn still running for this business must close first (its model call may be in flight and its freeze is open); the owner retries.
  IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.state IN ('opening','running','stopping')
   AND opc_target_business(p_actor_id,jsonb_build_object('sessionId',t.session_id))=b.id) THEN
   RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END IF;
  UPDATE opc_businesses SET archived_at=clock_timestamp(),revision=revision+1
   WHERE id=b.id RETURNING * INTO b;
 END IF;
 RETURN jsonb_build_object('businessId',b.id,'name',b.name,'archivedAt',b.archived_at,'isArchived',true);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_target_business(a uuid, t jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE scope jsonb;bid uuid;pid uuid;did uuid;
BEGIN
 IF t->>'sessionId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM runtime_sessions s WHERE s.id=(t->>'sessionId')::uuid AND s.actor_id=a;
 ELSE scope:=t; END IF;
 did:=coalesce(scope->>'draftId',t->>'draftId')::uuid;
 pid:=coalesce(scope->>'workItemId',scope->>'projectId')::uuid;
 SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND (
  b.id=(t->>'businessId')::uuid OR EXISTS(
   SELECT 1 FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id
    WHERE db.business_id=b.id AND d.actor_id=a AND (d.draft_id=did OR d.project_id=pid)) OR EXISTS(
   SELECT 1 FROM opc_accounts ac WHERE ac.business_id=b.id AND ac.actor_id=a
    AND (ac.project_id=pid OR EXISTS(SELECT 1 FROM opc_items i
     WHERE i.account_project_id=ac.project_id AND i.work_item_id=pid))));
 RETURN bid;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_review_archive_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND (
  EXISTS(SELECT 1 FROM fusion_reviews rv WHERE rv.actor_id=NEW.actor_id
   AND rv.state IN ('running','paused')
   AND opc_target_business(NEW.actor_id,jsonb_build_object('draftId',rv.draft_id))=NEW.id)
 ) THEN RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.atomic_settle(p_user_id uuid, p_pre_deduct_id uuid, p_actual_credits integer, p_usage jsonb DEFAULT '{}'::jsonb, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(actual_credits integer, difference integer, balance_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
RETURN QUERY SELECT * FROM bill2_legacy_settle(p_user_id,p_pre_deduct_id,p_actual_credits,p_usage,p_response);END $function$;

CREATE OR REPLACE FUNCTION public.atomic_refund(p_user_id uuid, p_pre_deduct_id uuid, p_reason text DEFAULT 'AI 调用失败退费'::text)
 RETURNS TABLE(refund_amount integer, balance_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
RETURN QUERY SELECT * FROM bill2_legacy_refund(p_user_id,p_pre_deduct_id,p_reason);END $function$;

CREATE OR REPLACE FUNCTION public.billing_reconcile_day(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE totals jsonb;turn_check jsonb;sources jsonb;entries jsonb;
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

 -- Turn path: a settled turn's charged credits must equal what the ledger booked for it as turn_spend.
 WITH w AS (SELECT b.user_id actor_id,(b.metadata->>'turnId')::bigint id FROM billing_history b
   WHERE b.operation_type='settle' AND b.created_at>=p_start AND b.created_at<p_end AND b.metadata->>'turnId' ~ '^[0-9]{1,18}$'
  UNION SELECT c.user_id,c.source_id::bigint FROM credit_transactions c
   WHERE c.source_type='ai_task' AND c.reason_code IN ('turn_spend','turn_intercepted') AND c.created_at>=p_start AND c.created_at<p_end
    AND c.source_id ~ '^[0-9]{1,18}$'),
 t AS (SELECT x.actor_id,x.id,coalesce(x.charged_credits,0) charged FROM turns x JOIN w ON w.actor_id=x.actor_id AND w.id=x.id
   WHERE x.state='closed' AND x.charged_credits IS NOT NULL AND NOT EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id=x.actor_id)),
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

 RETURN totals||jsonb_build_object('turns',turn_check,'sources',sources,'entries',entries);
END $function$;

CREATE OR REPLACE FUNCTION public.fusion_compare_active(a uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS(SELECT 1 FROM fusion_compares fc WHERE fc.actor_id=a AND fc.state='admitting'
      AND fc.created_at>clock_timestamp()-interval '5 minutes')
    OR EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.kind='compare' AND t.state IN ('opening','running','stopping'));
$function$;

CREATE OR REPLACE FUNCTION public.fusion_review_breaker_usage(a uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Platform-borne outcomes of the last 7 days (§3.3 breaker): the compare and jury turns of CORE-PATH-V2 (V2-7b): calls that delivered nothing (a provider refusal, a 402, an answer refused under the fallback rule)
  -- and the provider cost of calls whose result was unusable or whose turn refunded everything. answer_verdict: recovery records a
  -- call whose cost came late as ok, but the platform bears one without a usable answer (a compare column broken off has none).
  SELECT jsonb_build_object('noDeliveryCalls', t.n, 'platformUsd', t.usd)
  FROM (SELECT count(*) FILTER (WHERE c.status IN ('rejected','no_charge_402')
      OR (c.status='unusable' AND c.usage->>'verdict'='no_delivery') OR c.answer_verdict='no_delivery' OR (t.kind='compare' AND c.status='ok' AND c.answer_verdict IS NULL)) n,
    coalesce(sum(coalesce(c.actual_usd,c.nominal_usd,0)) FILTER (WHERE c.status='unusable'
      OR (c.status='ok' AND t.state='closed' AND t.charged_credits=0) OR c.answer_verdict<>'usable'
      OR (t.kind='compare' AND c.status='ok' AND c.answer_verdict IS NULL)),0) usd
    FROM turn_calls c JOIN turns t ON t.actor_id=c.actor_id AND t.id=c.turn_id
    WHERE c.actor_id=a AND t.kind IN ('compare','jury') AND c.call_kind='model'
      AND c.dispatched_at>=clock_timestamp()-interval '7 days') t;
$function$;

CREATE OR REPLACE FUNCTION public.fusion_review_turn_source(p_actor_id uuid, p_request_id uuid, p_draft_id uuid, p_source_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts; p artifact_projects; r artifact_rounds; ver artifact_versions; m jsonb;
BEGIN
  PERFORM opc_assert_business_writable(p_actor_id, jsonb_build_object('draftId', p_draft_id));
  IF opc_draft_readonly(p_actor_id, p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
  SELECT * INTO d FROM opc_drafts WHERE draft_id = p_draft_id AND actor_id = p_actor_id;
  SELECT * INTO p FROM artifact_projects WHERE id = d.project_id AND actor_id = p_actor_id;
  SELECT * INTO ver FROM artifact_versions WHERE id = p_source_version_id AND project_id = p.id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id = ver.round_id AND project_id = p.id;
  IF d.draft_id IS NULL OR p.id IS NULL OR ver.id IS NULL OR r.state IS DISTINCT FROM 'published' OR d.round_id IS DISTINCT FROM r.id
    OR ver.version IS DISTINCT FROM p.current_version OR NOT coalesce(ver.report ? 'generatedReport', false)
    OR NOT content_erasure_artifact_readable(p_actor_id, ver.id) THEN RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  IF fusion_compare_active(p_actor_id)
    OR EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND state IN ('running','paused') AND request_id <> p_request_id)
    OR EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'compare' AND state IN ('running','paused','stopping')) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_ACTIVE';
  END IF;
  SELECT coalesce(jsonb_object_agg(s.key, (SELECT coalesce(jsonb_object_agg(f.key, jsonb_build_object('value', f.value->'value',
      'status', f.value->'status')), '{}') FROM jsonb_each(coalesce(s.value->'information', '{}')) f)), '{}')
    INTO m FROM jsonb_each(r.steps) s;
  RETURN jsonb_build_object('draftId', d.draft_id, 'projectId', p.id, 'sessionId', d.session_id, 'sourceVersionId', ver.id,
    'versionHash', ver.report_hash, 'materials', m, 'breaker', fusion_review_breaker_usage(p_actor_id));
END $function$;

CREATE OR REPLACE FUNCTION public.fusion_review_view(rv fusion_reviews)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('reviewId',rv.id,'state',rv.state,'round',rv.round,'phase',rv.phase,'attempt',rv.attempt,
    'draftId',rv.draft_id,'sourceVersionId',rv.source_version_id,'sourceSessionId',rv.source_session_id,
    'versionHash',rv.version_hash,'materials',rv.materials,'materialsHash',rv.materials_hash,'config',rv.config,
    'steps',rv.steps,'outcome',rv.outcome,'revisionId',rv.revision_id,'endedAt',rv.ended_at,'adoption',rv.adoption,
    'turnId',rv.turn_id,
    -- A review on the turn path (V2-7b): its fixed price is the turn's freeze and settlement.
    'fee',(SELECT jsonb_build_object(
      'credits',(t.policy->>'fixedCredits')::int,
      'state',CASE WHEN t.charged_credits IS NULL THEN 'held' WHEN t.charged_credits>0 THEN 'charged' ELSE 'refunded' END,
      'chargedCredits',t.charged_credits,'reason',t.close_kind,'settledAt',CASE WHEN t.charged_credits IS NOT NULL THEN t.closed_at END)
      FROM turns t WHERE t.actor_id=rv.actor_id AND t.id=rv.turn_id),
    -- Per call: its run, verdict and whether it settled, for continueReview. On the turn path a call is one turn_calls row of the
    -- review's turn, in the step whose first sequence is the nearest at or below it; its id is the one fusion_turn_outputs keys.
    'calls',coalesce((SELECT jsonb_agg(jsonb_build_object('groupId',st.x->>'groupId','runId',md5(c.turn_id::text||':'||c.seq::text)::uuid,
      'callId',md5(c.turn_id::text||':'||c.seq::text)::uuid,'seq',c.seq,'modelId',c.model_id,
      'phase',CASE WHEN st.x->>'phase'='summary' THEN 'fusion_summary' ELSE 'fusion_review' END,
      'dispatched',c.status<>'not_sent',
      'verdict',coalesce(o.verdict,CASE WHEN c.status IN ('not_sent','rejected','no_charge_402') THEN 'no_delivery' END),
      'settled',c.settled_at IS NOT NULL,'state',c.status,'dispatchedAt',c.dispatched_at,'settledAt',c.settled_at) ORDER BY c.seq)
      FROM turn_calls c
      CROSS JOIN LATERAL (SELECT x FROM jsonb_array_elements(rv.steps) x WHERE (x->>'fromSeq')::int<=c.seq
        ORDER BY (x->>'fromSeq')::int DESC LIMIT 1) st
      LEFT JOIN fusion_turn_outputs o ON o.turn_id=c.turn_id AND o.seq=c.seq
      WHERE c.turn_id=rv.turn_id AND c.call_kind='model'),'[]'));
$function$;

CREATE OR REPLACE FUNCTION public.fusion_review_admin_list(p_limit integer, p_before_created timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'createdAt')::timestamptz DESC, x->>'reviewId' DESC),'[]') FROM (
    SELECT jsonb_build_object('reviewId',rv.id,'actorId',rv.actor_id,'draftId',rv.draft_id,'state',rv.state,'outcome',rv.outcome,
      'round',rv.round,'createdAt',rv.created_at,'endedAt',rv.ended_at,'sourceVersionId',rv.source_version_id,
      'breakerCleared',CASE WHEN rv.breaker_cleared_at IS NULL THEN NULL ELSE jsonb_build_object('at',rv.breaker_cleared_at,
        'by',rv.breaker_cleared_by,'reason',rv.breaker_clear_reason,'batch',rv.breaker_clear_batch) END,'reviewers',rv.config->'reviewers','summary',rv.config->'summary',
      'costUsd',coalesce((SELECT sum(coalesce(c.actual_usd,c.nominal_usd,0)) FROM turn_calls c
        WHERE c.actor_id=rv.actor_id AND c.turn_id=rv.turn_id AND c.call_kind='model'),0),
      'chargedCredits',coalesce((SELECT t.charged_credits FROM turns t WHERE t.actor_id=rv.actor_id AND t.id=rv.turn_id),0),
      'fee',(SELECT jsonb_build_object('credits',(t.policy->>'fixedCredits')::int,
        'state',CASE WHEN t.charged_credits IS NULL THEN 'held' WHEN t.charged_credits>0 THEN 'charged' ELSE 'refunded' END,
        'chargedCredits',t.charged_credits,'reason',t.close_kind,'settledAt',CASE WHEN t.charged_credits IS NOT NULL THEN t.closed_at END)
        FROM turns t WHERE t.actor_id=rv.actor_id AND t.id=rv.turn_id)) x
    FROM fusion_reviews rv
    WHERE p_before_created IS NULL OR (rv.created_at,rv.id)<(p_before_created,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    ORDER BY rv.created_at DESC, rv.id DESC LIMIT least(greatest(coalesce(p_limit,20),1),100)) q;
$function$;

CREATE OR REPLACE FUNCTION public.fusion_review_admin_read(p_review_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT fusion_review_view(rv)||jsonb_build_object('actorId',rv.actor_id,'createdAt',rv.created_at,'outputs',
    coalesce((SELECT jsonb_agg(jsonb_build_object('callId',md5(c.turn_id::text||':'||c.seq::text)::uuid,'costUsd',coalesce(c.actual_usd,c.nominal_usd),'body',o.body) ORDER BY c.seq)
      FROM turn_calls c LEFT JOIN fusion_turn_outputs o ON o.turn_id=c.turn_id AND o.seq=c.seq
      WHERE c.actor_id=rv.actor_id AND c.turn_id=rv.turn_id AND c.call_kind='model'),'[]'))
  FROM fusion_reviews rv WHERE rv.id=p_review_id;
$function$;

CREATE OR REPLACE FUNCTION public.fusion_call_output_read(p_actor_id uuid, p_call_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; v fusion_turn_outputs;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- An answer saved on the turn path (V2-7b): readable while its turn's conversation exists, as below. A column refused under
  -- the positioning rule (no_delivery) is kept only for billing and never shown.
  SELECT * INTO v FROM fusion_turn_outputs WHERE call_id=p_call_id AND actor_id=p_actor_id AND verdict<>'no_delivery';
  IF v.turn_id IS NOT NULL THEN
    SELECT s2.* INTO s FROM runtime_sessions s2 JOIN turns t ON t.session_id=s2.id
      WHERE t.actor_id=p_actor_id AND t.id=v.turn_id FOR SHARE OF s2;
    IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('callId',v.call_id,'body',v.body,'bodyHash',v.body_hash,'savedAt',v.saved_at);
  END IF;
  RETURN NULL;
END $function$;

-- ---- erasure segment (R2c) ----
-- Format: whole-function CREATE OR REPLACE plus 6 DROP FUNCTION IF EXISTS; no BEGIN/COMMIT; safe to run twice. The generator splices it in after
-- billing_reconcile_day and before DO $guard$. It touches only the 24 functions named below (no other function, table or trigger).
-- CORE-PATH-V2 V2-12 batch F, pre-drop rewrite segment: account erasure and content deletion (R2c, 24 functions).
-- Goes into CORE-PATH-V2-DELETE-F-DRAFT.sql after the other pre-drop rewrites (billing_reconcile_day) and BEFORE the self-check guard, in the same
-- transaction. After it no account/content erasure function names an old table (runtime_executions, runtime_session_history,
-- runtime_history_dependencies, runtime_tool_calls, runtime_session_batches, runtime_*_references, bill2_runs/calls/receipts,
-- fusion_billing_groups, report_fees, fusion_review_fees) or calls a function that F drops.
--   Rewritten as whole functions (18): account_erasure_{preview,note_error,financial_proof,financial_batch,work_batch,body_remaining,
--     scrub_runtime,scrub_content,prune_business}, erasure_business_owner, content_erasure_{ledger_owned,capture_steps,artifact_readable,
--     saved_readable,parent_guard,mark_session,scope,confirm}.
--   Dropped here (6; their only callers are old-path functions that F drops): account_erasure_{detach_runtime,scrub_run,scrub_calls,scrub_receipts},
--     content_erasure_{financial_allowed,runtime_check}.
-- Protection is not loosened: an open or unsettled core-path turn still keeps an erasing account in billing_pending and blocks Auth removal;
-- content deletion still waits for open turns; every kept content table is still scrubbed/deleted. What goes away is only the handling of
-- rows that no longer exist (old runs, executions, history, receipts, fees).

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
    -- CORE-PATH-V2 V2-12 F: the core-path turns still open or settling are the only money in flight.
    'runsInFlight', (SELECT count(*) FROM public.turns t WHERE t.actor_id = p_profile_id AND (t.state <> 'closed' OR t.settlement = 'pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id)
  );
$function$;


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
  -- CORE-PATH-V2 V2-12 F: an open or unsettled core-path turn is money in flight.
  SELECT EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_profile_id AND (t.state<>'closed' OR t.settlement='pending')) INTO pending;
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


CREATE OR REPLACE FUNCTION public.account_erasure_financial_proof(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE pending bigint:=0; manual bigint:=0; n bigint; entry record;
BEGIN
 -- CORE-PATH-V2 V2-12 F: the account's core-path turns still open or settling (a frozen hold, an unsettled close).
 SELECT count(*) INTO pending FROM turns WHERE actor_id=p_profile_id AND (state<>'closed' OR settlement='pending');
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
 -- Older generations/slices have original provider evidence not covered by a projection.
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
 WITH open_turns AS (
  -- CORE-PATH-V2 V2-12 F: a deleted account's core-path turns still open or settling are the pending money; turn recovery settles them
  -- (it does not look at the account's status), so they are reported here and never listed as work.
  SELECT count(*) n,min(a.confirmed_at) oldest FROM account_erasure_requests a JOIN profiles p ON p.id=a.profile_id
  JOIN turns t ON t.actor_id=p.id
  WHERE p.status='deleted' AND p.is_deleted='true' AND (p_profile_id IS NULL OR p.id=p_profile_id)
   AND (t.state<>'closed' OR t.settlement='pending')
 )
 SELECT jsonb_build_object(
  'selectedActorId',NULL,
  'items','[]'::jsonb,
  'nextRunId',NULL,
  'totalPending',(SELECT n FROM open_turns),
  'oldestPendingAt',(SELECT oldest FROM open_turns),
  'reasons',CASE WHEN (SELECT n FROM open_turns)>0
   THEN jsonb_build_object('BILLING_PENDING',(SELECT n FROM open_turns)) ELSE '{}'::jsonb END) INTO result;
 RETURN result;
END $function$;


CREATE OR REPLACE FUNCTION public.account_erasure_work_batch(p_profile_id uuid, p_limit integer DEFAULT 20, p_after_run_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE request public.account_erasure_requests; proof jsonb;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 SELECT * INTO request FROM account_erasure_requests WHERE profile_id=p_profile_id;
 proof:=account_erasure_financial_proof(p_profile_id);
 RETURN proof||jsonb_build_object('requestId',request.request_id,'stage',request.stage,
  'runs','[]'::jsonb,'nextRunId',NULL);
END $function$;


CREATE OR REPLACE FUNCTION public.account_erasure_body_remaining(p_profile_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 account results proof

-- 0232 account name proof

-- R9 account proof

DECLARE entry record; n bigint; total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM fusion_call_outputs WHERE actor_id=p_profile_id)+(SELECT count(*) FROM fusion_reviews WHERE actor_id=p_profile_id)+(SELECT count(*) FROM fusion_compares WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_results WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_names WHERE actor_id=p_profile_id)
  -- CORE-PATH-V2 (account_erasure_scrub_turns): message text and provider response bodies still held.
  +(SELECT count(*) FROM session_messages m JOIN runtime_sessions s ON s.id=m.session_id
     WHERE s.actor_id=p_profile_id AND (m.content<>'' OR m.visible))
  +(SELECT count(*) FROM turn_call_raw r JOIN turn_calls c ON c.turn_id=r.turn_id AND c.seq=r.seq WHERE c.actor_id=p_profile_id);
BEGIN
 FOR entry IN SELECT * FROM (VALUES
  ('runtime_sessions','t.actor_id=$1'),
  ('artifact_projects','t.actor_id=$1'),
  ('opc_accounts','t.actor_id=$1'),
  ('opc_businesses','t.actor_id=$1'),
  ('opc_handoffs','t.actor_id=$1'),
  ('opc_content_versions','t.actor_id=$1'),
  ('opc_library_requests','t.actor_id=$1'),
  ('opc_topic_workspaces','t.actor_id=$1'),
  ('opc_topic_draft_versions','t.actor_id=$1'),
  ('research_plans','t.actor_id=$1'),
  ('conversations','t.user_id=$1'),
  -- 0271 legacy chat tables
  ('messages','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('conversation_context_snapshots','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('runtime_scope_material','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('artifact_rounds','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_evidence','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_versions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_requests','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_generations','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_work_references','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('agent_slice_executions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_confirmations','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_candidates','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('agent_slice_links','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_chat_turns','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('research_operations','EXISTS(SELECT 1 FROM research_plans p WHERE p.id=t.plan_id AND p.actor_id=$1)'),
  ('opc_plans','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_turns','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_topic_openings','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_items','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)'),
  ('opc_item_edits','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)')
 ) AS v(tbl,predicate) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',entry.tbl,entry.predicate)
   INTO n USING p_profile_id;
  total:=total+n;
 END LOOP;
 RETURN total;
END $function$;


CREATE OR REPLACE FUNCTION public.account_erasure_scrub_runtime(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint; g record;
  session_ids uuid[]; conversation_ids uuid[];
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.account_erasure_barrier() THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- confirm and scrub must use separate transactions. The service cannot backdate confirmed_at.
  -- Conservatively also retry a caller whose transaction predates a concurrent confirmation;
  -- this is not the barrier cutoff or proof of commit (the activity/prepared checks remain).
  IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id
    AND confirmed_at >= transaction_timestamp()) THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- Runtime writers lock session before execution. Never hold profile/run/project locks here.
  -- Do not wait on a busy session/conversation; counters include the omitted rows.
  session_ids := ARRAY(SELECT id FROM runtime_sessions WHERE actor_id = p_profile_id FOR UPDATE SKIP LOCKED);
  conversation_ids := ARRAY(SELECT id FROM conversations WHERE user_id = p_profile_id FOR UPDATE SKIP LOCKED);

  FOR g IN SELECT * FROM (VALUES
    ('runtime_scope_material',
      'request = NULL, content = NULL, content_hash = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      -- CORE-PATH-V2 V2-12 F: material goes with its conversation once no turn is open on it.
      't.session_id = ANY($3) AND NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.active_turn_id IS NOT NULL)'),
    ('runtime_sessions',
      'scope = NULL, start_payload = NULL, erased_at = $2',
      't.actor_id = $1',
      -- CORE-PATH-V2: a session with a turn still open is erased once the turn closes (it releases active_turn_id there).
      't.id = ANY($3) AND t.active_turn_id IS NULL'),
    -- 0271 legacy chat tables
    ('messages',
      'content = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversation_context_snapshots',
      'content = NULL, metadata = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversations',
      'title = NULL, summary = NULL, summary_metadata = NULL, erased_at = $2',
      't.user_id = $1',
      't.id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id = ch.project_id
      AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.id AND ag.state NOT IN (''succeeded'',''refunded''))')
  ) v(tbl, assignment, owned, ready) LOOP
    EXECUTE format('UPDATE public.%I t SET %s WHERE (%s) AND t.erased_at IS NULL AND (%s)',
      g.tbl, g.assignment, g.owned, g.ready) USING p_profile_id, now_at, session_ids, conversation_ids;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(g.tbl, n);
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',
      g.tbl, g.owned) INTO n USING p_profile_id;
    counts := counts || jsonb_build_object(g.tbl || '_skipped', n);
  END LOOP;
  RETURN counts;
END $function$;


CREATE OR REPLACE FUNCTION public.account_erasure_scrub_content(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 account results scrub

-- 0232 account name scrub

-- R9 account scrub

DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint;
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.account_erasure_barrier() THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- confirm and scrub must use separate transactions. The service cannot backdate confirmed_at.
  -- Conservatively also retry a caller whose transaction predates a concurrent confirmation;
  -- this is not the barrier cutoff or proof of commit (the activity/prepared checks remain).
  IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id
    AND confirmed_at >= transaction_timestamp()) THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS erasure_scope(kind text, id uuid) ON COMMIT DROP;
  TRUNCATE TABLE pg_temp.erasure_scope;
  INSERT INTO pg_temp.erasure_scope SELECT 'project', id FROM artifact_projects WHERE actor_id = p_profile_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'round', r.id FROM artifact_rounds r
    JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = r.project_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'draft', draft_id FROM opc_drafts WHERE actor_id = p_profile_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'plan', p.id FROM opc_plans p
    JOIN pg_temp.erasure_scope s ON s.kind = 'draft' AND s.id = p.draft_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'item', i.work_item_id FROM opc_items i
    JOIN pg_temp.erasure_scope s ON s.kind = 'plan' AND s.id = i.plan_id;

  -- artifact chat turns first: the generation guard compares a live instruction with its turn.
  UPDATE artifact_chat_turns t SET body = NULL, erased_at = now_at
  FROM artifact_chats c JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = c.project_id
  WHERE t.conversation_id = c.conversation_id AND t.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_chat_turns', n);

  -- Result keeps only its money keys; provider_observations is financial evidence (PR-B2).
  UPDATE artifact_generations g SET input = NULL, erased_at = now_at,
    result = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(g.result) = 'object' THEN g.result ELSE '{}'::jsonb END) e
      WHERE e.key IN ('credits', 'inputTokens', 'outputTokens', 'costUsd'))
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = g.project_id AND g.erased_at IS NULL
    AND g.state IN ('succeeded', 'refunded');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_generations', n);
  SELECT count(*) INTO n FROM artifact_generations g JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = g.project_id
  WHERE g.erased_at IS NULL;
  counts := counts || jsonb_build_object('artifact_generations_skipped', n);

  UPDATE artifact_rounds r SET steps = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = r.id AND r.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_rounds', n);
  UPDATE artifact_evidence e SET payload = NULL, content_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = e.project_id AND e.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_evidence', n);
  UPDATE artifact_confirmations c SET body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = c.round_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_confirmations', n);
  UPDATE artifact_candidates c SET body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = c.round_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_candidates', n);
  UPDATE artifact_versions v SET report = NULL, report_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = v.project_id AND v.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_versions', n);
  UPDATE artifact_requests q SET response = NULL, erased_at = now_at,
    payload = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(q.payload) = 'object' THEN q.payload ELSE '{}'::jsonb END) e
      WHERE e.key IN ('sliceExecution', 'slicePhase'))
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = q.project_id AND q.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_requests', n);
  UPDATE artifact_work_references w SET creation_payload = NULL, source_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = w.project_id AND w.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_work_references', n);
  UPDATE agent_slice_links l SET source_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = l.round_id AND l.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_slice_links', n);
  UPDATE agent_slice_executions x SET preference_refs = NULL, discussion_refs = NULL, input_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = x.project_id AND x.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_slice_executions', n);
  UPDATE artifact_projects p SET work_title = NULL, erased_at = now_at,
    account = CASE WHEN p.account IS NULL THEN NULL ELSE 'erased:' || p.id END
  WHERE p.actor_id = p_profile_id AND p.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_projects', n);

  UPDATE research_operations o SET erased_at = now_at,
    result = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(o.result) = 'object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key = 'cost')
  FROM research_plans p WHERE p.actor_id = p_profile_id AND o.plan_id = p.id AND o.erased_at IS NULL
    AND research_operation_settled(o);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('research_operations', n);
  SELECT count(*) INTO n FROM research_operations o JOIN research_plans p ON p.id = o.plan_id
  WHERE p.actor_id = p_profile_id AND o.erased_at IS NULL;
  counts := counts || jsonb_build_object('research_operations_skipped', n);
  UPDATE research_plans p SET operations = NULL, erased_at = now_at
  WHERE p.actor_id = p_profile_id AND p.erased_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM research_operations o WHERE o.plan_id = p.id AND o.erased_at IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('research_plans', n);

  UPDATE opc_turns t SET input_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'draft' AND s.id = t.draft_id AND t.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_turns', n);
  UPDATE opc_plans p SET request = NULL, body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'draft' AND s.id = p.draft_id AND p.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_plans', n);
  UPDATE opc_items i SET brief = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'item' AND s.id = i.work_item_id AND i.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_items', n);
  UPDATE opc_item_edits e SET title = NULL, brief = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'item' AND s.id = e.work_item_id AND e.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_item_edits', n);
  UPDATE opc_handoffs h SET payload = NULL, result = NULL, erased_at = now_at
  WHERE h.actor_id = p_profile_id AND h.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_handoffs', n);
  UPDATE opc_topic_openings o SET input = NULL, erased_at = now_at
  FROM opc_topic_workspaces w WHERE w.actor_id = p_profile_id AND o.draft_id = w.draft_id AND o.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_openings', n);
  UPDATE opc_topic_workspaces w SET source_hash = NULL, erased_at = now_at
  WHERE w.actor_id = p_profile_id AND w.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_workspaces', n);
  UPDATE opc_topic_draft_versions v SET request = NULL, body = NULL, erased_at = now_at
  WHERE v.actor_id = p_profile_id AND v.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_draft_versions', n);
  UPDATE opc_library_requests r SET payload = NULL, result = NULL, erased_at = now_at
  WHERE r.actor_id = p_profile_id AND r.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_library_requests', n);
  UPDATE opc_content_versions c SET body = NULL, title = NULL, erased_at = now_at
  WHERE c.actor_id = p_profile_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_content_versions', n);
  UPDATE opc_accounts a SET account_key = 'erased:' || a.project_id, erased_at = now_at
  WHERE a.actor_id = p_profile_id AND a.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_accounts', n);
  UPDATE opc_businesses b SET name = NULL, erased_at = now_at
  WHERE b.actor_id = p_profile_id AND b.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_businesses', n);

  -- Private settings with no inbound references are removed outright.
  DELETE FROM opc_work_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_work_ui_deleted', n);
  DELETE FROM opc_account_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_account_ui_deleted', n);
  DELETE FROM opc_publication_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_publication_ui_deleted', n);
  -- 0271 legacy chat tables
  DELETE FROM artifact_accounts WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_accounts_deleted', n);
  DELETE FROM opc_data_events WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('opc_data_events',n);
  DELETE FROM runtime_session_names WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('runtime_session_names_deleted',n);
  DELETE FROM fusion_call_outputs WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts := counts || jsonb_build_object('fusion_call_outputs', n);
  DELETE FROM fusion_reviews WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_reviews', n);
  -- 0338 session results
  DELETE FROM runtime_session_results WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('runtime_session_results_deleted',n);
  -- 0320 shortfall
  DELETE FROM research_benchmark_shortfalls WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_benchmark_shortfalls_deleted',n);
  -- 0268 benchmarks
  DELETE FROM research_benchmarks WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_benchmarks_deleted',n);
  -- 0263 runtime research
  DELETE FROM research_selection_cards WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_selection_cards_deleted',n);
  DELETE FROM research_account_fetches WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_account_fetches_deleted',n);
  DELETE FROM research_refresh_grants WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_refresh_grants_deleted',n);
  DELETE FROM research_discoveries WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_discoveries_deleted',n);
  DELETE FROM fusion_compares WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_compares', n);
  RETURN counts;
END $function$;


CREATE OR REPLACE FUNCTION public.account_erasure_prune_business(p_profile_id uuid, p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t text; item record; n integer; removed integer:=0; legacy_evidence boolean; failed text[]:='{}'; code text;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 IF NOT account_erasure_barrier() THEN RETURN 0; END IF;
 legacy_evidence:=EXISTS(SELECT 1 FROM artifact_generations g JOIN artifact_projects p ON p.id=g.project_id
  WHERE p.actor_id=p_profile_id) OR EXISTS(SELECT 1 FROM agent_slice_executions x JOIN artifact_projects p ON p.id=x.project_id
  WHERE p.actor_id=p_profile_id);
 UPDATE runtime_test_windows SET actor_ids=array_remove(actor_ids,p_profile_id),
  enabled=enabled AND cardinality(array_remove(actor_ids,p_profile_id))>0
  WHERE id IN (SELECT id FROM runtime_test_windows WHERE p_profile_id=ANY(actor_ids) LIMIT 100 FOR UPDATE SKIP LOCKED);
 -- Financial rows are never deleted. The existing guard permits only unchanged metadata;
 -- ordinary direct nullable content links may be safely severed on a closed, scrubbed row.
 UPDATE token_stats SET erased_conversation_id=conversation_id,erased_message_id=message_id,conversation_id=NULL,message_id=NULL WHERE ctid IN
  (SELECT ctid FROM token_stats WHERE user_id=p_profile_id AND content_erased_at IS NOT NULL
   AND conversation_id IS NOT NULL LIMIT p_limit FOR UPDATE SKIP LOCKED);
 -- LIB-2a public erasure
 -- PUBLISH-MONITOR erasure
 PERFORM publish_monitor_erasure_scrub(p_profile_id);
 -- 0262 library references
 -- PAY-FOUNDER erasure
 -- PAY-NOTIFY erasure
 -- ANALYTICS erasure
 -- VOICE erasure
 -- VOICE references
 FOREACH t IN ARRAY ARRAY[
  'voice_profiles','voice_profile_versions','voice_billing_scrubs',
  'analytics_checkout_ids','analytics_consent_withdrawals',
  'payment_notices',
  'founder_wall_entries','founder_community_status',
  'social_metric_snapshots','social_posts','social_review_runs','social_publish_jobs',
  'social_connect_requests','social_connections','social_monitor_settings',
  'library_document_segments','library_recognition_units','library_documents',
  'opc_video_material_bindings','opc_account_strategy_request_bases','opc_result_links','opc_content_versions',
  'opc_item_edits','opc_items','opc_plans','opc_turns',
  'opc_topic_openings','opc_topic_draft_versions','opc_topic_workspaces','opc_handoffs',
  'opc_account_strategy_drafts','opc_draft_businesses','opc_accounts','opc_businesses',
  'opc_drafts','opc_library_requests','runtime_scope_material',
  -- 0271 legacy chat tables
  'runtime_sessions','conversation_context_snapshots','messages',
  'conversations','agent_slice_links','artifact_work_references','artifact_evidence_restrictions',
  'artifact_confirmations','artifact_candidates','artifact_versions','artifact_requests',
  'artifact_evidence','artifact_rounds','artifact_projects'
 ] LOOP
  EXIT WHEN removed>=p_limit;
  -- Legacy financial evidence is not covered by a projection: keep its original context
  -- identities (already body-scrubbed by B1) until the financial review is resolved.
  IF legacy_evidence AND (t LIKE 'artifact_%' OR t IN ('agent_slice_links','opc_result_links')) THEN CONTINUE; END IF;
  FOR item IN EXECUTE format('SELECT ctid AS row_tid,to_jsonb(x) AS body FROM public.%I x
   WHERE public.erasure_business_owner(%1$L,to_jsonb(x))=$1 LIMIT $2 FOR UPDATE SKIP LOCKED',t)
   USING p_profile_id,p_limit-removed LOOP
   -- Body-bearing rows must have passed B1. Conversation deletion also retains its original
   -- legacy guards, and a RETURN NULL is observed as zero affected rows, never completion.
   IF t LIKE 'library_%' AND (
     EXISTS(SELECT 1 FROM library_upload_reservations WHERE actor_id=p_profile_id)
     OR EXISTS(SELECT 1 FROM library_recognition_units WHERE actor_id=p_profile_id AND bill2_request_id IS NOT NULL)
    ) THEN CONTINUE; END IF;
   IF t LIKE 'social_%' AND public.publish_monitor_erasure_retained(t,item.body) THEN CONTINUE; END IF;
   IF item.body ? 'erased_at' AND item.body->>'erased_at' IS NULL THEN CONTINUE; END IF;
   BEGIN
    EXECUTE format('DELETE FROM public.%I WHERE ctid=$1',t) USING item.row_tid;
    GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;
   -- A retained financial parent or a shared dependency stays. No cascade/trigger bypass.
   EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    -- 0395 prune diagnostics
    code:='ERASURE_PRUNE_'||SQLSTATE||'_'||upper(t);
    IF cardinality(failed)<5 AND code<>ALL(failed) THEN failed:=failed||code; END IF;
   WHEN lock_not_available THEN
    NULL; -- another writer holds the row; the next round retries it
   END;
  END LOOP;
 END LOOP;
 -- 0395: a failed delete while business work remains is why the request cannot finish; report it on this
 -- executor round (executor_finish keeps it). Review codes and completion are unchanged.
 IF cardinality(failed)>0 AND account_erasure_business_remaining(p_profile_id)>0 THEN
  UPDATE account_erasure_requests SET executor_error_codes=executor_error_codes||ARRAY(SELECT c FROM unnest(failed) c
   WHERE c<>ALL(executor_error_codes)) WHERE profile_id=p_profile_id;
 END IF;
 RETURN removed;
END $function$;


CREATE OR REPLACE FUNCTION public.erasure_business_owner(t text, j jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result uuid;
BEGIN
 -- LIB-2a public erasure
 -- PUBLISH-MONITOR erasure
 -- 0262 library references
 -- PAY-FOUNDER erasure
 -- PAY-NOTIFY erasure
 -- ANALYTICS erasure
 -- VOICE erasure
 -- VOICE references
 CASE
 WHEN t IN ('voice_profiles','voice_profile_versions','voice_billing_scrubs') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('analytics_checkout_ids','analytics_consent_withdrawals') THEN RETURN (j->>'user_id')::uuid;
 WHEN t='payment_notices' THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('founder_wall_entries','founder_community_status') THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('social_monitor_settings','social_connections','social_posts',
  'social_metric_snapshots','social_review_runs','social_connect_requests','social_publish_jobs')
  THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('library_documents','library_document_segments',
  'library_upload_reservations','library_recognition_units') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('opc_content_versions','opc_handoffs','opc_library_requests','opc_topic_workspaces',
  'opc_topic_draft_versions','opc_video_material_bindings','opc_account_strategy_request_bases',
  'opc_account_strategy_drafts','opc_accounts','opc_businesses','opc_drafts','artifact_projects',
  'runtime_sessions') THEN RETURN (j->>'actor_id')::uuid;
 -- 0271 legacy chat tables
 WHEN t='conversations' THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('messages','conversation_context_snapshots','artifact_chat_turns','artifact_chats') THEN
  SELECT user_id INTO result FROM conversations WHERE id=(j->>'conversation_id')::uuid;
 WHEN t IN ('artifact_versions','artifact_requests','artifact_evidence','artifact_work_references','artifact_rounds') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'project_id')::uuid;
 WHEN t IN ('artifact_confirmations','artifact_candidates','agent_slice_links') THEN
  SELECT p.actor_id INTO result FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE r.id=(j->>'round_id')::uuid;
 -- CORE-PATH-V2 V2-7a2: a report finalized from a turn names its owner on the link.
 WHEN t='opc_result_links' AND j->>'turn_actor_id' IS NOT NULL THEN RETURN (j->>'turn_actor_id')::uuid;
 -- CORE-PATH-V2 V2-12 F: a link made from an old execution (no turn) is owned through the project of its evidence.
 WHEN t='opc_result_links' THEN
  SELECT p.actor_id INTO result FROM artifact_evidence ev JOIN artifact_projects p ON p.id=ev.project_id
   WHERE ev.id=(j->>'evidence_id')::uuid;
 WHEN t='runtime_scope_material' THEN
  SELECT actor_id INTO result FROM runtime_sessions WHERE id=(j->>'session_id')::uuid;
 WHEN t IN ('opc_turns','opc_topic_openings','opc_plans','opc_draft_businesses') THEN
  SELECT actor_id INTO result FROM opc_drafts WHERE draft_id=(j->>'draft_id')::uuid;
 WHEN t IN ('opc_items','opc_item_edits') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'work_item_id')::uuid;
 WHEN t='artifact_evidence_restrictions' THEN
  SELECT p.actor_id INTO result FROM artifact_evidence e JOIN artifact_projects p ON p.id=e.project_id
   WHERE e.id=(j->>'evidence_id')::uuid;
 ELSE RETURN NULL;
 END CASE;
 RETURN result;
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_ledger_owned(j jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- CORE-PATH-V2 V2-12 F: a ledger row was owned through one of the account's content-deleted BILL2 runs; those runs are gone,
 -- and the core-path turns keep their own receipts. Account erasure still closes every ledger row of a deleted account.
 SELECT false;
$function$;


CREATE OR REPLACE FUNCTION public.content_erasure_capture_steps(steps jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erase provenance

DECLARE st record;f record;v jsonb;meta jsonb;result jsonb:=steps;changed boolean;information_changed boolean;ids uuid[]:='{}';
BEGIN
 -- CORE-PATH-V2 V2-12 F: the old executions that provenance could name are gone, so no capture field names a deleted one.
 IF jsonb_typeof(steps) IS DISTINCT FROM 'object' THEN RETURN steps; END IF;
 FOR st IN SELECT * FROM jsonb_each(steps) LOOP
  v:=st.value;changed:=false;information_changed:=false;
  FOR f IN SELECT * FROM jsonb_each(coalesce(v->'fieldMeta','{}')) LOOP
   meta:=f.value;
   IF meta->>'source'='capture' AND lower(meta->>'executionId')=ANY(ids::text[]) THEN
    IF meta->>'fp'=artifact_hash(v#>ARRAY['information',f.key]) THEN
     v:=jsonb_set(v,ARRAY['information',f.key],'{"value":"","status":"unknown","nature":"unknown"}');
     information_changed:=true;
    END IF;
    meta:=meta-ARRAY['source','executionId','fp'];changed:=true;
   END IF;
   IF content_erasure_references(meta->'suggestion',ids) THEN meta:=meta-'suggestion';changed:=true; END IF;
   IF content_erasure_references(meta->'withdrawnSuggestion',ids) THEN meta:=meta-'withdrawnSuggestion';changed:=true; END IF;
   IF content_erasure_references(meta->'suggestions',ids) THEN
    meta:=jsonb_set(meta,'{suggestions}',(SELECT coalesce(jsonb_agg(x),'[]') FROM jsonb_array_elements(meta->'suggestions') x
     WHERE NOT content_erasure_references(x,ids)));changed:=true;
   END IF;
   IF meta->>'source'='user' AND (content_erasure_references(meta->'executionId',ids)
    OR content_erasure_references(meta->'origin',ids)) THEN
    meta:=(meta-ARRAY['executionId','origin'])||jsonb_build_object('sourceAvailable',false);changed:=true;
   END IF;
   v:=jsonb_set(v,ARRAY['fieldMeta',f.key],meta);
  END LOOP;
  IF changed THEN
   IF information_changed THEN
    v:=v||jsonb_build_object('valid',false,'version',coalesce((v->>'version')::integer,0)+1);
   END IF;
   result:=jsonb_set(result,ARRAY[st.key],v);
  END IF;
 END LOOP;
 RETURN result;
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_artifact_readable(a uuid, vid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v artifact_versions;p artifact_projects;r artifact_rounds;eid text;
BEGIN
 SELECT * INTO v FROM artifact_versions WHERE id=vid AND erased_at IS NULL;
 SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a AND erased_at IS NULL;
 SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND erased_at IS NULL AND state='published';
 IF v.id IS NULL OR p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
 PERFORM bill2_actor(a);
 PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 IF artifact_evidence_allowed(p.id,v.evidence_ids) THEN RETURN true; END IF;
 FOR eid IN SELECT jsonb_array_elements_text(v.evidence_ids) LOOP
  IF EXISTS(SELECT 1 FROM artifact_evidence_restrictions WHERE evidence_id::text=eid
   AND (deleted OR expires_at<=clock_timestamp())) THEN RETURN false; END IF;
  IF NOT artifact_evidence_allowed(p.id,jsonb_build_array(eid)) AND NOT EXISTS(
   -- CORE-PATH-V2 V2-7a2: a report finalized from a turn stays readable when its conversation is deleted.
   SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id JOIN runtime_sessions s ON s.id=t.session_id
    JOIN artifact_evidence ev ON ev.id=l.evidence_id
   WHERE l.evidence_id::text=eid AND ev.project_id=p.id AND t.actor_id=a AND s.content_deleted_at IS NOT NULL
   UNION ALL
   SELECT 1 FROM artifact_work_references ref JOIN artifact_versions src ON src.id=ref.source_version_id
    JOIN artifact_projects owner ON owner.id=src.project_id
   WHERE ref.evidence_id::text=eid AND ref.project_id=p.id AND owner.actor_id=a AND owner.content_deleted_at IS NOT NULL
  ) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_saved_readable(a uuid, cid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c opc_content_versions;p artifact_projects;v artifact_versions;r artifact_rounds;
 current_id uuid:=cid;seen uuid[]:='{}';first_row boolean:=true;
BEGIN
 IF opc_content_allowed(a,cid) THEN RETURN true; END IF;
 LOOP
  IF current_id IS NULL THEN RETURN true; END IF;
  IF current_id=ANY(seen) THEN RETURN false; END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND c.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT * INTO p FROM artifact_projects WHERE id=c.work_item_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND p.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT av.* INTO v FROM opc_items i JOIN artifact_versions av ON av.id=i.source_version_id WHERE i.work_item_id=p.id;
  SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a;
  SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND state='published';
  IF p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
  -- Retain current package/actor authorization even when the source body is gone.
  PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
  IF v.erased_at IS NULL AND NOT opc_source_allowed(a,v.id) THEN RETURN false; END IF;
  -- CORE-PATH-V2 V2-12 F: a version saved from an old execution has no execution to read from any more.
  IF c.execution_id IS NOT NULL THEN RETURN false; END IF;
  -- A deleted conversation leaves the version readable; an account being erased does not.
  IF c.turn_id IS NOT NULL AND EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.id=c.turn_id
    AND (turn_tombstones(a,t.session_id,'{}'::jsonb)->>'accountErasing')::boolean) THEN RETURN false; END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;first_row:=false;
 END LOOP;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_parent_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE j jsonb:=to_jsonb(NEW);sid uuid;pid uuid;deleted boolean;
BEGIN
 IF TG_TABLE_NAME='runtime_scope_material' THEN
  sid:=(j->>'session_id')::uuid;
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM runtime_sessions WHERE id=sid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME IN ('artifact_rounds','artifact_versions','artifact_requests','artifact_evidence','artifact_generations','artifact_chats') THEN
  pid:=(j->>'project_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('artifact_candidates','artifact_confirmations') THEN
  SELECT project_id INTO pid FROM artifact_rounds WHERE id=(j->>'round_id')::uuid;
 ELSIF TG_TABLE_NAME='artifact_chat_turns' THEN
  SELECT project_id INTO pid FROM artifact_chats WHERE conversation_id=(j->>'conversation_id')::uuid;
 ELSIF TG_TABLE_NAME='artifact_chat_summaries' THEN
  SELECT c.project_id INTO pid FROM artifact_chats c JOIN artifact_chat_turns t ON t.conversation_id=c.conversation_id
   WHERE t.request_id=(j->>'turn_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('opc_content_versions','opc_work_ui','opc_publication_ui') THEN pid:=(j->>'work_item_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('opc_account_ui','opc_account_strategy_drafts') THEN pid:=(j->>'account_project_id')::uuid;
 END IF;
 IF pid IS NOT NULL THEN
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM artifact_projects WHERE id=pid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME='opc_content_versions' AND j->>'source_content_id' IS NOT NULL THEN
  -- Source reads stay denied; independently saved existing bodies are not new source grants.
  IF NOT opc_content_allowed((j->>'actor_id')::uuid,(j->>'source_content_id')::uuid) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_mark_session(a uuid, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; deleted boolean; scope jsonb; ids uuid[]; refs uuid[]; local boolean; stamp timestamptz; unbound boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Same order as content_erasure_confirm (profile, then session). A short wait instead of
 -- NOWAIT lets a reply commit that holds this session for a moment finish first.
 PERFORM set_config('lock_timeout','2000',true);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO s FROM runtime_sessions WHERE id=target AND actor_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 deleted:=s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL;
 IF deleted THEN
  RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',true,
   'preservedSavedVersions',0,'financialReviewCount',0);
 END IF;
 -- Read-only scope (no account-wide locks). The marker alone is enough only when nothing outside
 -- this conversation holds a copy: a free conversation (no work, draft or topic binding), every scoped
 -- execution in it, no saved content, work, data event, result link, captured field, library
 -- request or other conversation's frozen material referencing it. Anything else, or any doubt,
 -- runs the full cleanup now so no derived copy stays readable after this call returns.
 -- ERASE-SPEED bound first: a conversation bound to a draft or a topic workspace (the same two conditions as
 -- below) is never cleaned by the marker alone; only for it is the scope not computed here.
 unbound:=NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target);
 IF unbound THEN
  scope:=content_erasure_scope(a,'session',target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  refs:=ids||target;
 END IF;
 local:=unbound AND s.scope->>'kind'='positioning_draft' AND s.scope->>'workItemId' IS NULL
  AND NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM fusion_compares fcmp WHERE fcmp.session_id=target)
  AND jsonb_array_length(scope->'projects')=0 AND jsonb_array_length(scope->'versions')=0
  AND jsonb_array_length(scope->'contents')=0 AND jsonb_array_length(scope->'affectedSources')=0
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=a AND c.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c JOIN turns t ON t.actor_id=c.turn_actor_id AND t.id=c.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d WHERE d.actor_id=a AND d.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d JOIN turns t ON t.actor_id=d.turn_actor_id AND t.id=d.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE l.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.erased_at IS NULL AND content_erasure_references(r.steps,refs))
  AND NOT EXISTS(SELECT 1 FROM opc_library_requests q WHERE q.actor_id=a AND q.erased_at IS NULL
   AND (content_erasure_references(q.payload,refs) OR content_erasure_references(q.result,refs)))
  AND NOT EXISTS(SELECT 1 FROM runtime_scope_material m JOIN runtime_sessions o ON o.id=m.session_id
   WHERE o.actor_id=a AND m.session_id<>target AND m.erased_at IS NULL
    AND (content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)));
 UPDATE runtime_sessions SET content_deleted_at=clock_timestamp() WHERE id=target RETURNING content_deleted_at INTO stamp;
 -- CORE-PATH-V2: the conversation's messages leave the visible history now (one indexed update, still under the session
 -- lock turn_close appends under); their text is cleared with the rest of the conversation by content_erasure_confirm.
 UPDATE session_messages SET visible=false,deleted_at=stamp WHERE session_id=target AND (visible OR deleted_at IS NULL);
 -- Off-database erasure manifest (0227): recorded at the marker's time, in the same transaction;
 -- the later cleanup's own note keeps this first time.
 PERFORM erasure_manifest_note('session',target,a,stamp);
 IF NOT local THEN
  -- Same transaction: the marked-session cleanup locks only rows in scope. If it is busy the
  -- marker rolls back with it and the caller reports the conversation as not deleted.
  RETURN content_erasure_confirm(a,'session',target,NULL)||jsonb_build_object('alreadyDeleted',false);
 END IF;
 -- Content is unreadable from here on. Money facts stay on their original runs; the
 -- background cleanup reports any financial review.
 RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',false,
  'preservedSavedVersions',0,'financialReviewCount',0);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_scope(a uuid, k text, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erasure preview

DECLARE sessions uuid[]:='{}'; executions uuid[]:='{}'; projects uuid[]:='{}'; versions uuid[]:='{}';
 content_ids uuid[]:='{}'; refs uuid[]:='{}'; turn_ids bigint[]:='{}';
 root_s runtime_sessions;root_p artifact_projects;root_c opc_content_versions;
 deleted boolean:=false;more uuid[];n integer;preserved bigint;dependents jsonb;
BEGIN
 IF a IS NULL OR target IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF k='answer' THEN
  -- CORE-PATH-V2 V2-12 F: an answer was one old execution; none exists any more.
  RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501';
 ELSIF k='session' THEN
  SELECT * INTO root_s FROM runtime_sessions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  sessions:=ARRAY[root_s.id];deleted:=root_s.content_deleted_at IS NOT NULL OR root_s.erased_at IS NOT NULL;
 ELSIF k='artifact' THEN
  SELECT * INTO root_p FROM artifact_projects WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  projects:=ARRAY[root_p.id];deleted:=root_p.content_deleted_at IS NOT NULL OR root_p.erased_at IS NOT NULL;
  -- Account-specific strategy drafts are private copies in separate projects.
  projects:=projects||ARRAY(SELECT d.project_id FROM opc_account_strategy_drafts b
   JOIN opc_drafts d ON d.draft_id=b.draft_id JOIN artifact_projects p ON p.id=d.project_id
   WHERE b.account_project_id=root_p.id AND b.actor_id=a AND d.actor_id=a AND p.actor_id=a);
  versions:=ARRAY(SELECT id FROM artifact_versions WHERE project_id=ANY(projects) ORDER BY id);
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY id);
 ELSIF k='content' THEN
  SELECT * INTO root_c FROM opc_content_versions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=root_c.work_item_id AND kind=root_c.kind);
  deleted:=NOT EXISTS(SELECT 1 FROM opc_content_versions WHERE id=ANY(content_ids) AND erased_at IS NULL);
 ELSE RAISE EXCEPTION 'CONTENT_TARGET_INVALID' USING ERRCODE='22023'; END IF;
 -- The original producing execution predates the saved content UUID. Follow its
 -- persisted identity for the selected family only, not independent descendants.
 executions:=executions||ARRAY(SELECT execution_id FROM opc_content_versions
  WHERE actor_id=a AND id=ANY(content_ids) AND execution_id IS NOT NULL);
 -- Independent saved descendants stay intact, while their copied source contexts are invalidated.
 WITH RECURSIVE descendants(id) AS (
  SELECT id FROM opc_content_versions WHERE id=ANY(content_ids)
  UNION SELECT c.id FROM opc_content_versions c JOIN descendants d ON c.source_content_id=d.id WHERE c.actor_id=a
 ) SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refs FROM descendants;
 refs:=refs||executions||sessions||projects||versions||content_ids||
  ARRAY(SELECT id FROM artifact_evidence WHERE project_id=ANY(projects))||
  ARRAY(SELECT operation_id FROM artifact_evidence WHERE project_id=ANY(projects) AND operation_id IS NOT NULL)||
  ARRAY(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=ANY(projects))||
  ARRAY(SELECT conversation_id FROM artifact_chats WHERE project_id=ANY(projects))||
  ARRAY(SELECT work_item_id FROM opc_items WHERE source_version_id=ANY(versions))||
  ARRAY(SELECT session_id FROM opc_topic_workspaces WHERE actor_id=a AND source_version_id=ANY(versions))||ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 -- CORE-PATH-V2 V2-12 F: the executions are only the ids a saved version still names (rows of other tables keep them as plain values).
 -- CORE-PATH-V2 V2-10b C2: the turns of the same dependency, by what a turn can hold: the producing turn of a selected version, a turn
 -- given a script as material (any turn that read a claimed revision) or as source, every turn of a conversation in scope; then
 -- every later turn of those conversations, whose history held the reply.
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND (t.session_id=ANY(sessions)
   OR t.id IN (SELECT c.turn_id FROM opc_content_versions c WHERE c.actor_id=a AND c.id=ANY(content_ids) AND c.turn_id IS NOT NULL)
   OR t.request_id IN (SELECT b.request_id FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs))
   OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.session_id=t.session_id AND b.source_script_id=ANY(refs)
    AND b.material_revision::text=t.policy#>>'{workMaterial,revision}')
   OR t.policy#>>'{workSource,contentId}'=ANY(refs::text[])
   OR t.session_id IN (SELECT rs.id FROM runtime_sessions rs WHERE rs.actor_id=a AND content_erasure_references(rs.scope,refs)))
  ORDER BY t.id);
 -- A resumed turn's raw responses before the pause are on the turns it continues.
 WITH RECURSIVE chain(id,resume_of) AS (SELECT t.id,t.resume_of FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids)
   UNION SELECT p.id,p.resume_of FROM chain c JOIN turns p ON p.actor_id=a AND p.id=c.resume_of)
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO turn_ids FROM chain;
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND EXISTS(SELECT 1 FROM turns src
   WHERE src.actor_id=a AND src.id=ANY(turn_ids) AND src.session_id=t.session_id AND src.id<=t.id) ORDER BY t.id);
 SELECT count(*) INTO preserved FROM opc_content_versions c0 WHERE c0.actor_id=a AND c0.erased_at IS NULL
  AND NOT c0.id=ANY(content_ids) AND (c0.execution_id=ANY(executions) OR c0.turn_id=ANY(turn_ids) OR c0.source_content_id=ANY(content_ids));
 preserved:=preserved+(SELECT count(*) FROM artifact_versions v WHERE NOT v.project_id=ANY(projects)
  AND EXISTS(SELECT 1 FROM artifact_projects p0 WHERE p0.id=v.project_id AND p0.actor_id=a)
  AND (EXISTS(SELECT 1 FROM artifact_work_references r WHERE r.project_id=v.project_id AND r.source_version_id=ANY(versions))
   OR EXISTS(SELECT 1 FROM opc_result_links l WHERE l.round_id=v.round_id AND l.execution_id=ANY(executions))
   -- CORE-PATH-V2 V2-7a2: the same for a report finalized from a turn of these conversations.
   OR EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id
    WHERE l.round_id=v.round_id AND t.actor_id=a AND t.session_id=ANY(sessions))));
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind,id),'[]') INTO dependents FROM (
  SELECT 'account' kind,p.project_id id FROM opc_accounts p WHERE p.actor_id=a AND p.source_version_id=ANY(versions)
  UNION SELECT 'work_item',i.work_item_id FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
   WHERE p.actor_id=a AND i.source_version_id=ANY(versions)
  UNION SELECT 'reference',r.project_id FROM artifact_work_references r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.source_version_id=ANY(versions)
  UNION SELECT 'content',c.id FROM opc_content_versions c WHERE c.actor_id=a AND NOT c.id=ANY(content_ids)
   AND (c.execution_id=ANY(executions) OR c.turn_id=ANY(turn_ids) OR c.id=ANY(refs))
 ) affected;
 -- Canonical sets make the preview hash independent of query plans and physical row order.
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO sessions FROM unnest(sessions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO executions FROM unnest(executions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO projects FROM unnest(projects) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO versions FROM unnest(versions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO content_ids FROM unnest(content_ids) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO refs FROM unnest(refs) id WHERE id IS NOT NULL;
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',deleted,
  'sessions',to_jsonb(sessions),'executions',to_jsonb(executions),'turns',to_jsonb(turn_ids),'projects',to_jsonb(projects),
  'versions',to_jsonb(versions),'contents',to_jsonb(content_ids),'references',to_jsonb(refs),
  'affectedSources',dependents,'preservedSavedVersions',preserved,
  'dataEvents',coalesce((SELECT jsonb_agg(jsonb_build_array(request_id,item_key,created_at) ORDER BY request_id,item_key)
   FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(executions) OR project_id=ANY(projects)
    OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
    OR target_project_id=ANY(projects) OR source_version_id=ANY(versions))),'[]'::jsonb));
END $function$;


CREATE OR REPLACE FUNCTION public.content_erasure_confirm(a uuid, k text, target uuid, expected_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 conversation results erasure

-- 0232 conversation name erasure

-- R9 erasure content

DECLARE scope jsonb; turn_ids bigint[]; ids uuid[]; sessions uuid[]; projects uuid[]; versions uuid[]; contents uuid[];
 refs uuid[]; rounds uuid[]; chats uuid[]; research_ids uuid[]; research_plan_ids uuid[]; stamp timestamptz:=clock_timestamp();
 remaining bigint:=0; deleted boolean; linked uuid[];
BEGIN
 PERFORM bill2_actor(a);
 -- Runtime writers use session -> execution -> run. NOWAIT prevents inverse
 -- legacy/project lock orders from turning erasure into a cross-domain deadlock.
 PERFORM id FROM profiles WHERE id=a FOR SHARE NOWAIT;
 PERFORM bill2_actor(a);
 -- 0231 marked session locks
 IF k='session' AND EXISTS(SELECT 1 FROM runtime_sessions WHERE id=target AND actor_id=a AND content_deleted_at IS NOT NULL) THEN
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  rounds:=ARRAY(SELECT DISTINCT s0.id FROM runtime_sessions s0 WHERE s0.actor_id=a AND s0.id=ANY(sessions) ORDER BY s0.id);
  PERFORM id FROM runtime_sessions WHERE id=ANY(rounds) ORDER BY id FOR UPDATE NOWAIT;
  -- Works these conversations feed (draft, topic workspace or captured field): capture locks the
  -- project before writing, so holding it here serializes capture with this cleanup.
  PERFORM id FROM artifact_projects WHERE actor_id=a AND (id IN (SELECT d0.project_id FROM opc_drafts d0 WHERE d0.session_id=ANY(rounds))
   OR id IN (SELECT d1.project_id FROM opc_topic_workspaces t1 JOIN opc_drafts d1 ON d1.draft_id=t1.draft_id WHERE t1.session_id=ANY(rounds))
   OR id IN (SELECT r0.project_id FROM artifact_rounds r0 JOIN artifact_projects p0 ON p0.id=r0.project_id
    WHERE p0.actor_id=a AND content_erasure_references(r0.steps,ids))) ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  IF NOT sessions<@rounds OR jsonb_array_length(scope->'projects')>0 THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
  END IF;
 ELSE
  PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
 END IF;
 deleted:=(scope->>'alreadyDeleted')::boolean;
 -- 0227 erasure manifest
 PERFORM erasure_manifest_note(k,target,a,stamp);
 IF NOT deleted AND expected_hash IS DISTINCT FROM encode(sha256(convert_to(scope::text,'utf8')),'hex') THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_PREVIEW_CHANGED' USING ERRCODE='40001';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO projects FROM jsonb_array_elements_text(scope->'projects') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO versions FROM jsonb_array_elements_text(scope->'versions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO contents FROM jsonb_array_elements_text(scope->'contents') v;
 SELECT coalesce(array_agg(v::bigint),'{}') INTO turn_ids FROM jsonb_array_elements_text(scope->'turns') v;
 -- Existing UI writers lock their item/account before updating private settings.
 PERFORM work_item_id FROM opc_items WHERE work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM project_id FROM opc_accounts WHERE project_id=ANY(projects) ORDER BY project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM account_project_id FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects) ORDER BY account_project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 rounds:=ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 chats:=ARRAY(SELECT c.conversation_id FROM artifact_chats c JOIN conversations v ON v.id=c.conversation_id
  WHERE c.project_id=ANY(projects) AND v.user_id=a);
 PERFORM id FROM conversations WHERE id=ANY(chats) ORDER BY id FOR UPDATE NOWAIT;
 -- CORE-PATH-V2 V2-7a2: evidence linked to these runs, or to a turn of these conversations.
 linked:=ARRAY(SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids))
  ||ARRAY(SELECT l.evidence_id FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=ANY(sessions));
 research_ids:=ARRAY(SELECT DISTINCT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  JOIN artifact_evidence e ON e.operation_id=o.id WHERE p.actor_id=a AND
   (e.project_id=ANY(projects) OR e.id=ANY(linked)));
 -- 0263 runtime research: conversation searches have no artifact evidence.
 research_plan_ids:=ARRAY(SELECT p.id FROM research_plans p WHERE p.actor_id=a AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids)))));
 research_ids:=research_ids||ARRAY(SELECT o.id FROM research_operations o
  WHERE o.plan_id=ANY(research_plan_ids) AND NOT o.id=ANY(research_ids));
 research_plan_ids:=research_plan_ids||ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));

 -- Research RPCs serialize on the plan. NOWAIT avoids their plan -> project lock inversion.
 PERFORM id FROM research_plans WHERE id=ANY(research_plan_ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM research_operations WHERE id=ANY(research_ids) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM research_operations WHERE id=ANY(research_ids) AND erased_at IS NULL AND
   (NOT research_operation_settled(research_operations) OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO refs FROM jsonb_array_elements_text(scope->'references') v;
 refs:=refs||ids||sessions||projects||versions||contents||rounds;
 -- CORE-PATH-V2 V2-7a2: a report turn's request id is its executionId in the edit and publish requests, which hold the edited text.
 refs:=refs||ARRAY(SELECT request_id FROM turns WHERE actor_id=a AND session_id=ANY(sessions) AND kind='report');
 -- CORE-PATH-V2 V2-10b: a topic turn's request id is its executionId in the topic drafts and the adoption requests.
 refs:=refs||ARRAY(SELECT t.request_id FROM turns t JOIN opc_topic_workspaces w ON w.session_id=t.session_id AND w.actor_id=a
  WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND t.kind='chat');
 -- CORE-PATH-V2 turns: after the account row and their sessions, the order turn_close takes them. A receipt holding one either committed its
 -- response body before this (removed below) or runs after and sees the tombstone (turn_call_record stores no body then).
 PERFORM 1 FROM turns WHERE actor_id=a AND session_id=ANY(sessions) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM artifact_generations g WHERE g.state NOT IN ('succeeded','refunded')
  AND (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;
 UPDATE artifact_projects SET content_deleted_at=stamp WHERE id=ANY(projects) AND content_deleted_at IS NULL;
 -- 0290 fusion compares
 PERFORM fc.id FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs)) ORDER BY fc.id FOR UPDATE NOWAIT;
 DELETE FROM fusion_call_outputs o USING fusion_compares fc
  WHERE o.group_id=fc.group_id AND fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs);
 DELETE FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs));
 -- 0236 fusion reviews
 -- NOWAIT like the session/project/run locks: a claim holding a review row fails this fast (retryable
 -- CONTENT_ERASURE_BUSY) instead of a deadlock (#955 review).
 PERFORM fr.id FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions)) ORDER BY fr.id FOR UPDATE NOWAIT;
 DELETE FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions));
 UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp
  WHERE m.erased_at IS NULL AND EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=m.session_id AND s.actor_id=a)
   AND (m.session_id=ANY(refs) OR m.request_id=ANY(refs)
    OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=m.session_id AND content_erasure_references(rs.scope,refs))
    OR content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)
    OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=ANY(refs)));
 UPDATE bill2_drafts SET revoked=true WHERE actor_id=a AND id IN
  (SELECT (rs.scope->>'draftId')::uuid FROM runtime_sessions rs WHERE rs.id=ANY(sessions) AND rs.scope->>'kind' IN ('positioning_draft','positioning_topic'));
 DELETE FROM runtime_session_names WHERE session_id=ANY(sessions);
 -- A session with a turn still open keeps its (tombstoned, content-free) shell until that turn closes: an erased row is
 -- immutable and the closing turn releases active_turn_id on it. The sweep erases it on a later pass.
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL
  AND active_turn_id IS NULL;
 -- CORE-PATH-V2 conversation content: the provider response bodies of its turns and its message text. The turns and their
 -- receipts are billing records and keep their billing fields (plan 4.6).
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND r.turn_id=t.id;
 UPDATE session_messages SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(deleted_at,stamp)
  WHERE session_id=ANY(sessions) AND (content<>'' OR visible);
 -- The turns behind deleted content (content_erasure_scope), in conversations that stay. One still running would write its receipt and
 -- reply after this cleanup, and the conversation has no tombstone to stop it: the delete waits for it (retryable).
 IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND t.state<>'closed' AND NOT t.session_id=ANY(sessions)) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND r.turn_id=t.id;
 UPDATE session_messages m SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(m.deleted_at,stamp)
  FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND m.session_id=t.session_id AND m.turn_id=t.id AND (m.content<>'' OR m.visible);
 UPDATE opc_content_versions SET body=NULL,title=NULL,erased_at=stamp WHERE id=ANY(contents) AND erased_at IS NULL;
 -- System capture fields and suggestions carry exact execution provenance. Preserve
 -- unrelated manual fields and independently saved published bodies.
 UPDATE artifact_rounds r SET steps=content_erasure_capture_steps(r.steps)
  WHERE r.erased_at IS NULL AND NOT r.id=ANY(rounds)
  AND EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=r.project_id AND p.actor_id=a)
  AND content_erasure_references(r.steps,ids)
  AND r.steps IS DISTINCT FROM content_erasure_capture_steps(r.steps);
 UPDATE artifact_generations g SET input=NULL,result=(SELECT jsonb_object_agg(key,value)
  FROM jsonb_each(coalesce(g.result,'{}')) WHERE key IN ('credits','inputTokens','outputTokens','costUsd')),erased_at=stamp
  WHERE g.erased_at IS NULL AND g.state IN ('succeeded','refunded') AND
   (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs));
 UPDATE agent_slice_executions SET preference_refs=NULL,discussion_refs=NULL,input_hash=NULL,erased_at=stamp
  WHERE erased_at IS NULL AND project_id=ANY(projects);
 UPDATE agent_slice_links SET source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND round_id=ANY(rounds);
 UPDATE opc_library_requests SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (request_id IN (SELECT request_id FROM opc_content_versions WHERE id=ANY(contents))
   OR result->>'id'=ANY(contents::text[]) OR content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_handoffs SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR request_id=ANY(refs)
   OR content_erasure_references(request,refs) OR content_erasure_references(body,refs)
   OR request_id IN (SELECT event.request_id FROM opc_data_events event WHERE event.actor_id=a
    AND event.action='topic_draft' AND (event.execution_id=ANY(ids)
     OR event.turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions)))));
 DELETE FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(ids) OR project_id=ANY(projects)
  OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
  OR target_project_id=ANY(projects) OR source_version_id=ANY(versions));
 -- Frozen source bodies and request caches are system copies, not independent saved content.
 UPDATE opc_turns t SET input_hash=NULL,erased_at=stamp WHERE t.erased_at IS NULL AND
  (t.session_id=ANY(sessions) OR t.round_id=ANY(rounds));
 UPDATE opc_topic_workspaces SET source_hash=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR source_version_id=ANY(versions));
 UPDATE opc_topic_openings SET input=NULL,erased_at=stamp WHERE erased_at IS NULL AND draft_id IN
  (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND (session_id=ANY(sessions) OR project_id=ANY(projects)));
 UPDATE opc_plans SET request=NULL,body=NULL,erased_at=stamp WHERE erased_at IS NULL AND source_version_id=ANY(versions);
 -- Same private-setting removal as account erasure, restricted to the selected family.
 DELETE FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 DELETE FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects);
 DELETE FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 UPDATE opc_item_edits SET title=NULL,brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_items SET brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_accounts SET account_key='erased:'||project_id,erased_at=stamp WHERE erased_at IS NULL AND project_id=ANY(projects);
 -- Guided Skill chats belong to the selected artifact family. Clear snapshots
 -- before message bodies and retain content-free identity shells for accounting.
 UPDATE conversation_context_snapshots SET content=NULL,metadata=NULL,erased_at=stamp
  WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE messages SET content=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_chat_turns SET body=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET is_deleted='true',deleted_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=stamp WHERE project_id=ANY(projects) AND erased_at IS NULL;
 UPDATE artifact_candidates SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_confirmations SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 -- Bound plans include approved operations that were never reserved; erasing them prevents late reserve.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.actor_id=a AND p.erased_at IS NULL AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids))));
 WITH removed AS (
  DELETE FROM research_discoveries d WHERE d.actor_id=a AND (d.session_id=ANY(sessions) OR d.execution_id=ANY(ids)
   OR d.keyword_confirmation_id IN (SELECT confirmation_id FROM research_selection_cards
    WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)))) RETURNING id
 ) DELETE FROM research_selection_cards WHERE actor_id=a AND
  (session_id=ANY(sessions) OR execution_id=ANY(ids) OR discovery_id IN (SELECT id FROM removed));
 -- Deleting only the answer of a later refresh keeps the earlier success of a remaining answer: the record goes back
 -- to that success (the refresh attempt is dropped and can never finish), so it is reused and never paid for again.
 UPDATE research_account_fetches SET state=CASE WHEN state='failed_charged' THEN state ELSE 'succeeded' END,execution_id=last_success_execution_id,evidence=last_success,
   attempt=gen_random_uuid(),refresh_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND execution_id=ANY(ids) AND last_success IS NOT NULL
   AND NOT coalesce(last_success_execution_id=ANY(ids),false) AND NOT coalesce(session_id=ANY(sessions),false);
 -- A sent charged/unknown result must not become payable again when only its answer is removed.
 -- Retain only the session-scoped digest and terminal state; revoke late completion tokens and all private payload.
 UPDATE research_account_fetches SET execution_id=NULL,account=NULL,evidence=NULL,last_success=NULL,
   last_success_execution_id=NULL,refresh_id=NULL,attempt=gen_random_uuid(),updated_at=stamp
 WHERE actor_id=a AND state IN ('failed_charged','unknown')
   AND (execution_id=ANY(ids) OR last_success_execution_id=ANY(ids)) AND NOT coalesce(session_id=ANY(sessions),false);
 DELETE FROM research_account_fetches WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR last_success_execution_id=ANY(ids));
 DELETE FROM research_refresh_grants WHERE actor_id=a AND (session_id=ANY(sessions)
   OR used_execution_id=ANY(ids) OR source_execution_id=ANY(ids));
 DELETE FROM research_discoveries WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0338 session results: a saved result goes with its conversation; erasing only its source reply keeps it (shown as source unavailable).
 DELETE FROM runtime_session_results WHERE actor_id=a AND session_id=ANY(sessions);
 -- 0320 shortfall: the choice card goes with its answer or conversation.
 DELETE FROM research_benchmark_shortfalls WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0268 benchmarks: derived numbers go with their answer, conversation or evidence.
 DELETE FROM research_benchmarks WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR operation_ids && research_ids);
 -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.
 UPDATE research_operations o SET erased_at=stamp,
  result=(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(
   CASE WHEN jsonb_typeof(o.result)='object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key='cost')
 WHERE o.id=ANY(research_ids) AND o.erased_at IS NULL;
 -- Plans contain approved operation IDs/hashes/quote ceilings, never query text. Preserve
 -- mixed plans for unrelated operations; clear only when every approved operation is erased.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.id=ANY(research_plan_ids)
  AND p.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.operations) item
   WHERE NOT EXISTS(SELECT 1 FROM research_operations o WHERE o.plan_id=p.id
    AND o.id::text=item->>'operationId' AND o.erased_at IS NOT NULL));
 UPDATE artifact_evidence SET payload=NULL,content_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR id=ANY(linked));
 UPDATE artifact_requests SET payload=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(payload,'{}'))
  WHERE key IN ('sliceExecution','slicePhase')),response=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=artifact_requests.project_id AND p.actor_id=a)
  AND (project_id=ANY(projects) OR content_erasure_references(payload,refs) OR content_erasure_references(response,refs));
 UPDATE artifact_rounds SET steps=NULL,erased_at=stamp WHERE id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_work_references SET creation_payload=NULL,source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR source_version_id=ANY(versions));
 UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=stamp WHERE id=ANY(projects) AND erased_at IS NULL;
 -- This status is about content. The core-path turns keep their own receipts; no old run is left to leave money pending.
 RETURN jsonb_build_object('kind',k,'id',target,'status',CASE WHEN remaining>0 THEN 'review_required' ELSE 'deleted' END,
  'alreadyDeleted',deleted,'preservedSavedVersions',scope->'preservedSavedVersions','financialReviewCount',remaining);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;


DROP FUNCTION IF EXISTS public.account_erasure_detach_runtime(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.account_erasure_scrub_calls(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.account_erasure_scrub_receipts(p_profile_id uuid, p_run_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.account_erasure_scrub_run(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.content_erasure_financial_allowed(a uuid, pre uuid);
DROP FUNCTION IF EXISTS public.content_erasure_runtime_check(a uuid, eid uuid);

DO $guard$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
  WHERE p.proname <> ALL (ARRAY['account_erasure_detach_runtime','atomic_abort_settle','atomic_finalize_ai_abort','atomic_finalize_ai_failure','atomic_finalize_ai_success','bill2_admin_call_report','bill2_call_erasure_guard','bill2_cancel','bill2_claim','bill2_close','bill2_dispatch','bill2_erasure_closed','bill2_erasure_receipt_projection','bill2_erasure_view','bill2_evidence_immutable','bill2_execution_allowed','bill2_finalize','bill2_payg_absorb_report','bill2_payg_admin_settle_call','bill2_payg_block_lock','bill2_payg_call_stuck','bill2_payg_claim','bill2_payg_compensate','bill2_payg_finalize','bill2_payg_financial_binding','bill2_payg_lock_models','bill2_payg_metering_hash','bill2_payg_metering_review_snapshot','bill2_payg_review_invalidate_receipt','bill2_payg_review_metering','bill2_payg_stuck_calls','bill2_payg_tool_settlement','bill2_payg_validate_quote','bill2_payg_validate_tool_quote','bill2_pending_calls','bill2_prepare','bill2_private_input','bill2_public','bill2_read','bill2_receipt_raw_due','bill2_receipts_scrub_raw','bill2_record','bill2_record_tool','bill2_recovery_claim','bill2_revoke_unstarted_dispatch','bill2_tool_cost_reconcile','bill2_tool_pending_guard','bill2_usage_total','content_erasure_visible','fusion_billing_guard','fusion_call_in_flight','fusion_call_output_save','fusion_call_verdict','fusion_compare_adopt','fusion_compare_begin','fusion_compare_claim','fusion_compare_context','fusion_compare_dispatch_claim','fusion_compare_dispatch_release','fusion_compare_material_guard','fusion_compare_material_token','fusion_compare_read','fusion_compare_stop','fusion_compare_stop_archived','fusion_compare_unjudged','fusion_group_admit','fusion_group_attach','fusion_group_claim','fusion_group_create','fusion_group_fee_guard','fusion_pending_financial_batch','fusion_review_advance','fusion_review_claim','fusion_review_close','fusion_review_end_paused','fusion_review_fee_hold','fusion_review_fee_settle_due','fusion_review_fee_settle_internal','fusion_review_fee_view','fusion_review_pause_idle','fusion_review_unjudged','opc_brief_adoption','opc_content_from_execution','opc_content_reaction','opc_data_execution','opc_plan_request_state','opc_plan_result','opc_save_result','opc_video_execution_check','opc_video_package_from_execution','opc_video_results_from_execution','opc_video_runtime_binding_guard','opc_work_result','report_admission_check','report_fee_hold','report_fee_settle','report_fee_settle_due','report_fee_settle_internal','report_fee_terminal_settlement','report_fee_view','report_stop','research_runtime_call_charge','research_runtime_link','research_user_message','runtime_admission_replay','runtime_admit','runtime_admit_commit','runtime_admit_precheck','runtime_billing_allowed','runtime_binding_guard','runtime_cancel','runtime_cancel_with_code','runtime_context_allowed','runtime_direct_billing_allowed','runtime_direct_billing_allowed_before_opc','runtime_direct_billing_allowed_before_topic','runtime_execution','runtime_execution_visibility','runtime_financial_recovery','runtime_history_availability','runtime_history_availability_before_memo','runtime_history_available','runtime_history_available_before_memo','runtime_interrupt_capacity','runtime_interrupted_recovery','runtime_library_propagate','runtime_library_read','runtime_library_references_freeze','runtime_library_sources_gone','runtime_library_tool_guard','runtime_library_visible','runtime_load_skill_allowed','runtime_load_skill_entry','runtime_load_skill_result_valid','runtime_matching_call_guard','runtime_mentor_history','runtime_mentor_history_draft','runtime_mentor_history_guard','runtime_mentor_messages','runtime_pending_financial_batch','runtime_production_allowed','runtime_production_enabled','runtime_production_recovery_policy','runtime_read_verified','runtime_receipt_saved','runtime_response','runtime_session_context','runtime_session_items','runtime_session_result_save','runtime_source_checkpoint','runtime_stale_charged_rounds','runtime_stale_round_compensate','runtime_stop_loss_call_guard','runtime_stop_loss_settled','runtime_test_budget_guard','runtime_test_dispatch_guard','runtime_test_recovery_policy','runtime_test_window_allowed','runtime_tool','runtime_view','runtime_view_with_work_items','runtime_voice_references_freeze','runtime_voice_source_gone','runtime_voice_sources_gone','runtime_work_items','runtime_workspace_benchmark_guard','runtime_workspace_posts_guard','runtime_workspace_posts_history_erased','runtime_workspace_posts_history_visible','runtime_workspace_posts_receipt_ready','runtime_workspace_tool_guard','voice_billing_scrub','voice_run_recovery'])
    AND p.prosrc ~* '(^|\n)((?!--)[^\n])*\m(runtime_executions|runtime_session_history|runtime_history_dependencies|runtime_tool_calls|runtime_session_batches|runtime_library_references|runtime_voice_references|bill2_runs|bill2_calls|bill2_receipts|bill2_provider_ids|fusion_billing_groups|fusion_billing_group_steps|report_fees|fusion_review_fees)\M';  -- names outside -- comments (no text editing of function source)
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'V2_12_F_REFERENCES_REMAIN_TABLES: %', bad; END IF;
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
  WHERE p.proname <> ALL (ARRAY['account_erasure_detach_runtime','atomic_abort_settle','atomic_finalize_ai_abort','atomic_finalize_ai_failure','atomic_finalize_ai_success','bill2_admin_call_report','bill2_call_erasure_guard','bill2_cancel','bill2_claim','bill2_close','bill2_dispatch','bill2_erasure_closed','bill2_erasure_receipt_projection','bill2_erasure_view','bill2_evidence_immutable','bill2_execution_allowed','bill2_finalize','bill2_payg_absorb_report','bill2_payg_admin_settle_call','bill2_payg_block_lock','bill2_payg_call_stuck','bill2_payg_claim','bill2_payg_compensate','bill2_payg_finalize','bill2_payg_financial_binding','bill2_payg_lock_models','bill2_payg_metering_hash','bill2_payg_metering_review_snapshot','bill2_payg_review_invalidate_receipt','bill2_payg_review_metering','bill2_payg_stuck_calls','bill2_payg_tool_settlement','bill2_payg_validate_quote','bill2_payg_validate_tool_quote','bill2_pending_calls','bill2_prepare','bill2_private_input','bill2_public','bill2_read','bill2_receipt_raw_due','bill2_receipts_scrub_raw','bill2_record','bill2_record_tool','bill2_recovery_claim','bill2_revoke_unstarted_dispatch','bill2_tool_cost_reconcile','bill2_tool_pending_guard','bill2_usage_total','content_erasure_visible','fusion_billing_guard','fusion_call_in_flight','fusion_call_output_save','fusion_call_verdict','fusion_compare_adopt','fusion_compare_begin','fusion_compare_claim','fusion_compare_context','fusion_compare_dispatch_claim','fusion_compare_dispatch_release','fusion_compare_material_guard','fusion_compare_material_token','fusion_compare_read','fusion_compare_stop','fusion_compare_stop_archived','fusion_compare_unjudged','fusion_group_admit','fusion_group_attach','fusion_group_claim','fusion_group_create','fusion_group_fee_guard','fusion_pending_financial_batch','fusion_review_advance','fusion_review_claim','fusion_review_close','fusion_review_end_paused','fusion_review_fee_hold','fusion_review_fee_settle_due','fusion_review_fee_settle_internal','fusion_review_fee_view','fusion_review_pause_idle','fusion_review_unjudged','opc_brief_adoption','opc_content_from_execution','opc_content_reaction','opc_data_execution','opc_plan_request_state','opc_plan_result','opc_save_result','opc_video_execution_check','opc_video_package_from_execution','opc_video_results_from_execution','opc_video_runtime_binding_guard','opc_work_result','report_admission_check','report_fee_hold','report_fee_settle','report_fee_settle_due','report_fee_settle_internal','report_fee_terminal_settlement','report_fee_view','report_stop','research_runtime_call_charge','research_runtime_link','research_user_message','runtime_admission_replay','runtime_admit','runtime_admit_commit','runtime_admit_precheck','runtime_billing_allowed','runtime_binding_guard','runtime_cancel','runtime_cancel_with_code','runtime_context_allowed','runtime_direct_billing_allowed','runtime_direct_billing_allowed_before_opc','runtime_direct_billing_allowed_before_topic','runtime_execution','runtime_execution_visibility','runtime_financial_recovery','runtime_history_availability','runtime_history_availability_before_memo','runtime_history_available','runtime_history_available_before_memo','runtime_interrupt_capacity','runtime_interrupted_recovery','runtime_library_propagate','runtime_library_read','runtime_library_references_freeze','runtime_library_sources_gone','runtime_library_tool_guard','runtime_library_visible','runtime_load_skill_allowed','runtime_load_skill_entry','runtime_load_skill_result_valid','runtime_matching_call_guard','runtime_mentor_history','runtime_mentor_history_draft','runtime_mentor_history_guard','runtime_mentor_messages','runtime_pending_financial_batch','runtime_production_allowed','runtime_production_enabled','runtime_production_recovery_policy','runtime_read_verified','runtime_receipt_saved','runtime_response','runtime_session_context','runtime_session_items','runtime_session_result_save','runtime_source_checkpoint','runtime_stale_charged_rounds','runtime_stale_round_compensate','runtime_stop_loss_call_guard','runtime_stop_loss_settled','runtime_test_budget_guard','runtime_test_dispatch_guard','runtime_test_recovery_policy','runtime_test_window_allowed','runtime_tool','runtime_view','runtime_view_with_work_items','runtime_voice_references_freeze','runtime_voice_source_gone','runtime_voice_sources_gone','runtime_work_items','runtime_workspace_benchmark_guard','runtime_workspace_posts_guard','runtime_workspace_posts_history_erased','runtime_workspace_posts_history_visible','runtime_workspace_posts_receipt_ready','runtime_workspace_tool_guard','voice_billing_scrub','voice_run_recovery'])
    AND p.prosrc ~* '(^|\n)((?!--)[^\n])*\m(account_erasure_detach_runtime|atomic_abort_settle|atomic_finalize_ai_abort|atomic_finalize_ai_failure|atomic_finalize_ai_success|bill2_admin_call_report|bill2_call_erasure_guard|bill2_cancel|bill2_claim|bill2_close|bill2_dispatch|bill2_erasure_closed|bill2_erasure_receipt_projection|bill2_erasure_view|bill2_evidence_immutable|bill2_execution_allowed|bill2_finalize|bill2_payg_absorb_report|bill2_payg_admin_settle_call|bill2_payg_block_lock|bill2_payg_call_stuck|bill2_payg_claim|bill2_payg_compensate|bill2_payg_finalize|bill2_payg_financial_binding|bill2_payg_lock_models|bill2_payg_metering_hash|bill2_payg_metering_review_snapshot|bill2_payg_review_invalidate_receipt|bill2_payg_review_metering|bill2_payg_stuck_calls|bill2_payg_tool_settlement|bill2_payg_validate_quote|bill2_payg_validate_tool_quote|bill2_pending_calls|bill2_prepare|bill2_private_input|bill2_public|bill2_read|bill2_receipt_raw_due|bill2_receipts_scrub_raw|bill2_record|bill2_record_tool|bill2_recovery_claim|bill2_revoke_unstarted_dispatch|bill2_tool_cost_reconcile|bill2_tool_pending_guard|bill2_usage_total|content_erasure_visible|fusion_billing_guard|fusion_call_in_flight|fusion_call_output_save|fusion_call_verdict|fusion_compare_adopt|fusion_compare_begin|fusion_compare_claim|fusion_compare_context|fusion_compare_dispatch_claim|fusion_compare_dispatch_release|fusion_compare_material_guard|fusion_compare_material_token|fusion_compare_read|fusion_compare_stop|fusion_compare_stop_archived|fusion_compare_unjudged|fusion_group_admit|fusion_group_attach|fusion_group_claim|fusion_group_create|fusion_group_fee_guard|fusion_pending_financial_batch|fusion_review_advance|fusion_review_claim|fusion_review_close|fusion_review_end_paused|fusion_review_fee_hold|fusion_review_fee_settle_due|fusion_review_fee_settle_internal|fusion_review_fee_view|fusion_review_pause_idle|fusion_review_unjudged|opc_brief_adoption|opc_content_from_execution|opc_content_reaction|opc_data_execution|opc_plan_request_state|opc_plan_result|opc_save_result|opc_video_execution_check|opc_video_package_from_execution|opc_video_results_from_execution|opc_video_runtime_binding_guard|opc_work_result|report_admission_check|report_fee_hold|report_fee_settle|report_fee_settle_due|report_fee_settle_internal|report_fee_terminal_settlement|report_fee_view|report_stop|research_runtime_call_charge|research_runtime_link|research_user_message|runtime_admission_replay|runtime_admit|runtime_admit_commit|runtime_admit_precheck|runtime_billing_allowed|runtime_binding_guard|runtime_cancel|runtime_cancel_with_code|runtime_context_allowed|runtime_direct_billing_allowed|runtime_direct_billing_allowed_before_opc|runtime_direct_billing_allowed_before_topic|runtime_execution|runtime_execution_visibility|runtime_financial_recovery|runtime_history_availability|runtime_history_availability_before_memo|runtime_history_available|runtime_history_available_before_memo|runtime_interrupt_capacity|runtime_interrupted_recovery|runtime_library_propagate|runtime_library_read|runtime_library_references_freeze|runtime_library_sources_gone|runtime_library_tool_guard|runtime_library_visible|runtime_load_skill_allowed|runtime_load_skill_entry|runtime_load_skill_result_valid|runtime_matching_call_guard|runtime_mentor_history|runtime_mentor_history_draft|runtime_mentor_history_guard|runtime_mentor_messages|runtime_pending_financial_batch|runtime_production_allowed|runtime_production_enabled|runtime_production_recovery_policy|runtime_read_verified|runtime_receipt_saved|runtime_response|runtime_session_context|runtime_session_items|runtime_session_result_save|runtime_source_checkpoint|runtime_stale_charged_rounds|runtime_stale_round_compensate|runtime_stop_loss_call_guard|runtime_stop_loss_settled|runtime_test_budget_guard|runtime_test_dispatch_guard|runtime_test_recovery_policy|runtime_test_window_allowed|runtime_tool|runtime_view|runtime_view_with_work_items|runtime_voice_references_freeze|runtime_voice_source_gone|runtime_voice_sources_gone|runtime_work_items|runtime_workspace_benchmark_guard|runtime_workspace_posts_guard|runtime_workspace_posts_history_erased|runtime_workspace_posts_history_visible|runtime_workspace_posts_receipt_ready|runtime_workspace_tool_guard|voice_billing_scrub|voice_run_recovery)\s*\(';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'V2_12_F_REFERENCES_REMAIN_FUNCTIONS: %', bad; END IF;
END
$guard$;

-- Old fusion call outputs: emptied (fusion_turn_outputs, the turn path's, is kept).
DELETE FROM public.fusion_call_outputs;

ALTER TABLE public.token_stats DROP CONSTRAINT IF EXISTS token_stats_bill2_run_id_fkey;
ALTER TABLE public.ai_usage_logs DROP CONSTRAINT IF EXISTS ai_usage_logs_bill2_run_id_fkey;
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_bill2_run_id_fkey;
ALTER TABLE public.opc_result_links DROP CONSTRAINT IF EXISTS opc_result_links_execution_id_fkey;
ALTER TABLE public.opc_content_versions DROP CONSTRAINT IF EXISTS opc_content_versions_execution_id_fkey;
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_bill2_call_id_fkey;
ALTER TABLE public.token_stats DROP CONSTRAINT IF EXISTS token_stats_bill2_call_id_fkey;
ALTER TABLE public.ai_usage_logs DROP CONSTRAINT IF EXISTS ai_usage_logs_bill2_call_id_fkey;
ALTER TABLE public.opc_data_events DROP CONSTRAINT IF EXISTS opc_data_events_execution_id_fkey;
ALTER TABLE public.fusion_call_outputs DROP CONSTRAINT IF EXISTS fusion_call_outputs_call_ref;
ALTER TABLE public.fusion_call_outputs DROP CONSTRAINT IF EXISTS fusion_call_outputs_run_ref;
ALTER TABLE public.fusion_call_outputs DROP CONSTRAINT IF EXISTS fusion_call_outputs_group_ref;
ALTER TABLE public.research_operations DROP CONSTRAINT IF EXISTS research_operations_bill2_call_id_fkey;
ALTER TABLE public.research_plans DROP CONSTRAINT IF EXISTS research_plans_execution_id_fkey;
ALTER TABLE public.research_selection_cards DROP CONSTRAINT IF EXISTS research_selection_cards_execution_id_fkey;
ALTER TABLE public.research_discoveries DROP CONSTRAINT IF EXISTS research_discoveries_execution_id_fkey;
ALTER TABLE public.research_account_fetches DROP CONSTRAINT IF EXISTS research_account_fetches_execution_id_fkey;
ALTER TABLE public.research_account_fetches DROP CONSTRAINT IF EXISTS research_account_fetches_last_success_execution_id_fkey;
ALTER TABLE public.research_refresh_grants DROP CONSTRAINT IF EXISTS research_refresh_grants_used_execution_id_fkey;
ALTER TABLE public.research_refresh_grants DROP CONSTRAINT IF EXISTS research_refresh_grants_source_execution_id_fkey;
ALTER TABLE public.research_benchmarks DROP CONSTRAINT IF EXISTS research_benchmarks_execution_id_fkey;
ALTER TABLE public.fusion_compares DROP CONSTRAINT IF EXISTS fusion_compares_group_ref;
ALTER TABLE public.research_benchmark_shortfalls DROP CONSTRAINT IF EXISTS research_benchmark_shortfalls_execution_id_fkey;
ALTER TABLE public.runtime_session_results DROP CONSTRAINT IF EXISTS runtime_session_results_source_execution_id_fkey;

DROP TRIGGER IF EXISTS bill2_payg_zz_block_lock ON public.bill2_calls;
DROP TRIGGER IF EXISTS bill2_evidence_immutable ON public.bill2_receipts;
DROP TRIGGER IF EXISTS runtime_a_test_dispatch_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_matching_call_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_test_budget_guard ON public.bill2_runs;
DROP TRIGGER IF EXISTS opc_video_runtime_binding_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS a_erased_row_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS a_erased_row_guard ON public.runtime_history_dependencies;
DROP TRIGGER IF EXISTS a_erased_row_guard ON public.runtime_session_batches;
DROP TRIGGER IF EXISTS a_erased_row_guard ON public.runtime_session_history;
DROP TRIGGER IF EXISTS a_erased_row_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS bill2_payg_review_call_changed ON public.bill2_calls;
DROP TRIGGER IF EXISTS bill2_payg_review_receipt_added ON public.bill2_receipts;
DROP TRIGGER IF EXISTS bill2_run_erasure_guard ON public.bill2_runs;
DROP TRIGGER IF EXISTS bill2_call_erasure_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_binding_guard ON public.bill2_runs;
DROP TRIGGER IF EXISTS content_erasure_marker_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS content_erasure_marker_guard ON public.bill2_runs;
DROP TRIGGER IF EXISTS content_erasure_execution_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.runtime_session_history;
DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.runtime_session_batches;
DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.runtime_history_dependencies;
DROP TRIGGER IF EXISTS runtime_stop_loss_call_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_stop_loss_settlement_lock ON public.credit_transactions;
DROP TRIGGER IF EXISTS runtime_stop_loss_settled ON public.credit_transactions;
DROP TRIGGER IF EXISTS runtime_workspace_tool_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS runtime_mentor_history_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS fusion_billing_run_guard ON public.bill2_runs;
DROP TRIGGER IF EXISTS fusion_billing_call_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS bill2_calls_kind_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_library_references_freeze ON public.runtime_executions;
DROP TRIGGER IF EXISTS a_runtime_library_tool_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS fusion_group_fee_guard ON public.fusion_billing_groups;
DROP TRIGGER IF EXISTS runtime_workspace_benchmark_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS runtime_workspace_posts_guard ON public.runtime_tool_calls;
DROP TRIGGER IF EXISTS runtime_voice_references_freeze ON public.runtime_executions;
DROP TRIGGER IF EXISTS report_fee_terminal_settlement ON public.runtime_executions;

DROP FUNCTION IF EXISTS public.runtime_session_result_save(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_request_id uuid, p_result_type text, p_title text, p_excerpt text);
DROP FUNCTION IF EXISTS public.fusion_compare_unjudged(p_limit integer);
DROP FUNCTION IF EXISTS public.fusion_compare_dispatch_claim(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.runtime_production_enabled();
DROP FUNCTION IF EXISTS public.runtime_production_recovery_policy(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_dispatch_release(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_public(r bill2_runs);
DROP FUNCTION IF EXISTS public.voice_run_recovery(p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_prepare(p_actor_id uuid, p_request_id uuid, p_payload jsonb);
DROP FUNCTION IF EXISTS public.bill2_private_input(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_pending_calls(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.voice_billing_scrub(p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_load_skill_entry(e runtime_executions, p_arguments jsonb);
DROP FUNCTION IF EXISTS public.runtime_load_skill_allowed(e runtime_executions, p_call_id text, p_arguments jsonb);
DROP FUNCTION IF EXISTS public.runtime_load_skill_result_valid(e runtime_executions, p_arguments jsonb, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_voice_references_freeze();
DROP FUNCTION IF EXISTS public.runtime_voice_source_gone(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_voice_sources_gone(p_actor_id uuid, p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_execution_visibility(p_actor_id uuid, p_execution_id uuid, p_voice boolean, p_library boolean);
DROP FUNCTION IF EXISTS public.runtime_history_available_before_memo(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_view_with_work_items(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_block_lock();
DROP FUNCTION IF EXISTS public.runtime_history_available(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_history_availability(p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_history_erased(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_history_visible(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_receipt_ready(p jsonb, c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_receipt_raw_due(x bill2_receipts);
DROP FUNCTION IF EXISTS public.bill2_receipts_scrub_raw(p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_read_verified(a uuid, eid uuid);
DROP FUNCTION IF EXISTS public.bill2_execution_allowed(a uuid, p jsonb);
DROP FUNCTION IF EXISTS public.atomic_abort_settle(p_user_id uuid, p_pre_deduct_id uuid, p_consumed_credits integer, p_consumed_tokens jsonb, p_model_id text, p_reason text);
DROP FUNCTION IF EXISTS public.atomic_finalize_ai_success(p_user_id uuid, p_conversation_id uuid, p_user_message text, p_assistant_message text, p_model_used text, p_total_cost_usd numeric, p_total_credits integer, p_pre_deduct_id uuid, p_usage jsonb, p_token_metadata jsonb, p_usage_metadata jsonb, p_request_id text, p_input_length integer, p_latency_ms integer, p_search_count integer, p_ip_address text, p_user_agent text);
DROP FUNCTION IF EXISTS public.bill2_record(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb);
DROP FUNCTION IF EXISTS public.bill2_cancel(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_interrupted_recovery(p_actor_id uuid, p_execution_id uuid, p_epoch bigint, p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_finalize(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_usage_total(rid uuid, field text);
DROP FUNCTION IF EXISTS public.atomic_finalize_ai_abort(p_user_id uuid, p_conversation_id uuid, p_user_message text, p_partial_assistant_message text, p_model_used text, p_total_cost_usd numeric, p_consumed_credits integer, p_pre_deduct_id uuid, p_usage jsonb, p_token_metadata jsonb, p_usage_metadata jsonb, p_request_id text, p_input_length integer, p_latency_ms integer, p_search_count integer, p_ip_address text, p_user_agent text);
DROP FUNCTION IF EXISTS public.report_fee_terminal_settlement();
DROP FUNCTION IF EXISTS public.runtime_binding_guard();
DROP FUNCTION IF EXISTS public.runtime_direct_billing_allowed_before_opc(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_erasure_closed(a uuid, pre uuid);
DROP FUNCTION IF EXISTS public.bill2_erasure_view(r bill2_runs, is_closed boolean);
DROP FUNCTION IF EXISTS public.report_stop(p_actor_id uuid, p_execution_id uuid, p_stop jsonb, p_confirmed boolean);
DROP FUNCTION IF EXISTS public.runtime_admission_replay(p_actor_id uuid, p_request_id uuid, p_request jsonb);
DROP FUNCTION IF EXISTS public.runtime_cancel(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_execution(p_actor_id uuid, p_execution_id uuid, p_action text, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_billing_allowed(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_admit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb);
DROP FUNCTION IF EXISTS public.runtime_matching_call_guard();
DROP FUNCTION IF EXISTS public.fusion_review_end_paused(p_idle interval, p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_receipt_saved(p_actor_id uuid, p_execution_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb);
DROP FUNCTION IF EXISTS public.runtime_session_items(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_action text, p_items jsonb, p_limit integer, p_batch integer);
DROP FUNCTION IF EXISTS public.runtime_tool(p_actor_id uuid, p_execution_id uuid, p_call_id text, p_name text, p_arguments jsonb, p_action text, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_admit_precheck(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb);
DROP FUNCTION IF EXISTS public.runtime_admit_commit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb, p_pre jsonb);
DROP FUNCTION IF EXISTS public.opc_work_result(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_library_sources_gone(p_actor_id uuid, p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_direct_billing_allowed_before_topic(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_test_dispatch_guard();
DROP FUNCTION IF EXISTS public.bill2_claim(p_actor_id uuid, p_run_id uuid, p_sequence integer, p_payload jsonb);
DROP FUNCTION IF EXISTS public.runtime_test_recovery_policy(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_test_window_allowed(a uuid, p jsonb);
DROP FUNCTION IF EXISTS public.opc_plan_request_state(p_actor_id uuid, p_draft_id uuid, p_request_id uuid);
DROP FUNCTION IF EXISTS public.runtime_direct_billing_allowed(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_read(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_finalize(a uuid, rid uuid);
DROP FUNCTION IF EXISTS public.opc_video_runtime_binding_guard();
DROP FUNCTION IF EXISTS public.opc_video_results_from_execution(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_execution_id uuid, p_source_script_id uuid, p_expected_storyboard_version bigint, p_expected_editing_version bigint, p_storyboard boolean, p_editing boolean);
DROP FUNCTION IF EXISTS public.runtime_workspace_benchmark_guard();
DROP FUNCTION IF EXISTS public.opc_content_from_execution(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_expected_version bigint, p_kind text, p_status text, p_execution_id uuid, p_source_content_id uuid);
DROP FUNCTION IF EXISTS public.opc_video_package_from_execution(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_execution_id uuid, p_source_script_id uuid, p_expected_storyboard_version bigint, p_expected_editing_version bigint);
DROP FUNCTION IF EXISTS public.fusion_review_pause_idle(p_idle interval);
DROP FUNCTION IF EXISTS public.runtime_view(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_stale_charged_rounds(p_cutoff timestamp with time zone, p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_payg_call_stuck(c bill2_calls, r bill2_runs);
DROP FUNCTION IF EXISTS public.research_runtime_call_charge(a uuid, s uuid, e uuid, p_call uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_admin_settle_call(p_admin_id uuid, p_request_id uuid, p_call_id uuid, p_verified_cost_usd numeric, p_reason text);
DROP FUNCTION IF EXISTS public.opc_video_execution_check(p_actor_id uuid, p_work_item_id uuid, p_execution_id uuid, p_source_script_id uuid);
DROP FUNCTION IF EXISTS public.runtime_library_read(p_actor_id uuid, p_execution_id uuid, p_query text);
DROP FUNCTION IF EXISTS public.runtime_history_availability_before_memo(p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.atomic_finalize_ai_failure(p_user_id uuid, p_model_used text, p_reason text, p_pre_deduct_id uuid, p_conversation_id uuid, p_request_id text, p_input_length integer, p_latency_ms integer, p_ip_address text, p_user_agent text, p_usage_metadata jsonb);
DROP FUNCTION IF EXISTS public.runtime_test_budget_guard();
DROP FUNCTION IF EXISTS public.bill2_payg_lock_models(r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_payg_financial_binding(r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_payg_absorb_report(p_from timestamp with time zone, p_to timestamp with time zone);
DROP FUNCTION IF EXISTS public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_validate_quote(r bill2_runs, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_recovery_claim(p_actor_id uuid, p_run_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean);
DROP FUNCTION IF EXISTS public.bill2_payg_review_invalidate_receipt();
DROP FUNCTION IF EXISTS public.bill2_payg_metering_hash(c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_payg_metering_review_snapshot(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_review_metering(p_actor_id uuid, p_call_id uuid, p_request_id uuid, p_review jsonb);
DROP FUNCTION IF EXISTS public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean);
DROP FUNCTION IF EXISTS public.bill2_call_erasure_guard();
DROP FUNCTION IF EXISTS public.bill2_erasure_receipt_projection(e jsonb, c bill2_calls);
DROP FUNCTION IF EXISTS public.fusion_group_claim(p_actor_id uuid, p_group_id uuid, p_step_key text, p_attempt integer, p_items jsonb);
DROP FUNCTION IF EXISTS public.runtime_mentor_messages(p_actor_id uuid, e runtime_executions);
DROP FUNCTION IF EXISTS public.account_erasure_detach_runtime(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.content_erasure_visible(a uuid, eid uuid);
DROP FUNCTION IF EXISTS public.runtime_stop_loss_call_guard();
DROP FUNCTION IF EXISTS public.bill2_evidence_immutable();
DROP FUNCTION IF EXISTS public.bill2_close(p_actor_id uuid, p_run_id uuid, p_outcome text, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_session_context(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_response(p_actor_id uuid, p_execution_id uuid, p_sequence integer, p_request_hash text);
DROP FUNCTION IF EXISTS public.runtime_stop_loss_settled();
DROP FUNCTION IF EXISTS public.runtime_cancel_with_code(p_actor_id uuid, p_execution_id uuid, p_code text);
DROP FUNCTION IF EXISTS public.opc_data_execution(a uuid, eid uuid);
DROP FUNCTION IF EXISTS public.opc_content_reaction(p_actor_id uuid, p_request_id uuid, p_execution_id uuid, p_action text, p_reason text);
DROP FUNCTION IF EXISTS public.fusion_call_in_flight(c bill2_calls);
DROP FUNCTION IF EXISTS public.runtime_workspace_tool_guard();
DROP FUNCTION IF EXISTS public.runtime_stale_round_compensate(p_run_id uuid, p_cutoff timestamp with time zone);
DROP FUNCTION IF EXISTS public.runtime_context_allowed(p_actor_id uuid, p_context jsonb);
DROP FUNCTION IF EXISTS public.runtime_mentor_history_draft(p_actor_id uuid, e runtime_executions);
DROP FUNCTION IF EXISTS public.runtime_mentor_history_guard();
DROP FUNCTION IF EXISTS public.fusion_billing_guard();
DROP FUNCTION IF EXISTS public.runtime_mentor_history(p_actor_id uuid, p_execution_id uuid, p_query text);
DROP FUNCTION IF EXISTS public.fusion_group_create(p_actor_id uuid, p_request_id uuid, p_kind text);
DROP FUNCTION IF EXISTS public.opc_brief_adoption(p_actor_id uuid, p_request_id uuid, p_work_item_id uuid, p_expected_revision bigint, p_execution_id uuid, p_original text, p_brief text);
DROP FUNCTION IF EXISTS public.fusion_group_admit(p_actor_id uuid, p_request_id uuid, p_kind text, p_source_session_id uuid, p_runs jsonb);
DROP FUNCTION IF EXISTS public.fusion_call_output_save(p_actor_id uuid, p_call_id uuid, p_body text);
DROP FUNCTION IF EXISTS public.fusion_group_create(p_actor_id uuid, p_request_id uuid, p_kind text, p_source_session_id uuid);
DROP FUNCTION IF EXISTS public.fusion_call_verdict(p_actor_id uuid, p_call_id uuid, p_verdict text);
DROP FUNCTION IF EXISTS public.fusion_pending_financial_batch(p_limit integer, p_after_created timestamp with time zone, p_after_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_claim(p_actor_id uuid, p_review_id uuid, p_round integer, p_phase text, p_attempt integer, p_group_id uuid, p_items jsonb);
DROP FUNCTION IF EXISTS public.fusion_review_advance(p_actor_id uuid, p_review_id uuid, p_from jsonb, p_to jsonb);
DROP FUNCTION IF EXISTS public.fusion_review_close(p_actor_id uuid, p_review_id uuid, p_state text);
DROP FUNCTION IF EXISTS public.bill2_tool_pending_guard(p_call_id uuid);
DROP FUNCTION IF EXISTS public.opc_plan_result(p_actor_id uuid, p_draft_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.bill2_record_tool(r bill2_runs, c bill2_calls, e jsonb, h text, erasing boolean);
DROP FUNCTION IF EXISTS public.runtime_pending_financial_batch(p_actor_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_admin_call_report(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_payg_validate_tool_quote(r bill2_runs, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_tool_settlement(r bill2_runs, c bill2_calls, erasing boolean);
DROP FUNCTION IF EXISTS public.bill2_tool_cost_reconcile(p_admin_id uuid, p_call_id uuid, p_cost text, p_evidence_hash text);
DROP FUNCTION IF EXISTS public.fusion_review_unjudged(p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_payg_stuck_calls(p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_library_references_freeze();
DROP FUNCTION IF EXISTS public.research_user_message(a uuid, s uuid, e uuid);
DROP FUNCTION IF EXISTS public.runtime_library_tool_guard();
DROP FUNCTION IF EXISTS public.runtime_library_propagate(p_actor_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_work_items(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_begin(p_actor_id uuid, p_request_id uuid, p_session_id uuid, p_request jsonb);
DROP FUNCTION IF EXISTS public.research_runtime_link(a uuid, p_plan uuid, s uuid, e uuid, p_discovery uuid, p_operation uuid, p_call uuid);
DROP FUNCTION IF EXISTS public.bill2_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_rotate boolean, p_payload jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_compensate(r bill2_runs, c bill2_calls);
DROP FUNCTION IF EXISTS public.runtime_source_checkpoint(p_actor_id uuid, s runtime_sessions, e runtime_executions, b bill2_runs, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_interrupt_capacity(p_actor_id uuid, p_execution_id uuid, p_epoch bigint, p_code text);
DROP FUNCTION IF EXISTS public.runtime_stale_charged_rounds(p_cutoff timestamp with time zone, p_limit integer, p_created_since timestamp with time zone);
DROP FUNCTION IF EXISTS public.runtime_production_allowed(a uuid, p jsonb, p_prepare boolean);
DROP FUNCTION IF EXISTS public.fusion_compare_read(p_actor_id uuid, p_compare_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_claim(p_actor_id uuid, p_compare_id uuid, p_items jsonb);
DROP FUNCTION IF EXISTS public.fusion_compare_stop(p_actor_id uuid, p_compare_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.fusion_group_fee_guard();
DROP FUNCTION IF EXISTS public.fusion_compare_adopt(p_actor_id uuid, p_compare_id uuid, p_column integer, p_request_id uuid, p_billing jsonb, p_items jsonb);
DROP FUNCTION IF EXISTS public.fusion_review_fee_hold(rv fusion_reviews, v jsonb, cfg jsonb);
DROP FUNCTION IF EXISTS public.fusion_review_fee_view(p_review_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_fee_settle_internal(p_review_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_fee_settle_due(p_limit integer);
DROP FUNCTION IF EXISTS public.report_fee_view(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.report_fee_hold(e runtime_executions, billing jsonb);
DROP FUNCTION IF EXISTS public.report_fee_settle_internal(p_execution_id uuid, p_refund boolean);
DROP FUNCTION IF EXISTS public.report_fee_settle(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_guard();
DROP FUNCTION IF EXISTS public.report_fee_settle_due(p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_library_visible(p_actor_id uuid, p_execution_id uuid, p_result jsonb);
DROP FUNCTION IF EXISTS public.fusion_compare_stop_archived(p_actor_id uuid, p_request_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_material_token(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_material_guard(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_context(p_actor_id uuid, p_session_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.report_admission_check(a uuid, sid uuid, context jsonb, billing jsonb);
DROP FUNCTION IF EXISTS public.opc_save_result(p_actor_id uuid, p_draft_id uuid, p_execution_id uuid, p_step_id text, p_request_id uuid);
DROP FUNCTION IF EXISTS public.fusion_group_attach(p_actor_id uuid, p_group_id uuid, p_run_id uuid);

DROP TABLE IF EXISTS public.runtime_executions, public.runtime_session_history, public.runtime_history_dependencies, public.runtime_tool_calls, public.runtime_session_batches, public.runtime_library_references, public.runtime_voice_references, public.bill2_runs, public.bill2_calls, public.bill2_receipts, public.bill2_provider_ids, public.fusion_billing_groups, public.fusion_billing_group_steps, public.report_fees, public.fusion_review_fees;

COMMIT;
