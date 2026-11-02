-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch F: IRREVERSIBLE. Drops the old runtime / BILL2 path: 15 tables and 153 functions, and the foreign keys
-- from kept tables to them. There is no way back after this migration except restoring a backup (CORE-PATH-V2-DELETE.md section 4).
-- Data: staging holds old-path TEST rows only (thousands of rows in runtime_executions, bill2_runs/calls/receipts, ...); the production database
-- has not been built yet, so no real user data is in these tables. Kept tables that pointed at them keep their column values (plain, unconstrained).
-- Kept on purpose (not old path): runtime_scope_material, runtime_session_names, runtime_session_results, runtime_test_windows.
-- The first statement is a guard: it refuses to run while any function that stays still names a dropped table or calls a dropped function
-- (plpgsql would otherwise fail only when called). Whole object lists are generated from the recomputed inventory; nothing is dropped with CASCADE.
BEGIN;
SET LOCAL lock_timeout='10s';

DO $guard$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
  WHERE p.proname <> ALL (ARRAY['atomic_abort_settle','atomic_finalize_ai_abort','atomic_finalize_ai_failure','atomic_finalize_ai_success','bill2_admin_call_report','bill2_call_erasure_guard','bill2_cancel','bill2_claim','bill2_close','bill2_dispatch','bill2_erasure_closed','bill2_erasure_view','bill2_evidence_immutable','bill2_execution_allowed','bill2_finalize','bill2_payg_absorb_report','bill2_payg_admin_settle_call','bill2_payg_block_lock','bill2_payg_claim','bill2_payg_compensate','bill2_payg_finalize','bill2_payg_financial_binding','bill2_payg_metering_hash','bill2_payg_metering_review_snapshot','bill2_payg_review_invalidate_receipt','bill2_payg_review_metering','bill2_payg_stuck_calls','bill2_payg_tool_settlement','bill2_pending_calls','bill2_prepare','bill2_private_input','bill2_read','bill2_receipt_raw_due','bill2_receipts_scrub_raw','bill2_record','bill2_record_tool','bill2_recovery_claim','bill2_revoke_unstarted_dispatch','bill2_tool_cost_reconcile','bill2_tool_pending_guard','bill2_usage_total','content_erasure_visible','fusion_billing_guard','fusion_compare_adopt','fusion_compare_begin','fusion_compare_claim','fusion_compare_dispatch_claim','fusion_compare_dispatch_release','fusion_compare_read','fusion_compare_stop','fusion_compare_unjudged','fusion_pending_financial_batch','fusion_review_end_paused','fusion_review_fee_hold','fusion_review_fee_settle','fusion_review_fee_settle_due','fusion_review_fee_settle_internal','fusion_review_fee_view','fusion_review_pause_idle','fusion_review_unjudged','opc_brief_adoption','opc_content_from_execution','opc_content_reaction','opc_data_execution','opc_plan_request_state','opc_plan_result','opc_save_result','opc_video_execution_check','opc_video_package_from_execution','opc_video_results_from_execution','report_admission_check','report_fee_hold','report_fee_settle','report_fee_settle_due','report_fee_settle_internal','report_fee_terminal_settlement','report_fee_view','report_stop','research_runtime_call_charge','research_runtime_link','research_user_message','runtime_admission_replay','runtime_admit','runtime_admit_commit','runtime_admit_precheck','runtime_billing_allowed','runtime_binding_guard','runtime_cancel','runtime_cancel_with_code','runtime_context_allowed','runtime_direct_billing_allowed','runtime_direct_billing_allowed_before_opc','runtime_direct_billing_allowed_before_topic','runtime_execution','runtime_execution_visibility','runtime_financial_recovery','runtime_history_availability','runtime_history_availability_before_memo','runtime_history_available','runtime_history_available_before_memo','runtime_interrupt_capacity','runtime_interrupted_recovery','runtime_library_propagate','runtime_library_read','runtime_library_references_freeze','runtime_library_sources_gone','runtime_library_tool_guard','runtime_library_visible','runtime_load_skill_allowed','runtime_matching_call_guard','runtime_mentor_history','runtime_mentor_history_guard','runtime_mentor_messages','runtime_pending_financial_batch','runtime_positioning_gate','runtime_production_recovery_policy','runtime_read_verified','runtime_receipt_saved','runtime_response','runtime_session_context','runtime_session_items','runtime_session_result_edit','runtime_session_result_save','runtime_session_result_save_turn','runtime_session_result_turn_view','runtime_session_result_versions','runtime_session_result_view','runtime_session_results_list','runtime_session_results_list_turns','runtime_source_checkpoint','runtime_stale_charged_rounds','runtime_stale_round_compensate','runtime_stop_loss_call_guard','runtime_stop_loss_settled','runtime_test_actor_access','runtime_test_budget_guard','runtime_test_dispatch_guard','runtime_test_recovery_policy','runtime_tool','runtime_view','runtime_view_with_work_items','runtime_voice_references_freeze','runtime_voice_source_gone','runtime_voice_sources_gone','runtime_work_items','runtime_workspace_benchmark_guard','runtime_workspace_posts_guard','runtime_workspace_posts_history_erased','runtime_workspace_posts_history_visible','runtime_workspace_tool_guard','voice_billing_scrub','voice_run_recovery'])
    AND regexp_replace(p.prosrc,'--[^\n]*','','g') ~* '\m(runtime_executions|runtime_session_history|runtime_history_dependencies|runtime_tool_calls|runtime_session_batches|runtime_library_references|runtime_voice_references|bill2_runs|bill2_calls|bill2_receipts|bill2_provider_ids|fusion_billing_groups|fusion_billing_group_steps|report_fees|fusion_review_fees)\M';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'V2_12_F_REFERENCES_REMAIN_TABLES: %', bad; END IF;
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
  WHERE p.proname <> ALL (ARRAY['atomic_abort_settle','atomic_finalize_ai_abort','atomic_finalize_ai_failure','atomic_finalize_ai_success','bill2_admin_call_report','bill2_call_erasure_guard','bill2_cancel','bill2_claim','bill2_close','bill2_dispatch','bill2_erasure_closed','bill2_erasure_view','bill2_evidence_immutable','bill2_execution_allowed','bill2_finalize','bill2_payg_absorb_report','bill2_payg_admin_settle_call','bill2_payg_block_lock','bill2_payg_claim','bill2_payg_compensate','bill2_payg_finalize','bill2_payg_financial_binding','bill2_payg_metering_hash','bill2_payg_metering_review_snapshot','bill2_payg_review_invalidate_receipt','bill2_payg_review_metering','bill2_payg_stuck_calls','bill2_payg_tool_settlement','bill2_pending_calls','bill2_prepare','bill2_private_input','bill2_read','bill2_receipt_raw_due','bill2_receipts_scrub_raw','bill2_record','bill2_record_tool','bill2_recovery_claim','bill2_revoke_unstarted_dispatch','bill2_tool_cost_reconcile','bill2_tool_pending_guard','bill2_usage_total','content_erasure_visible','fusion_billing_guard','fusion_compare_adopt','fusion_compare_begin','fusion_compare_claim','fusion_compare_dispatch_claim','fusion_compare_dispatch_release','fusion_compare_read','fusion_compare_stop','fusion_compare_unjudged','fusion_pending_financial_batch','fusion_review_end_paused','fusion_review_fee_hold','fusion_review_fee_settle','fusion_review_fee_settle_due','fusion_review_fee_settle_internal','fusion_review_fee_view','fusion_review_pause_idle','fusion_review_unjudged','opc_brief_adoption','opc_content_from_execution','opc_content_reaction','opc_data_execution','opc_plan_request_state','opc_plan_result','opc_save_result','opc_video_execution_check','opc_video_package_from_execution','opc_video_results_from_execution','report_admission_check','report_fee_hold','report_fee_settle','report_fee_settle_due','report_fee_settle_internal','report_fee_terminal_settlement','report_fee_view','report_stop','research_runtime_call_charge','research_runtime_link','research_user_message','runtime_admission_replay','runtime_admit','runtime_admit_commit','runtime_admit_precheck','runtime_billing_allowed','runtime_binding_guard','runtime_cancel','runtime_cancel_with_code','runtime_context_allowed','runtime_direct_billing_allowed','runtime_direct_billing_allowed_before_opc','runtime_direct_billing_allowed_before_topic','runtime_execution','runtime_execution_visibility','runtime_financial_recovery','runtime_history_availability','runtime_history_availability_before_memo','runtime_history_available','runtime_history_available_before_memo','runtime_interrupt_capacity','runtime_interrupted_recovery','runtime_library_propagate','runtime_library_read','runtime_library_references_freeze','runtime_library_sources_gone','runtime_library_tool_guard','runtime_library_visible','runtime_load_skill_allowed','runtime_matching_call_guard','runtime_mentor_history','runtime_mentor_history_guard','runtime_mentor_messages','runtime_pending_financial_batch','runtime_positioning_gate','runtime_production_recovery_policy','runtime_read_verified','runtime_receipt_saved','runtime_response','runtime_session_context','runtime_session_items','runtime_session_result_edit','runtime_session_result_save','runtime_session_result_save_turn','runtime_session_result_turn_view','runtime_session_result_versions','runtime_session_result_view','runtime_session_results_list','runtime_session_results_list_turns','runtime_source_checkpoint','runtime_stale_charged_rounds','runtime_stale_round_compensate','runtime_stop_loss_call_guard','runtime_stop_loss_settled','runtime_test_actor_access','runtime_test_budget_guard','runtime_test_dispatch_guard','runtime_test_recovery_policy','runtime_tool','runtime_view','runtime_view_with_work_items','runtime_voice_references_freeze','runtime_voice_source_gone','runtime_voice_sources_gone','runtime_work_items','runtime_workspace_benchmark_guard','runtime_workspace_posts_guard','runtime_workspace_posts_history_erased','runtime_workspace_posts_history_visible','runtime_workspace_tool_guard','voice_billing_scrub','voice_run_recovery'])
    AND regexp_replace(p.prosrc,'--[^\n]*','','g') ~* '\m(atomic_abort_settle|atomic_finalize_ai_abort|atomic_finalize_ai_failure|atomic_finalize_ai_success|bill2_admin_call_report|bill2_call_erasure_guard|bill2_cancel|bill2_claim|bill2_close|bill2_dispatch|bill2_erasure_closed|bill2_erasure_view|bill2_evidence_immutable|bill2_execution_allowed|bill2_finalize|bill2_payg_absorb_report|bill2_payg_admin_settle_call|bill2_payg_block_lock|bill2_payg_claim|bill2_payg_compensate|bill2_payg_finalize|bill2_payg_financial_binding|bill2_payg_metering_hash|bill2_payg_metering_review_snapshot|bill2_payg_review_invalidate_receipt|bill2_payg_review_metering|bill2_payg_stuck_calls|bill2_payg_tool_settlement|bill2_pending_calls|bill2_prepare|bill2_private_input|bill2_read|bill2_receipt_raw_due|bill2_receipts_scrub_raw|bill2_record|bill2_record_tool|bill2_recovery_claim|bill2_revoke_unstarted_dispatch|bill2_tool_cost_reconcile|bill2_tool_pending_guard|bill2_usage_total|content_erasure_visible|fusion_billing_guard|fusion_compare_adopt|fusion_compare_begin|fusion_compare_claim|fusion_compare_dispatch_claim|fusion_compare_dispatch_release|fusion_compare_read|fusion_compare_stop|fusion_compare_unjudged|fusion_pending_financial_batch|fusion_review_end_paused|fusion_review_fee_hold|fusion_review_fee_settle|fusion_review_fee_settle_due|fusion_review_fee_settle_internal|fusion_review_fee_view|fusion_review_pause_idle|fusion_review_unjudged|opc_brief_adoption|opc_content_from_execution|opc_content_reaction|opc_data_execution|opc_plan_request_state|opc_plan_result|opc_save_result|opc_video_execution_check|opc_video_package_from_execution|opc_video_results_from_execution|report_admission_check|report_fee_hold|report_fee_settle|report_fee_settle_due|report_fee_settle_internal|report_fee_terminal_settlement|report_fee_view|report_stop|research_runtime_call_charge|research_runtime_link|research_user_message|runtime_admission_replay|runtime_admit|runtime_admit_commit|runtime_admit_precheck|runtime_billing_allowed|runtime_binding_guard|runtime_cancel|runtime_cancel_with_code|runtime_context_allowed|runtime_direct_billing_allowed|runtime_direct_billing_allowed_before_opc|runtime_direct_billing_allowed_before_topic|runtime_execution|runtime_execution_visibility|runtime_financial_recovery|runtime_history_availability|runtime_history_availability_before_memo|runtime_history_available|runtime_history_available_before_memo|runtime_interrupt_capacity|runtime_interrupted_recovery|runtime_library_propagate|runtime_library_read|runtime_library_references_freeze|runtime_library_sources_gone|runtime_library_tool_guard|runtime_library_visible|runtime_load_skill_allowed|runtime_matching_call_guard|runtime_mentor_history|runtime_mentor_history_guard|runtime_mentor_messages|runtime_pending_financial_batch|runtime_positioning_gate|runtime_production_recovery_policy|runtime_read_verified|runtime_receipt_saved|runtime_response|runtime_session_context|runtime_session_items|runtime_session_result_edit|runtime_session_result_save|runtime_session_result_save_turn|runtime_session_result_turn_view|runtime_session_result_versions|runtime_session_result_view|runtime_session_results_list|runtime_session_results_list_turns|runtime_source_checkpoint|runtime_stale_charged_rounds|runtime_stale_round_compensate|runtime_stop_loss_call_guard|runtime_stop_loss_settled|runtime_test_actor_access|runtime_test_budget_guard|runtime_test_dispatch_guard|runtime_test_recovery_policy|runtime_tool|runtime_view|runtime_view_with_work_items|runtime_voice_references_freeze|runtime_voice_source_gone|runtime_voice_sources_gone|runtime_work_items|runtime_workspace_benchmark_guard|runtime_workspace_posts_guard|runtime_workspace_posts_history_erased|runtime_workspace_posts_history_visible|runtime_workspace_tool_guard|voice_billing_scrub|voice_run_recovery)\s*\(';
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

DROP TRIGGER IF EXISTS runtime_stop_loss_settlement_lock ON public.credit_transactions;
DROP TRIGGER IF EXISTS runtime_stop_loss_settled ON public.credit_transactions;

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
DROP FUNCTION IF EXISTS public.bill2_erasure_view(r bill2_runs, is_closed boolean);
DROP FUNCTION IF EXISTS public.bill2_evidence_immutable();
DROP FUNCTION IF EXISTS public.bill2_execution_allowed(a uuid, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_finalize(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_absorb_report(p_from timestamp with time zone, p_to timestamp with time zone);
DROP FUNCTION IF EXISTS public.bill2_payg_admin_settle_call(p_admin_id uuid, p_request_id uuid, p_call_id uuid, p_verified_cost_usd numeric, p_reason text);
DROP FUNCTION IF EXISTS public.bill2_payg_block_lock();
DROP FUNCTION IF EXISTS public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_compensate(r bill2_runs, c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_payg_finalize(a uuid, rid uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_financial_binding(r bill2_runs);
DROP FUNCTION IF EXISTS public.bill2_payg_metering_hash(c bill2_calls);
DROP FUNCTION IF EXISTS public.bill2_payg_metering_review_snapshot(p_actor_id uuid, p_call_id uuid);
DROP FUNCTION IF EXISTS public.bill2_payg_review_invalidate_receipt();
DROP FUNCTION IF EXISTS public.bill2_payg_review_metering(p_actor_id uuid, p_call_id uuid, p_request_id uuid, p_review jsonb);
DROP FUNCTION IF EXISTS public.bill2_payg_stuck_calls(p_limit integer);
DROP FUNCTION IF EXISTS public.bill2_payg_tool_settlement(r bill2_runs, c bill2_calls, erasing boolean);
DROP FUNCTION IF EXISTS public.bill2_pending_calls(p_actor_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.bill2_prepare(p_actor_id uuid, p_request_id uuid, p_payload jsonb);
DROP FUNCTION IF EXISTS public.bill2_private_input(p_actor_id uuid, p_run_id uuid);
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
DROP FUNCTION IF EXISTS public.runtime_matching_call_guard();
DROP FUNCTION IF EXISTS public.runtime_mentor_history(p_actor_id uuid, p_execution_id uuid, p_query text);
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
DROP FUNCTION IF EXISTS public.runtime_workspace_tool_guard();
DROP FUNCTION IF EXISTS public.voice_billing_scrub(p_run_id uuid);
DROP FUNCTION IF EXISTS public.voice_run_recovery(p_run_id uuid);

DROP TABLE IF EXISTS public.runtime_executions, public.runtime_session_history, public.runtime_history_dependencies, public.runtime_tool_calls, public.runtime_session_batches, public.runtime_library_references, public.runtime_voice_references, public.bill2_runs, public.bill2_calls, public.bill2_receipts, public.bill2_provider_ids, public.fusion_billing_groups, public.fusion_billing_group_steps, public.report_fees, public.fusion_review_fees;

COMMIT;
