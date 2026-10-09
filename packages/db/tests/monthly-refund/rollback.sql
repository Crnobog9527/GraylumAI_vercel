-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local empty-fact rollback only. Once an approval exists preserve and repair forward.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM payment_orders WHERE refund_approval->>'kind'='monthly_first_purchase') THEN
  RAISE EXCEPTION 'PAY_MONTHLY_ROLLBACK_REQUIRES_FORWARD_FIX'; END IF;
END $$;
DROP TRIGGER IF EXISTS monthly_refund_source_guard ON user_subscriptions;
DROP TRIGGER IF EXISTS monthly_refund_source_guard ON subscription_credit_grants;
DROP TRIGGER IF EXISTS monthly_refund_account_guard ON profiles;
DROP TRIGGER IF EXISTS monthly_refund_account_guard ON payment_orders;
DO $$
DECLARE original text:=pg_get_functiondef('public.account_erasure_financial_proof(uuid)'::regprocedure);
 needle text:='OR (refund_approval IS NOT NULL AND NOT monthly_refund_erasure_safe(refund_approval)));';
BEGIN
 IF length(original)-length(replace(original,needle,''))<>length(needle) THEN RAISE EXCEPTION 'PAY_MONTHLY_ROLLBACK_SOURCE_MISMATCH'; END IF;
 EXECUTE replace(original,needle,'OR refund_approval IS NOT NULL);');
 original:=pg_get_functiondef('public.account_erasure_renewing(uuid)'::regprocedure);
 -- Restore the original function body exactly, as fingerprinted before 0193.
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_renewing(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_subscriptions s
    WHERE s.user_id = p_profile_id AND s.stripe_subscription_id IS NOT NULL
      AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid')
      AND s.cancel_at_period_end::text IS DISTINCT FROM 'true'
  );
$$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND (proname LIKE 'monthly_refund_%' OR proname LIKE 'pay_common_monthly_refund_%') LOOP
 EXECUTE 'DROP FUNCTION public.'||f.name; END LOOP;
END $$;
COMMIT;
