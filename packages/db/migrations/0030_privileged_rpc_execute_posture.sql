-- Migration: Privileged RPC execute posture
-- Version: 0030
-- Date: 2026-05-17
-- Related issue: #148.
-- Purpose: codify service_role-only EXECUTE posture for privileged billing,
-- finalize, ledger, invitation claim, rebate, and fulfillment RPCs.
-- Scope: function EXECUTE grants and search_path posture only.
-- This migration does not change function bodies, RLS policies, table grants,
-- seed data, secrets, or public/auth helper posture.
-- Do not apply to production without explicit owner approval.
--
-- This file relies on normal repo migration order. Functions restored by 0028
-- must exist before this migration is applied.

ALTER FUNCTION public.atomic_pre_deduct(UUID, INTEGER, TEXT, UUID)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_pre_deduct(UUID, INTEGER, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_pre_deduct(UUID, INTEGER, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_pre_deduct(UUID, INTEGER, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_pre_deduct(UUID, INTEGER, TEXT, UUID) TO service_role;

ALTER FUNCTION public.atomic_settle(UUID, UUID, INTEGER, JSONB, JSONB)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_settle(UUID, UUID, INTEGER, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_settle(UUID, UUID, INTEGER, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_settle(UUID, UUID, INTEGER, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_settle(UUID, UUID, INTEGER, JSONB, JSONB) TO service_role;

ALTER FUNCTION public.atomic_refund(UUID, UUID, TEXT)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_refund(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_refund(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_refund(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_refund(UUID, UUID, TEXT) TO service_role;

ALTER FUNCTION public.atomic_abort_settle(UUID, UUID, INTEGER, JSONB, TEXT, TEXT)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_abort_settle(UUID, UUID, INTEGER, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_abort_settle(UUID, UUID, INTEGER, JSONB, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_abort_settle(UUID, UUID, INTEGER, JSONB, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_abort_settle(UUID, UUID, INTEGER, JSONB, TEXT, TEXT) TO service_role;

ALTER FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) TO service_role;

ALTER FUNCTION public.atomic_finalize_ai_failure(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_failure(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_failure(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_failure(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_ai_failure(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) TO service_role;

ALTER FUNCTION public.atomic_finalize_ai_abort(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_abort(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_abort(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_finalize_ai_abort(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_ai_abort(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) TO service_role;

ALTER FUNCTION public.atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) TO service_role;

ALTER FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

ALTER FUNCTION public.atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) TO service_role;

ALTER FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) TO service_role;

ALTER FUNCTION public.atomic_fulfill_membership_invoice(
  TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(
  TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(
  TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(
  TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_membership_invoice(
  TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;
