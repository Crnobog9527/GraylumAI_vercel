-- Migration: SEC-1 privileged RPC execute posture closure
-- Version: 0050
-- Scope: exact function EXECUTE/search_path convergence plus the one approved
--        soft_delete_conversation identity guard.
-- This migration is forward-only and does not touch tables, RLS, triggers,
-- event triggers, extensions, rls_auto_enable(), or ensure_rls().

-- The only permitted business-function body delta is the fail-closed identity
-- binding for the existing conversation soft-delete semantics.
CREATE OR REPLACE FUNCTION public.soft_delete_conversation(
  p_conversation_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations
    WHERE id = p_conversation_id
      AND user_id = p_user_id
      AND is_deleted = 'false'
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.conversations
  SET is_deleted = 'true',
      deleted_at = NOW()
  WHERE id = p_conversation_id
    AND user_id = p_user_id;

  UPDATE public.messages
  SET is_deleted = 'true',
      deleted_at = NOW()
  WHERE conversation_id = p_conversation_id;

  RETURN true;
END;
$$;

-- Every signature below is a complete regprocedure identity. Missing functions
-- are skipped so this converges both an absent staging object and a present
-- production object without changing unrelated schema state.
DO $$
DECLARE
  v_signature text;
  v_service_role_only constant text[] := ARRAY[
    'public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)',
    'public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
    'public.atomic_apply_invitation_rebate(uuid,integer,text,integer,integer,integer,timestamp with time zone,timestamp with time zone,text)',
    'public.atomic_claim_invitation_code(text,uuid,text,text,text,text,integer,integer,text,text)',
    'public.atomic_downgrade_canceled_subscription_profile(text)',
    'public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
    'public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)',
    'public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
    'public.atomic_fulfill_credit_package(text,text)',
    'public.atomic_fulfill_membership_invoice(text,text,integer,text,text,text,timestamp with time zone,timestamp with time zone)',
    'public.atomic_pre_deduct(uuid,integer,text,uuid)',
    'public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamp with time zone,boolean,boolean)',
    'public.atomic_refund(uuid,uuid,text)',
    'public.atomic_settle(uuid,uuid,integer,jsonb,jsonb)',
    'public.auto_close_stale_tickets(integer)',
    'public.cleanup_old_diagnostic_results(integer)',
    'public.cleanup_old_logs()',
    'public.deduct_credits_atomic(uuid,integer,text,text,text,text)',
    'public.get_diagnostic_summary(integer)',
    'public.get_error_summary(integer)',
    'public.get_log_stats(timestamp with time zone,timestamp with time zone)',
    'public.get_test_history(text,integer)',
    'public.get_user_credits(uuid)',
    'public.is_admin()',
    'public.purge_deleted_records(integer)',
    'public.soft_delete_ticket(uuid,uuid)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_service_role_only LOOP
    IF to_regprocedure(v_signature) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
    END IF;
  END LOOP;

  v_signature := 'public.claim_daily_checkin(uuid)';
  IF to_regprocedure(v_signature) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_signature);
  END IF;

  v_signature := 'public.validate_invitation_code(text)';
  IF to_regprocedure(v_signature) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', v_signature);
  END IF;

  v_signature := 'public.soft_delete_conversation(uuid,uuid)';
  IF to_regprocedure(v_signature) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_signature);
  END IF;
END
$$;
