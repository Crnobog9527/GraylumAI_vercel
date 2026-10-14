-- Run by run-local.mjs after the seed replay, with the guard block cut from the real seed filled into the placeholders.
-- Nothing here persists: the mapped price and the changed amount are rolled back.
BEGIN;
INSERT INTO public.payment_provider_refs (channel, merchant_namespace, mode, object_type, external_id, membership_plan_id,
  billing_cycle, is_current)
SELECT 'stripe', 'acct_seed_guard', 'test', 'price', 'price_seed_guard_pro_monthly', id, 'monthly', true
FROM public.membership_plans WHERE level = 'pro';
-- A mapped price whose amount already matches the seed does not block a replay.
__SEED_PRICE_GUARD__
UPDATE public.membership_plans SET monthly_price = 3000 WHERE level = 'pro';
DO $guard_test$
BEGIN
  BEGIN
    EXECUTE $guard_sql$__SEED_PRICE_GUARD_STATEMENT__$guard_sql$;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'SEED_PRICE_REPLACEMENT_REQUIRED' THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'seed replay would change a mapped Stripe price amount';
END $guard_test$;
ROLLBACK;
