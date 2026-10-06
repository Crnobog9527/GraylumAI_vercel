-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-COMMON legacy cleanup; no data mutation until an explicitly invoked close.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $guard$
DECLARE body_hash text;
BEGIN
  SELECT md5(prosrc) INTO body_hash FROM pg_proc
    WHERE oid='public.pay_common_close_checkout(uuid,uuid,text,text,text,text,text)'::regprocedure;
  IF body_hash IS NULL OR body_hash NOT IN ('b13fe1a5ec1c2ded8c37705b2aa6b49f','f3b4df37a675a70b87240a253b90064b') THEN
    RAISE EXCEPTION 'PAY_COMMON_CLOSE_SCHEMA_DRIFT';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.pay_common_close_checkout(
  p_user_id uuid,p_order_id uuid,p_session_id text,p_merchant_namespace text,p_payment_mode text,
  p_checkout_status text,p_payment_status text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent public.payment_orders; close_reason text;
BEGIN
  IF p_checkout_status IS NULL OR p_checkout_status NOT IN ('expired','never_created','not_prepared','legacy_expired')
    OR p_payment_status IS DISTINCT FROM 'unpaid' THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_NOT_TERMINAL' USING ERRCODE='23514';
  END IF;
  -- Lock order shared with admission and fulfillment: profile before order.
  PERFORM 1 FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  SELECT * INTO intent FROM public.payment_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  -- Explicit operator-only legacy path. Provider evidence is read afresh by the adapter.
  -- Never backfill the frozen PAY-COMMON contract or fabricate provider references.
  IF FOUND AND p_checkout_status='legacy_expired' THEN
    IF intent.payment_channel IS NOT NULL OR intent.merchant_namespace IS NOT NULL
      OR intent.payment_mode IS NOT NULL OR intent.purchase_action IS NOT NULL
      OR intent.purchase_snapshot IS NOT NULL OR intent.purchase_request_id IS NOT NULL
      OR intent.item_type IS DISTINCT FROM 'membership_plan' OR intent.mode IS DISTINCT FROM 'subscription'
      OR intent.created_at >= '2026-09-23T00:00:00Z'::timestamptz
      OR intent.payment_status IS DISTINCT FROM 'unpaid' OR intent.fulfilled_at IS NOT NULL
      OR intent.status NOT IN ('pending','expired')
      OR intent.stripe_invoice_id IS NOT NULL OR intent.stripe_subscription_id IS NOT NULL
      OR intent.subscription_id IS NOT NULL OR intent.source_order_id IS NOT NULL
      OR intent.payment_amount_facts IS NOT NULL
      OR p_payment_mode IS NULL OR p_payment_mode NOT IN ('test','live')
      OR p_merchant_namespace IS NULL OR p_merchant_namespace !~ '^acct_[A-Za-z0-9]+$'
      OR p_session_id IS NULL OR p_session_id !~ ('^cs_' || p_payment_mode || '_[A-Za-z0-9]+$')
      OR intent.stripe_checkout_session_id IS DISTINCT FROM p_session_id
      OR EXISTS(SELECT 1 FROM public.payment_provider_refs WHERE order_id=intent.id)
      OR EXISTS(SELECT 1 FROM public.payment_orders WHERE source_order_id=intent.id)
      OR EXISTS(SELECT 1 FROM public.subscription_credit_grants WHERE source_order_id=intent.id)
      OR EXISTS(SELECT 1 FROM public.credit_transactions WHERE source_order_id=intent.id) THEN
      RAISE EXCEPTION 'PAY_COMMON_LEGACY_ORDER_UNRESOLVED' USING ERRCODE='23514';
    END IF;
    IF intent.purchase_closed_at IS NOT NULL THEN
      IF intent.status='expired' AND intent.purchase_close_ref=p_session_id
        AND intent.purchase_close_reason='stripe_checkout_expired' THEN RETURN false; END IF;
      RAISE EXCEPTION 'PAY_COMMON_LEGACY_ORDER_UNRESOLVED' USING ERRCODE='23514';
    END IF;
    IF intent.status<>'pending' OR intent.purchase_close_ref IS NOT NULL OR intent.purchase_close_reason IS NOT NULL THEN
      RAISE EXCEPTION 'PAY_COMMON_LEGACY_ORDER_UNRESOLVED' USING ERRCODE='23514';
    END IF;
    UPDATE public.payment_orders SET status='expired',purchase_closed_at=clock_timestamp(),
      purchase_close_reason='stripe_checkout_expired',purchase_close_ref=p_session_id,
      updated_at=clock_timestamp() WHERE id=intent.id;
    RETURN true;
  END IF;
  IF NOT FOUND OR intent.payment_channel IS DISTINCT FROM 'stripe'
    OR intent.merchant_namespace IS DISTINCT FROM p_merchant_namespace
    OR intent.payment_mode IS DISTINCT FROM p_payment_mode OR intent.purchase_action IS DISTINCT FROM 'checkout' THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF p_checkout_status='not_prepared' THEN
    -- Profile/order locks serialize this with request freezing. Without a committed
    -- envelope the adapter cannot have dispatched; a competing prepare must win first.
    IF p_session_id IS NOT NULL OR intent.checkout_request IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.payment_provider_refs WHERE order_id=intent.id
        AND object_type IN ('checkout','payment_intent','invoice','subscription'))
      OR intent.stripe_checkout_session_id IS NOT NULL
      OR intent.payment_status IS DISTINCT FROM 'unpaid' THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_NOT_TERMINAL' USING ERRCODE='23514';
    END IF;
    close_reason:='stripe_checkout_not_prepared';
  ELSIF p_checkout_status='never_created' THEN
    -- Only the service adapter can attest a complete, empty Stripe list after the immutable
    -- expiry plus one hour. Any known provider object or payment evidence forbids this path.
    IF p_session_id IS NOT NULL OR intent.checkout_request->>'expires_at' IS NULL
      OR (intent.checkout_request->>'expires_at')::bigint + 3600 > extract(epoch FROM clock_timestamp())
      OR EXISTS(SELECT 1 FROM public.payment_provider_refs WHERE order_id=intent.id
        AND object_type IN ('checkout','payment_intent','invoice','subscription'))
      OR intent.stripe_checkout_session_id IS NOT NULL
      OR intent.payment_status IS DISTINCT FROM 'unpaid' THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_NOT_TERMINAL' USING ERRCODE='23514';
    END IF;
    close_reason:='stripe_checkout_never_created';
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.payment_provider_refs r WHERE r.order_id=intent.id
      AND r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
      AND r.object_type='checkout' AND r.external_id=p_session_id) THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
    close_reason:='stripe_checkout_expired';
  END IF;
  IF intent.fulfilled_at IS NOT NULL OR intent.payment_status IN ('paid','refunded','partially_refunded')
    OR intent.status IN ('completed','refunded','partially_refunded') THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_ALREADY_PAID' USING ERRCODE='23514';
  END IF;
  IF intent.purchase_closed_at IS NOT NULL THEN
    IF intent.purchase_close_ref IS DISTINCT FROM p_session_id
      OR intent.purchase_close_reason IS DISTINCT FROM close_reason THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
    RETURN false;
  END IF;
  UPDATE public.payment_orders SET purchase_closed_at=clock_timestamp(),
    purchase_close_reason=close_reason,purchase_close_ref=p_session_id,
    status='expired',updated_at=clock_timestamp() WHERE id=intent.id;
  RETURN true;
END $fn$;
-- Existing service-only ACL is retained by CREATE OR REPLACE.
COMMIT;
