-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-UNIT draft kept outside packages/db/migrations so the ledger check and CI tests keep running.
-- Move into packages/db/migrations with the next free number after #497 (0155) and #550 (0156) merge.
-- Local development only until host integration, final validation, review and Owner authorization.
--
-- Read-only per-call finance projection for /admin/finance (cost and frozen multiplier per model).
-- bill2_runs / bill2_calls are revoked from every API role (0105), and widening table grants would
-- expose whole payloads (private inputs, scope). This SECURITY DEFINER function returns only
-- financial columns: no actor, request, scope, prompt or receipt body. service_role only.
-- Rollback: DROP FUNCTION public.bill2_admin_call_report(timestamptz, timestamptz, integer);
-- nothing else depends on it and it writes nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bill2_admin_call_report(p_from timestamptz, p_to timestamptz, p_limit integer)
RETURNS TABLE (
  call_id uuid, run_id uuid, call_sequence integer, created_at timestamptz,
  provider text, model text, call_state text, selected_cost_usd numeric,
  run_state text, run_outcome text, credits_per_usd numeric, run_multiplier numeric,
  run_charged integer, run_actual_restore integer, run_call_count integer,
  call_multiplier text, multiplier_source text, purpose text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.run_id, c.sequence, c.created_at,
         c.provider, c.model, c.state, c.selected_cost_usd,
         r.state, r.outcome, r.credits_per_usd, r.multiplier,
         r.charged, r.actual_restore, (SELECT count(*)::integer FROM bill2_calls x WHERE x.run_id = r.id),
         c.payload #>> '{billingUnit,multiplier}', c.payload #>> '{billingUnit,source}',
         r.payload #>> '{purposeBudget,purpose}'
  FROM bill2_calls c
  JOIN bill2_runs r ON r.id = c.run_id
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_from < p_to
    AND c.created_at >= p_from AND c.created_at < p_to
  ORDER BY c.created_at, c.id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 1), 1), 5000)
$$;

REVOKE ALL ON FUNCTION public.bill2_admin_call_report(timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bill2_admin_call_report(timestamptz, timestamptz, integer) TO service_role;

COMMIT;
