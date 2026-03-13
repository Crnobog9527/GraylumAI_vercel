-- Migration: Supabase Security Advisor hardening
-- Version: 0015
-- Date: 2026-03-11
-- Description: resolves exposed-table/view findings and tightens database-side security advisor warnings

-- ============================================
-- 1. RLS for runtime context snapshots
-- ============================================

ALTER TABLE conversation_context_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "context_snapshots_select_own_or_admin" ON conversation_context_snapshots;
CREATE POLICY "context_snapshots_select_own_or_admin"
  ON conversation_context_snapshots FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM conversations c
      WHERE c.id = conversation_id
        AND c.user_id = auth.uid()
    )
    OR is_admin()
  );

DROP POLICY IF EXISTS "context_snapshots_admin_all" ON conversation_context_snapshots;
CREATE POLICY "context_snapshots_admin_all"
  ON conversation_context_snapshots FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

COMMENT ON POLICY "context_snapshots_select_own_or_admin" ON conversation_context_snapshots
IS 'Only the conversation owner or an admin can read runtime context snapshots.';

COMMENT ON POLICY "context_snapshots_admin_all" ON conversation_context_snapshots
IS 'Only admins can modify runtime context snapshots through authenticated user tokens.';

-- ============================================
-- 2. Make latest diagnostics view run as invoker
-- ============================================

CREATE OR REPLACE VIEW diagnostic_latest_results
WITH (security_invoker = true) AS
WITH ranked_results AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY test_id ORDER BY created_at DESC) AS rn
  FROM diagnostic_results
)
SELECT
  id,
  test_id,
  test_name,
  category,
  status,
  message,
  details,
  latency_ms,
  run_by,
  run_type,
  batch_id,
  created_at
FROM ranked_results
WHERE rn = 1;

COMMENT ON VIEW diagnostic_latest_results
IS 'Shows only the most recent result for each test type, evaluated with the querying role''s permissions.';

-- ============================================
-- 3. Remove blanket-true service policies
-- service_role already bypasses RLS; these policies only widen the advisor surface
-- ============================================

DROP POLICY IF EXISTS "Service can insert diagnostic results" ON diagnostic_results;
DROP POLICY IF EXISTS "Service can insert logs" ON application_logs;

-- ============================================
-- 4. Lock SECURITY DEFINER functions to a safe search_path
-- ============================================

ALTER FUNCTION public.is_admin() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_credits(UUID) SET search_path = public, pg_temp;

ALTER FUNCTION public.atomic_pre_deduct(UUID, INTEGER, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.atomic_settle(UUID, UUID, INTEGER, JSONB, JSONB) SET search_path = public, pg_temp;
ALTER FUNCTION public.atomic_refund(UUID, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.atomic_abort_settle(UUID, UUID, INTEGER, JSONB, TEXT, TEXT) SET search_path = public, pg_temp;

ALTER FUNCTION public.cleanup_old_diagnostic_results(INTEGER) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_diagnostic_summary(INTEGER) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_test_history(TEXT, INTEGER) SET search_path = public, pg_temp;

ALTER FUNCTION public.soft_delete_conversation(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.soft_delete_ticket(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.purge_deleted_records(INTEGER) SET search_path = public, pg_temp;

ALTER FUNCTION public.cleanup_old_logs() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_log_stats(TIMESTAMPTZ, TIMESTAMPTZ) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_error_summary(INTEGER) SET search_path = public, pg_temp;

ALTER FUNCTION public.get_system_setting_int(TEXT, INTEGER) SET search_path = public, pg_temp;
ALTER FUNCTION public.claim_daily_checkin(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.auto_close_stale_tickets(INTEGER) SET search_path = public, pg_temp;

ALTER FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) SET search_path = public, pg_temp;

ALTER FUNCTION public.atomic_finalize_ai_failure(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) SET search_path = public, pg_temp;

ALTER FUNCTION public.atomic_finalize_ai_abort(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) SET search_path = public, pg_temp;
