-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Main-window handoff only. Never run this against production.
-- No actor IDs, prompts, provider IDs, credentials or raw receipts are returned.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';

-- The reported short ID is not authority for a write. Require exactly one match.
SELECT count(*) AS matching_runs
FROM public.bill2_runs
WHERE id >= '42dd468b-0000-0000-0000-000000000000'::uuid
  AND id < '42dd468c-0000-0000-0000-000000000000'::uuid;

WITH matches AS (
  SELECT r.*, count(*) OVER () AS match_count FROM public.bill2_runs r
  WHERE id >= '42dd468b-0000-0000-0000-000000000000'::uuid
    AND id < '42dd468c-0000-0000-0000-000000000000'::uuid
), target AS (SELECT * FROM matches WHERE match_count = 1)
SELECT r.id AS run_id, r.created_at, r.contract_version, r.state, r.closed,
  r.cancel_requested, r.outcome, r.conflict, r.reserved, r.charged, r.actual_restore,
  r.provider_cost_usd, r.deadline, r.deadline + interval '24 hours' AS v1_lookup_deadline,
  transaction_timestamp() > r.deadline + interval '24 hours' AS v1_lookup_expired,
  r.result IS NOT NULL AS has_run_result, r.session_ref IS NOT NULL AS has_session_binding,
  e.id AS execution_id, e.state AS execution_state, e.result IS NOT NULL AS has_execution_result,
  r.paused_reason = 'user_stop' AS user_stop,
  coalesce(e.actor_id = r.actor_id AND s.actor_id = r.actor_id AND s.id = r.session_ref, false) AS runtime_binding_matches,
  coalesce(s.active_execution = e.id, false) AS session_still_active,
  (SELECT count(*) FROM public.billing_history h WHERE h.metadata->>'preDeductId' = r.pre_deduct_id::text
    AND h.operation_type IN ('settle', 'refund', 'abort_settle')) AS terminal_billing_rows,
  (SELECT count(*) FROM public.credit_transactions t WHERE t.bill2_run_id = r.id
    AND t.reason_code = 'bill2_release') AS release_rows,
  (SELECT count(*) FROM public.credit_transactions t WHERE t.bill2_run_id = r.id
    AND t.reason_code = 'bill2_spend') AS spend_rows
FROM target r
LEFT JOIN public.runtime_executions e ON e.billing_run_id = r.id
LEFT JOIN public.runtime_sessions s ON s.id = e.session_id;

WITH matches AS (
  SELECT id, count(*) OVER () AS match_count FROM public.bill2_runs
  WHERE id >= '42dd468b-0000-0000-0000-000000000000'::uuid
    AND id < '42dd468c-0000-0000-0000-000000000000'::uuid
)
SELECT c.sequence, c.state, c.created_at, c.dispatched_at,
  c.provider_id IS NOT NULL AS has_provider_id, c.payload->>'lookupSupported' = 'true' AS lookup_supported,
  c.selected_cost_usd, c.recovery_attempts, c.rejection_recovery_at,
  c.rejection_recovery_at > transaction_timestamp() - interval '60 seconds' AS lookup_backoff_active,
  (SELECT count(*) FROM public.bill2_receipts x WHERE x.call_id = c.id) AS receipt_count,
  (SELECT count(*) FROM public.bill2_receipts x WHERE x.call_id = c.id AND x.conflict) AS conflict_receipts
FROM public.bill2_calls c JOIN matches r ON r.id = c.run_id AND r.match_count = 1
ORDER BY c.sequence;

WITH matches AS (
  SELECT id, count(*) OVER () AS match_count FROM public.bill2_runs
  WHERE id >= '42dd468b-0000-0000-0000-000000000000'::uuid
    AND id < '42dd468c-0000-0000-0000-000000000000'::uuid
)
SELECT c.sequence, x.created_at, x.conflict,
  CASE WHEN x.payload->>'source' IN ('response', 'lookup', 'transport_unknown')
    THEN x.payload->>'source' ELSE 'other' END AS source,
  x.payload->'final' = 'true'::jsonb AS final,
  coalesce(x.payload->'cost' <> 'null'::jsonb, false) AS has_cost,
  x.payload->>'currency' = 'USD' AS usd_currency,
  x.payload->>'coverage' = 'request_total' AS request_total,
  x.payload->>'evidenceKind' = 'provider_rejection_pending' AS rejection_pending,
  x.payload->>'evidenceKind' = 'transport_observation' AS transport_observation
FROM public.bill2_receipts x JOIN public.bill2_calls c ON c.id = x.call_id
JOIN matches r ON r.id = c.run_id AND r.match_count = 1
ORDER BY c.sequence, x.created_at, x.id;

-- Check deployed function identity without invoking a mutating recovery function.
SELECT p.oid::regprocedure::text AS function_signature, md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN
  ('runtime_pending_financial_batch', 'runtime_financial_recovery', 'bill2_recovery_claim',
   'bill2_read', 'bill2_pending_calls', 'bill2_record',
   'bill2_finalize', 'bill2_close', 'bill2_cancel', 'bill2_payg_metering_review_snapshot')
ORDER BY function_signature;
ROLLBACK;
