-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch F: IRREVERSIBLE. Drops the old runtime / BILL2 path: 15 tables and 164 functions, and the foreign keys
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
   WHERE x.settlement='done' AND NOT EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id=x.actor_id)),
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

DO $guard$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
  WHERE p.proname <> ALL (ARRAY['atomic_abort_settle','atomic_finalize_ai_abort','atomic_finalize_ai_failure','atomic_finalize_ai_success','bill2_admin_call_report','bill2_call_erasure_guard','bill2_cancel','bill2_claim','bill2_close','bill2_dispatch','bill2_erasure_closed','bill2_erasure_receipt_projection','bill2_erasure_view','bill2_evidence_immutable','bill2_execution_allowed','bill2_finalize','bill2_payg_absorb_report','bill2_payg_admin_settle_call','bill2_payg_block_lock','bill2_payg_call_stuck','bill2_payg_claim','bill2_payg_compensate','bill2_payg_finalize','bill2_payg_financial_binding','bill2_payg_lock_models','bill2_payg_metering_hash','bill2_payg_metering_review_snapshot','bill2_payg_review_invalidate_receipt','bill2_payg_review_metering','bill2_payg_stuck_calls','bill2_payg_tool_settlement','bill2_payg_validate_quote','bill2_payg_validate_tool_quote','bill2_pending_calls','bill2_prepare','bill2_private_input','bill2_public','bill2_read','bill2_receipt_raw_due','bill2_receipts_scrub_raw','bill2_record','bill2_record_tool','bill2_recovery_claim','bill2_revoke_unstarted_dispatch','bill2_tool_cost_reconcile','bill2_tool_pending_guard','bill2_usage_total','content_erasure_visible','fusion_billing_guard','fusion_call_in_flight','fusion_compare_adopt','fusion_compare_begin','fusion_compare_claim','fusion_compare_dispatch_claim','fusion_compare_dispatch_release','fusion_compare_read','fusion_compare_stop','fusion_compare_unjudged','fusion_pending_financial_batch','fusion_review_end_paused','fusion_review_fee_hold','fusion_review_fee_settle','fusion_review_fee_settle_due','fusion_review_fee_settle_internal','fusion_review_fee_view','fusion_review_pause_idle','fusion_review_unjudged','opc_brief_adoption','opc_content_from_execution','opc_content_reaction','opc_data_execution','opc_plan_request_state','opc_plan_result','opc_save_result','opc_video_execution_check','opc_video_package_from_execution','opc_video_results_from_execution','report_admission_check','report_fee_hold','report_fee_settle','report_fee_settle_due','report_fee_settle_internal','report_fee_terminal_settlement','report_fee_view','report_stop','research_runtime_call_charge','research_runtime_link','research_user_message','runtime_admission_replay','runtime_admit','runtime_admit_commit','runtime_admit_precheck','runtime_billing_allowed','runtime_binding_guard','runtime_cancel','runtime_cancel_with_code','runtime_context_allowed','runtime_direct_billing_allowed','runtime_direct_billing_allowed_before_opc','runtime_direct_billing_allowed_before_topic','runtime_execution','runtime_execution_visibility','runtime_financial_recovery','runtime_history_availability','runtime_history_availability_before_memo','runtime_history_available','runtime_history_available_before_memo','runtime_interrupt_capacity','runtime_interrupted_recovery','runtime_library_propagate','runtime_library_read','runtime_library_references_freeze','runtime_library_sources_gone','runtime_library_tool_guard','runtime_library_visible','runtime_load_skill_allowed','runtime_load_skill_entry','runtime_load_skill_result_valid','runtime_matching_call_guard','runtime_mentor_history','runtime_mentor_history_draft','runtime_mentor_history_guard','runtime_mentor_messages','runtime_pending_financial_batch','runtime_positioning_gate','runtime_production_recovery_policy','runtime_read_verified','runtime_receipt_saved','runtime_response','runtime_session_context','runtime_session_items','runtime_session_result_edit','runtime_session_result_save','runtime_session_result_save_turn','runtime_session_result_turn_view','runtime_session_result_versions','runtime_session_result_view','runtime_session_results_list','runtime_session_results_list_turns','runtime_source_checkpoint','runtime_stale_charged_rounds','runtime_stale_round_compensate','runtime_stop_loss_call_guard','runtime_stop_loss_settled','runtime_test_actor_access','runtime_test_budget_guard','runtime_test_dispatch_guard','runtime_test_recovery_policy','runtime_tool','runtime_view','runtime_view_with_work_items','runtime_voice_references_freeze','runtime_voice_source_gone','runtime_voice_sources_gone','runtime_work_items','runtime_workspace_benchmark_guard','runtime_workspace_posts_guard','runtime_workspace_posts_history_erased','runtime_workspace_posts_history_visible','runtime_workspace_posts_receipt_ready','runtime_workspace_tool_guard','voice_billing_scrub','voice_run_recovery'])
    AND regexp_replace(p.prosrc,'--[^\n]*','','g') ~* '\m(runtime_executions|runtime_session_history|runtime_history_dependencies|runtime_tool_calls|runtime_session_batches|runtime_library_references|runtime_voice_references|bill2_runs|bill2_calls|bill2_receipts|bill2_provider_ids|fusion_billing_groups|fusion_billing_group_steps|report_fees|fusion_review_fees)\M';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'V2_12_F_REFERENCES_REMAIN_TABLES: %', bad; END IF;
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
  WHERE p.proname <> ALL (ARRAY['atomic_abort_settle','atomic_finalize_ai_abort','atomic_finalize_ai_failure','atomic_finalize_ai_success','bill2_admin_call_report','bill2_call_erasure_guard','bill2_cancel','bill2_claim','bill2_close','bill2_dispatch','bill2_erasure_closed','bill2_erasure_receipt_projection','bill2_erasure_view','bill2_evidence_immutable','bill2_execution_allowed','bill2_finalize','bill2_payg_absorb_report','bill2_payg_admin_settle_call','bill2_payg_block_lock','bill2_payg_call_stuck','bill2_payg_claim','bill2_payg_compensate','bill2_payg_finalize','bill2_payg_financial_binding','bill2_payg_lock_models','bill2_payg_metering_hash','bill2_payg_metering_review_snapshot','bill2_payg_review_invalidate_receipt','bill2_payg_review_metering','bill2_payg_stuck_calls','bill2_payg_tool_settlement','bill2_payg_validate_quote','bill2_payg_validate_tool_quote','bill2_pending_calls','bill2_prepare','bill2_private_input','bill2_public','bill2_read','bill2_receipt_raw_due','bill2_receipts_scrub_raw','bill2_record','bill2_record_tool','bill2_recovery_claim','bill2_revoke_unstarted_dispatch','bill2_tool_cost_reconcile','bill2_tool_pending_guard','bill2_usage_total','content_erasure_visible','fusion_billing_guard','fusion_call_in_flight','fusion_compare_adopt','fusion_compare_begin','fusion_compare_claim','fusion_compare_dispatch_claim','fusion_compare_dispatch_release','fusion_compare_read','fusion_compare_stop','fusion_compare_unjudged','fusion_pending_financial_batch','fusion_review_end_paused','fusion_review_fee_hold','fusion_review_fee_settle','fusion_review_fee_settle_due','fusion_review_fee_settle_internal','fusion_review_fee_view','fusion_review_pause_idle','fusion_review_unjudged','opc_brief_adoption','opc_content_from_execution','opc_content_reaction','opc_data_execution','opc_plan_request_state','opc_plan_result','opc_save_result','opc_video_execution_check','opc_video_package_from_execution','opc_video_results_from_execution','report_admission_check','report_fee_hold','report_fee_settle','report_fee_settle_due','report_fee_settle_internal','report_fee_terminal_settlement','report_fee_view','report_stop','research_runtime_call_charge','research_runtime_link','research_user_message','runtime_admission_replay','runtime_admit','runtime_admit_commit','runtime_admit_precheck','runtime_billing_allowed','runtime_binding_guard','runtime_cancel','runtime_cancel_with_code','runtime_context_allowed','runtime_direct_billing_allowed','runtime_direct_billing_allowed_before_opc','runtime_direct_billing_allowed_before_topic','runtime_execution','runtime_execution_visibility','runtime_financial_recovery','runtime_history_availability','runtime_history_availability_before_memo','runtime_history_available','runtime_history_available_before_memo','runtime_interrupt_capacity','runtime_interrupted_recovery','runtime_library_propagate','runtime_library_read','runtime_library_references_freeze','runtime_library_sources_gone','runtime_library_tool_guard','runtime_library_visible','runtime_load_skill_allowed','runtime_load_skill_entry','runtime_load_skill_result_valid','runtime_matching_call_guard','runtime_mentor_history','runtime_mentor_history_draft','runtime_mentor_history_guard','runtime_mentor_messages','runtime_pending_financial_batch','runtime_positioning_gate','runtime_production_recovery_policy','runtime_read_verified','runtime_receipt_saved','runtime_response','runtime_session_context','runtime_session_items','runtime_session_result_edit','runtime_session_result_save','runtime_session_result_save_turn','runtime_session_result_turn_view','runtime_session_result_versions','runtime_session_result_view','runtime_session_results_list','runtime_session_results_list_turns','runtime_source_checkpoint','runtime_stale_charged_rounds','runtime_stale_round_compensate','runtime_stop_loss_call_guard','runtime_stop_loss_settled','runtime_test_actor_access','runtime_test_budget_guard','runtime_test_dispatch_guard','runtime_test_recovery_policy','runtime_tool','runtime_view','runtime_view_with_work_items','runtime_voice_references_freeze','runtime_voice_source_gone','runtime_voice_sources_gone','runtime_work_items','runtime_workspace_benchmark_guard','runtime_workspace_posts_guard','runtime_workspace_posts_history_erased','runtime_workspace_posts_history_visible','runtime_workspace_posts_receipt_ready','runtime_workspace_tool_guard','voice_billing_scrub','voice_run_recovery'])
    AND regexp_replace(p.prosrc,'--[^\n]*','','g') ~* '\m(atomic_abort_settle|atomic_finalize_ai_abort|atomic_finalize_ai_failure|atomic_finalize_ai_success|bill2_admin_call_report|bill2_call_erasure_guard|bill2_cancel|bill2_claim|bill2_close|bill2_dispatch|bill2_erasure_closed|bill2_erasure_receipt_projection|bill2_erasure_view|bill2_evidence_immutable|bill2_execution_allowed|bill2_finalize|bill2_payg_absorb_report|bill2_payg_admin_settle_call|bill2_payg_block_lock|bill2_payg_call_stuck|bill2_payg_claim|bill2_payg_compensate|bill2_payg_finalize|bill2_payg_financial_binding|bill2_payg_lock_models|bill2_payg_metering_hash|bill2_payg_metering_review_snapshot|bill2_payg_review_invalidate_receipt|bill2_payg_review_metering|bill2_payg_stuck_calls|bill2_payg_tool_settlement|bill2_payg_validate_quote|bill2_payg_validate_tool_quote|bill2_pending_calls|bill2_prepare|bill2_private_input|bill2_public|bill2_read|bill2_receipt_raw_due|bill2_receipts_scrub_raw|bill2_record|bill2_record_tool|bill2_recovery_claim|bill2_revoke_unstarted_dispatch|bill2_tool_cost_reconcile|bill2_tool_pending_guard|bill2_usage_total|content_erasure_visible|fusion_billing_guard|fusion_call_in_flight|fusion_compare_adopt|fusion_compare_begin|fusion_compare_claim|fusion_compare_dispatch_claim|fusion_compare_dispatch_release|fusion_compare_read|fusion_compare_stop|fusion_compare_unjudged|fusion_pending_financial_batch|fusion_review_end_paused|fusion_review_fee_hold|fusion_review_fee_settle|fusion_review_fee_settle_due|fusion_review_fee_settle_internal|fusion_review_fee_view|fusion_review_pause_idle|fusion_review_unjudged|opc_brief_adoption|opc_content_from_execution|opc_content_reaction|opc_data_execution|opc_plan_request_state|opc_plan_result|opc_save_result|opc_video_execution_check|opc_video_package_from_execution|opc_video_results_from_execution|report_admission_check|report_fee_hold|report_fee_settle|report_fee_settle_due|report_fee_settle_internal|report_fee_terminal_settlement|report_fee_view|report_stop|research_runtime_call_charge|research_runtime_link|research_user_message|runtime_admission_replay|runtime_admit|runtime_admit_commit|runtime_admit_precheck|runtime_billing_allowed|runtime_binding_guard|runtime_cancel|runtime_cancel_with_code|runtime_context_allowed|runtime_direct_billing_allowed|runtime_direct_billing_allowed_before_opc|runtime_direct_billing_allowed_before_topic|runtime_execution|runtime_execution_visibility|runtime_financial_recovery|runtime_history_availability|runtime_history_availability_before_memo|runtime_history_available|runtime_history_available_before_memo|runtime_interrupt_capacity|runtime_interrupted_recovery|runtime_library_propagate|runtime_library_read|runtime_library_references_freeze|runtime_library_sources_gone|runtime_library_tool_guard|runtime_library_visible|runtime_load_skill_allowed|runtime_load_skill_entry|runtime_load_skill_result_valid|runtime_matching_call_guard|runtime_mentor_history|runtime_mentor_history_draft|runtime_mentor_history_guard|runtime_mentor_messages|runtime_pending_financial_batch|runtime_positioning_gate|runtime_production_recovery_policy|runtime_read_verified|runtime_receipt_saved|runtime_response|runtime_session_context|runtime_session_items|runtime_session_result_edit|runtime_session_result_save|runtime_session_result_save_turn|runtime_session_result_turn_view|runtime_session_result_versions|runtime_session_result_view|runtime_session_results_list|runtime_session_results_list_turns|runtime_source_checkpoint|runtime_stale_charged_rounds|runtime_stale_round_compensate|runtime_stop_loss_call_guard|runtime_stop_loss_settled|runtime_test_actor_access|runtime_test_budget_guard|runtime_test_dispatch_guard|runtime_test_recovery_policy|runtime_tool|runtime_view|runtime_view_with_work_items|runtime_voice_references_freeze|runtime_voice_source_gone|runtime_voice_sources_gone|runtime_work_items|runtime_workspace_benchmark_guard|runtime_workspace_posts_guard|runtime_workspace_posts_history_erased|runtime_workspace_posts_history_visible|runtime_workspace_posts_receipt_ready|runtime_workspace_tool_guard|voice_billing_scrub|voice_run_recovery)\s*\(';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'V2_12_F_REFERENCES_REMAIN_FUNCTIONS: %', bad; END IF;
END
$guard$;

ALTER TABLE public.ai_usage_logs DROP CONSTRAINT IF EXISTS ai_usage_logs_bill2_call_id_fkey;
ALTER TABLE public.ai_usage_logs DROP CONSTRAINT IF EXISTS ai_usage_logs_bill2_run_id_fkey;
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_bill2_call_id_fkey;
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_bill2_run_id_fkey;
ALTER TABLE public.fusion_call_outputs DROP CONSTRAINT IF EXISTS fusion_call_outputs_call_ref;
ALTER TABLE public.fusion_call_outputs DROP CONSTRAINT IF EXISTS fusion_call_outputs_group_ref;
ALTER TABLE public.fusion_call_outputs DROP CONSTRAINT IF EXISTS fusion_call_outputs_run_ref;
ALTER TABLE public.fusion_compares DROP CONSTRAINT IF EXISTS fusion_compares_group_ref;
ALTER TABLE public.opc_content_versions DROP CONSTRAINT IF EXISTS opc_content_versions_execution_id_fkey;
ALTER TABLE public.opc_data_events DROP CONSTRAINT IF EXISTS opc_data_events_execution_id_fkey;
ALTER TABLE public.opc_result_links DROP CONSTRAINT IF EXISTS opc_result_links_execution_id_fkey;
ALTER TABLE public.research_account_fetches DROP CONSTRAINT IF EXISTS research_account_fetches_execution_id_fkey;
ALTER TABLE public.research_account_fetches DROP CONSTRAINT IF EXISTS research_account_fetches_last_success_execution_id_fkey;
ALTER TABLE public.research_benchmark_shortfalls DROP CONSTRAINT IF EXISTS research_benchmark_shortfalls_execution_id_fkey;
ALTER TABLE public.research_benchmarks DROP CONSTRAINT IF EXISTS research_benchmarks_execution_id_fkey;
ALTER TABLE public.research_discoveries DROP CONSTRAINT IF EXISTS research_discoveries_execution_id_fkey;
ALTER TABLE public.research_operations DROP CONSTRAINT IF EXISTS research_operations_bill2_call_id_fkey;
ALTER TABLE public.research_plans DROP CONSTRAINT IF EXISTS research_plans_execution_id_fkey;
ALTER TABLE public.research_refresh_grants DROP CONSTRAINT IF EXISTS research_refresh_grants_source_execution_id_fkey;
ALTER TABLE public.research_refresh_grants DROP CONSTRAINT IF EXISTS research_refresh_grants_used_execution_id_fkey;
ALTER TABLE public.research_selection_cards DROP CONSTRAINT IF EXISTS research_selection_cards_execution_id_fkey;
ALTER TABLE public.token_stats DROP CONSTRAINT IF EXISTS token_stats_bill2_call_id_fkey;
ALTER TABLE public.token_stats DROP CONSTRAINT IF EXISTS token_stats_bill2_run_id_fkey;
ALTER TABLE public.runtime_session_results DROP CONSTRAINT IF EXISTS runtime_session_results_source_execution_id_fkey;

DROP TRIGGER IF EXISTS bill2_evidence_immutable ON public.bill2_receipts;
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
DROP TRIGGER IF EXISTS bill2_payg_zz_block_lock ON public.bill2_calls;
DROP TRIGGER IF EXISTS runtime_a_test_dispatch_guard ON public.bill2_calls;
DROP TRIGGER IF EXISTS report_fee_terminal_settlement ON public.runtime_executions;

DROP FUNCTION IF EXISTS public.atomic_abort_settle(p_user_id uuid, p_pre_deduct_id uuid, p_consumed_credits integer, p_consumed_tokens jsonb, p_model_id text, p_reason text);
DROP FUNCTION IF EXISTS public.atomic_finalize_ai_abort(p_user_id uuid, p_conversation_id uuid, p_user_message text, p_partial_assistant_message text, p_model_used text, p_total_cost_usd numeric, p_consumed_credits integer, p_pre_deduct_id uuid, p_usage jsonb, p_token_metadata jsonb, p_usage_metadata jsonb, p_request_id text, p_input_length integer, p_latency_ms integer, p_search_count integer, p_ip_address text, p_user_agent text);
DROP FUNCTION IF EXISTS public.atomic_finalize_ai_failure(p_user_id uuid, p_model_used text, p_reason text, p_pre_deduct_id uuid, p_conversation_id uuid, p_request_id text, p_input_length integer, p_latency_ms integer, p_ip_address text, p_user_agent text, p_usage_metadata jsonb);
DROP FUNCTION IF EXISTS public.atomic_finalize_ai_success(p_user_id uuid, p_conversation_id uuid, p_user_message text, p_assistant_message text, p_model_used text, p_total_cost_usd numeric, p_total_credits integer, p_pre_deduct_id uuid, p_usage jsonb, p_token_metadata jsonb, p_usage_metadata jsonb, p_request_id text, p_input_length integer, p_latency_ms integer, p_search_count integer, p_ip_address text, p_user_agent text);
DROP FUNCTION IF EXISTS public.bill2_admin_call_report(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_call_erasure_guard();
DROP FUNCTION IF EXISTS public.bill2_cancel(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_claim(p_actor_id uuid, p_run_id uuid, p_sequence integer, p_payload jsonb);
DROP FUNCTION IF EXISTS public.bill2_close(p_actor_id uuid, p_run_id uuid, p_outcome text, p_result jsonb);
DROP FUNCTION IF EXISTS public.bill2_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_rotate boolean, p_payload jsonb);
DROP FUNCTION IF EXISTS public.bill2_erasure_closed(a uuid, pre uuid);
DROP FUNCTION IF EXISTS public.bill2_erasure_receipt_projection(e jsonb, c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_erasure_view(r bill2_runs, is_closed boolean);
DROP FUNCTION IF EXISTS public.bill2_evidence_immutable();
DROP FUNCTION IF EXISTS public.bill2_execution_allowed(a uuid, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_finalize(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_absorb_report(p_from timestamp with time zone, p_to timestamp with time zone);
DROP FUNCTION IF EXISTS public.bill2_payg_admin_settle_call(p_admin_id uuid, p_request_id uuid, p_call_id uuid, p_verified_cost_usd numeric, p_reason text);
DROP FUNCTION IF EXISTS public.bill2_payg_block_lock();
DROP FUNCTION IF EXISTS public.bill2_payg_call_stuck(c bill2_calls, r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_compensate(r bill2_runs, c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_payg_finalize(a uuid, rid uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_financial_binding(r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_payg_lock_models(r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_payg_metering_hash(c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_payg_metering_review_snapshot(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_review_invalidate_receipt();
DROP FUNCTION IF EXISTS public.bill2_payg_review_metering(p_actor_id uuid, p_call_id uuid, p_request_id uuid, p_review jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_stuck_calls(p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_payg_tool_settlement(r bill2_runs, c bill2_calls, erasing boolean);
DROP FUNCTION IF EXISTS public.bill2_payg_validate_quote(r bill2_runs, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_validate_tool_quote(r bill2_runs, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_pending_calls(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_prepare(p_actor_id uuid, p_request_id uuid, p_payload jsonb);
DROP FUNCTION IF EXISTS public.bill2_private_input(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_public(r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_read(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_receipt_raw_due(x bill2_receipts);
DROP FUNCTION IF EXISTS public.bill2_receipts_scrub_raw(p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_record(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb);
DROP FUNCTION IF EXISTS public.bill2_record_tool(r bill2_runs, c bill2_calls, e jsonb, h text, erasing boolean);
DROP FUNCTION IF EXISTS public.bill2_recovery_claim(p_actor_id uuid, p_run_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean);
DROP FUNCTION IF EXISTS public.bill2_tool_cost_reconcile(p_admin_id uuid, p_call_id uuid, p_cost text, p_evidence_hash text);
DROP FUNCTION IF EXISTS public.bill2_tool_pending_guard(p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_usage_total(rid uuid, field text);
DROP FUNCTION IF EXISTS public.content_erasure_visible(a uuid, eid uuid);
DROP FUNCTION IF EXISTS public.fusion_billing_guard();
DROP FUNCTION IF EXISTS public.fusion_call_in_flight(c bill2_calls);
DROP FUNCTION IF EXISTS public.fusion_compare_adopt(p_actor_id uuid, p_compare_id uuid, p_column integer, p_request_id uuid, p_billing jsonb, p_items jsonb);
DROP FUNCTION IF EXISTS public.fusion_compare_begin(p_actor_id uuid, p_request_id uuid, p_session_id uuid, p_request jsonb);
DROP FUNCTION IF EXISTS public.fusion_compare_claim(p_actor_id uuid, p_compare_id uuid, p_items jsonb);
DROP FUNCTION IF EXISTS public.fusion_compare_dispatch_claim(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_dispatch_release(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_read(p_actor_id uuid, p_compare_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_stop(p_actor_id uuid, p_compare_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.fusion_compare_unjudged(p_limit integer);
DROP FUNCTION IF EXISTS public.fusion_pending_financial_batch(p_limit integer, p_after_created timestamp with time zone, p_after_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_end_paused(p_idle interval, p_limit integer);
DROP FUNCTION IF EXISTS public.fusion_review_fee_hold(rv fusion_reviews, v jsonb, cfg jsonb);
DROP FUNCTION IF EXISTS public.fusion_review_fee_settle(p_actor_id uuid, p_review_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_fee_settle_due(p_limit integer);
DROP FUNCTION IF EXISTS public.fusion_review_fee_settle_internal(p_review_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_fee_view(p_review_id uuid);
DROP FUNCTION IF EXISTS public.fusion_review_pause_idle(p_idle interval);
DROP FUNCTION IF EXISTS public.fusion_review_unjudged(p_limit integer);
DROP FUNCTION IF EXISTS public.opc_brief_adoption(p_actor_id uuid, p_request_id uuid, p_work_item_id uuid, p_expected_revision bigint, p_execution_id uuid, p_original text, p_brief text);
DROP FUNCTION IF EXISTS public.opc_content_from_execution(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_expected_version bigint, p_kind text, p_status text, p_execution_id uuid, p_source_content_id uuid);
DROP FUNCTION IF EXISTS public.opc_content_reaction(p_actor_id uuid, p_request_id uuid, p_execution_id uuid, p_action text, p_reason text);
DROP FUNCTION IF EXISTS public.opc_data_execution(a uuid, eid uuid);
DROP FUNCTION IF EXISTS public.opc_plan_request_state(p_actor_id uuid, p_draft_id uuid, p_request_id uuid);
DROP FUNCTION IF EXISTS public.opc_plan_result(p_actor_id uuid, p_draft_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.opc_save_result(p_actor_id uuid, p_draft_id uuid, p_execution_id uuid, p_step_id text, p_request_id uuid);
DROP FUNCTION IF EXISTS public.opc_video_execution_check(p_actor_id uuid, p_work_item_id uuid, p_execution_id uuid, p_source_script_id uuid);
DROP FUNCTION IF EXISTS public.opc_video_package_from_execution(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_execution_id uuid, p_source_script_id uuid, p_expected_storyboard_version bigint, p_expected_editing_version bigint);
DROP FUNCTION IF EXISTS public.opc_video_results_from_execution(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_execution_id uuid, p_source_script_id uuid, p_expected_storyboard_version bigint, p_expected_editing_version bigint, p_storyboard boolean, p_editing boolean);
DROP FUNCTION IF EXISTS public.report_admission_check(a uuid, sid uuid, context jsonb, billing jsonb);
DROP FUNCTION IF EXISTS public.report_fee_hold(e runtime_executions, billing jsonb);
DROP FUNCTION IF EXISTS public.report_fee_settle(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.report_fee_settle_due(p_limit integer);
DROP FUNCTION IF EXISTS public.report_fee_settle_internal(p_execution_id uuid, p_refund boolean);
DROP FUNCTION IF EXISTS public.report_fee_terminal_settlement();
DROP FUNCTION IF EXISTS public.report_fee_view(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.report_stop(p_actor_id uuid, p_execution_id uuid, p_stop jsonb, p_confirmed boolean);
DROP FUNCTION IF EXISTS public.research_runtime_call_charge(a uuid, s uuid, e uuid, p_call uuid);
DROP FUNCTION IF EXISTS public.research_runtime_link(a uuid, p_plan uuid, s uuid, e uuid, p_discovery uuid, p_operation uuid, p_call uuid);
DROP FUNCTION IF EXISTS public.research_user_message(a uuid, s uuid, e uuid);
DROP FUNCTION IF EXISTS public.runtime_admission_replay(p_actor_id uuid, p_request_id uuid, p_request jsonb);
DROP FUNCTION IF EXISTS public.runtime_admit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb);
DROP FUNCTION IF EXISTS public.runtime_admit_commit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb, p_pre jsonb);
DROP FUNCTION IF EXISTS public.runtime_admit_precheck(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb);
DROP FUNCTION IF EXISTS public.runtime_billing_allowed(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_binding_guard();
DROP FUNCTION IF EXISTS public.runtime_cancel(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_cancel_with_code(p_actor_id uuid, p_execution_id uuid, p_code text);
DROP FUNCTION IF EXISTS public.runtime_context_allowed(p_actor_id uuid, p_context jsonb);
DROP FUNCTION IF EXISTS public.runtime_direct_billing_allowed(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_direct_billing_allowed_before_opc(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_direct_billing_allowed_before_topic(a uuid, p jsonb, p_run_id uuid);
DROP FUNCTION IF EXISTS public.runtime_execution(p_actor_id uuid, p_execution_id uuid, p_action text, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_execution_visibility(p_actor_id uuid, p_execution_id uuid, p_voice boolean, p_library boolean);
DROP FUNCTION IF EXISTS public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean);
DROP FUNCTION IF EXISTS public.runtime_history_availability(p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_history_availability_before_memo(p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_history_available(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_history_available_before_memo(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_interrupt_capacity(p_actor_id uuid, p_execution_id uuid, p_epoch bigint, p_code text);
DROP FUNCTION IF EXISTS public.runtime_interrupted_recovery(p_actor_id uuid, p_execution_id uuid, p_epoch bigint, p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_library_propagate(p_actor_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_library_read(p_actor_id uuid, p_execution_id uuid, p_query text);
DROP FUNCTION IF EXISTS public.runtime_library_references_freeze();
DROP FUNCTION IF EXISTS public.runtime_library_sources_gone(p_actor_id uuid, p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_library_tool_guard();
DROP FUNCTION IF EXISTS public.runtime_library_visible(p_actor_id uuid, p_execution_id uuid, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_load_skill_allowed(e runtime_executions, p_call_id text, p_arguments jsonb);
DROP FUNCTION IF EXISTS public.runtime_load_skill_entry(e runtime_executions, p_arguments jsonb);
DROP FUNCTION IF EXISTS public.runtime_load_skill_result_valid(e runtime_executions, p_arguments jsonb, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_matching_call_guard();
DROP FUNCTION IF EXISTS public.runtime_mentor_history(p_actor_id uuid, p_execution_id uuid, p_query text);
DROP FUNCTION IF EXISTS public.runtime_mentor_history_draft(p_actor_id uuid, e runtime_executions);
DROP FUNCTION IF EXISTS public.runtime_mentor_history_guard();
DROP FUNCTION IF EXISTS public.runtime_mentor_messages(p_actor_id uuid, e runtime_executions);
DROP FUNCTION IF EXISTS public.runtime_pending_financial_batch(p_actor_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_positioning_gate(p_actor_id uuid);
DROP FUNCTION IF EXISTS public.runtime_production_recovery_policy(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_read_verified(a uuid, eid uuid);
DROP FUNCTION IF EXISTS public.runtime_receipt_saved(p_actor_id uuid, p_execution_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb);
DROP FUNCTION IF EXISTS public.runtime_response(p_actor_id uuid, p_execution_id uuid, p_sequence integer, p_request_hash text);
DROP FUNCTION IF EXISTS public.runtime_session_context(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_session_items(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_action text, p_items jsonb, p_limit integer, p_batch integer);
DROP FUNCTION IF EXISTS public.runtime_session_result_edit(p_actor_id uuid, p_family_id uuid, p_request_id uuid, p_expected_version integer, p_title text, p_body text);
DROP FUNCTION IF EXISTS public.runtime_session_result_save(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_request_id uuid, p_result_type text, p_title text, p_excerpt text);
DROP FUNCTION IF EXISTS public.runtime_session_result_save_turn(p_actor_id uuid, p_session_id uuid, p_turn_id bigint, p_request_id uuid, p_result_type text, p_title text, p_excerpt text);
DROP FUNCTION IF EXISTS public.runtime_session_result_turn_view(r runtime_session_results, p_versions integer);
DROP FUNCTION IF EXISTS public.runtime_session_result_versions(p_actor_id uuid, p_family_id uuid);
DROP FUNCTION IF EXISTS public.runtime_session_result_view(r runtime_session_results, p_versions integer);
DROP FUNCTION IF EXISTS public.runtime_session_results_list(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_session_results_list_turns(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_source_checkpoint(p_actor_id uuid, s runtime_sessions, e runtime_executions, b bill2_runs, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_stale_charged_rounds(p_cutoff timestamp with time zone, p_limit integer);
DROP FUNCTION IF EXISTS public.runtime_stale_charged_rounds(p_cutoff timestamp with time zone, p_limit integer, p_created_since timestamp with time zone);
DROP FUNCTION IF EXISTS public.runtime_stale_round_compensate(p_run_id uuid, p_cutoff timestamp with time zone);
DROP FUNCTION IF EXISTS public.runtime_stop_loss_call_guard();
DROP FUNCTION IF EXISTS public.runtime_stop_loss_settled();
DROP FUNCTION IF EXISTS public.runtime_test_actor_access(p_actor_id uuid);
DROP FUNCTION IF EXISTS public.runtime_test_budget_guard();
DROP FUNCTION IF EXISTS public.runtime_test_dispatch_guard();
DROP FUNCTION IF EXISTS public.runtime_test_recovery_policy(p_actor_id uuid, p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_tool(p_actor_id uuid, p_execution_id uuid, p_call_id text, p_name text, p_arguments jsonb, p_action text, p_result jsonb);
DROP FUNCTION IF EXISTS public.runtime_view(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_view_with_work_items(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_voice_references_freeze();
DROP FUNCTION IF EXISTS public.runtime_voice_source_gone(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_voice_sources_gone(p_actor_id uuid, p_execution_ids uuid[]);
DROP FUNCTION IF EXISTS public.runtime_work_items(p_actor_id uuid, p_session_id uuid);
DROP FUNCTION IF EXISTS public.runtime_workspace_benchmark_guard();
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_guard();
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_history_erased(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_history_visible(p_execution_id uuid);
DROP FUNCTION IF EXISTS public.runtime_workspace_posts_receipt_ready(p jsonb, c bill2_calls);
DROP FUNCTION IF EXISTS public.runtime_workspace_tool_guard();
DROP FUNCTION IF EXISTS public.voice_billing_scrub(p_run_id uuid);
DROP FUNCTION IF EXISTS public.voice_run_recovery(p_run_id uuid);

DROP TABLE IF EXISTS public.runtime_executions, public.runtime_session_history, public.runtime_history_dependencies, public.runtime_tool_calls, public.runtime_session_batches, public.runtime_library_references, public.runtime_voice_references, public.bill2_runs, public.bill2_calls, public.bill2_receipts, public.bill2_provider_ids, public.fusion_billing_groups, public.fusion_billing_group_steps, public.report_fees, public.fusion_review_fees;

COMMIT;
