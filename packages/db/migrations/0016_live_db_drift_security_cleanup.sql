-- Migration: Live database drift cleanup for remaining Supabase Security Advisor warnings
-- Version: 0016
-- Date: 2026-03-11
-- Description: removes stale blanket INSERT policies and locks search_path on legacy functions still present in the hosted database

-- ============================================
-- 1. Remove stale blanket INSERT policies left in the hosted database
-- service_role bypasses RLS already, so these policies are unnecessary and trigger advisor warnings
-- ============================================

DROP POLICY IF EXISTS "System can insert invitation records" ON invitation_records;
DROP POLICY IF EXISTS "System can insert activity logs" ON user_activity_logs;

-- ============================================
-- 2. Lock search_path on legacy functions that still exist in the hosted database
-- ============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'deduct_credits_atomic'
      AND pg_get_function_identity_arguments(p.oid) =
          'p_user_id uuid, p_amount integer, p_reason text, p_reference_id text, p_reference_type text, p_idempotency_key text'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.deduct_credits_atomic(uuid, integer, text, text, text, text) SET search_path = public, pg_temp';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'update_updated_at_column'
      AND pg_get_function_identity_arguments(p.oid) = ''
  ) THEN
    EXECUTE 'ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp';
  END IF;
END
$$;
