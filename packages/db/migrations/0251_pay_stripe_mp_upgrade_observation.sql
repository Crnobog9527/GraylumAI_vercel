-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP step 4a (0251): Pro -> Gold upgrade of a renewing card (Managed Payments / mainland) subscription.
-- pay_waffo_admit_purchase (0222) admits an upgrade of a renewing prior only when the provider was observed renewing
-- within 5 minutes (user_subscriptions.method_observed_at), but nothing wrote that time, so a renewing Pro could
-- never upgrade. Before the upgrade checkout, the server reads the Stripe subscription; when Stripe shows it still
-- renewing, this records the observation. Our own record must agree (active, not stopping, no cancel request).
-- After the Gold payment the server stops the Pro at Stripe at period end (TS, then pay_stripe_mp_sync_subscription).
-- No table or column changes. Rollback: forward-fix (drop the function; admission then refuses as before).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_stripe_mp_observe_subscription(p_subscription uuid,p_merchant text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions;
BEGIN
 SELECT * INTO s FROM user_subscriptions WHERE id=p_subscription FOR UPDATE;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.payment_mode IS DISTINCT FROM 'test'
  OR s.merchant_namespace IS DISTINCT FROM p_merchant OR s.stripe_subscription_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM payment_orders WHERE subscription_id=s.id AND payment_channel='stripe'
   AND payment_method IN ('card','card_cn') AND auto_renew AND fulfilled_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=s.id AND object_type='subscription'
   AND channel='stripe' AND merchant_namespace=p_merchant AND mode='test') THEN
  RAISE EXCEPTION 'PAY_STRIPE_MP_RENEW_SCOPE'; END IF;
 -- Stripe was just seen renewing; our record must agree, otherwise admission keeps refusing the upgrade.
 IF s.status IS DISTINCT FROM 'active' OR s.cancel_at_period_end IS DISTINCT FROM 'false'
  OR s.method_cancel_requested_at IS NOT NULL THEN RETURN NULL; END IF;
 UPDATE user_subscriptions SET method_observed_at=clock_timestamp() WHERE id=s.id RETURNING method_observed_at INTO s.method_observed_at;
 RETURN s.method_observed_at;
END $$;
REVOKE ALL ON FUNCTION public.pay_stripe_mp_observe_subscription(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_stripe_mp_observe_subscription(uuid,text) TO service_role;

COMMIT;
