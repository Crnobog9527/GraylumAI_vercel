CREATE OR REPLACE FUNCTION public.atomic_grant_subscription_invoice_credits(
  p_user_id UUID,
  p_membership_plan_id UUID,
  p_stripe_subscription_id TEXT,
  p_stripe_invoice_id TEXT,
  p_source_order_id UUID,
  p_amount_total INTEGER DEFAULT NULL,
  p_currency TEXT DEFAULT 'usd',
  p_payment_status TEXT DEFAULT 'paid',
  p_stripe_customer_id TEXT DEFAULT NULL,
  p_grant_period_key TEXT DEFAULT NULL,
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_period_end TIMESTAMPTZ DEFAULT NULL,
  p_period_index INTEGER DEFAULT NULL,
  p_total_periods INTEGER DEFAULT 1,
  p_credits_granted INTEGER DEFAULT NULL,
  p_billing_cycle TEXT DEFAULT 'monthly',
  p_membership_level TEXT DEFAULT NULL,
  p_can_promote_checkout_order BOOLEAN DEFAULT FALSE,
  p_grant_type TEXT DEFAULT 'monthly_invoice',
  p_idempotency_key TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_source_type TEXT DEFAULT 'stripe_invoice',
  p_source_id TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB,
  p_grant_metadata JSONB DEFAULT '{}'::JSONB,
  p_now TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  transaction_id UUID,
  balance_before INTEGER,
  balance_after INTEGER,
  amount INTEGER,
  is_idempotent BOOLEAN,
  granted BOOLEAN,
  blocked_by_termination BOOLEAN,
  grant_id UUID,
  credits_granted INTEGER,
  invoice_order_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_source_status TEXT;
  v_source_payment_status TEXT;
  v_source_metadata JSONB;
  v_source_customer_id TEXT;
  v_source_price_id TEXT;
  v_source_checkout_session_id TEXT;
  v_invoice_status TEXT;
  v_invoice_payment_status TEXT;
  v_invoice_metadata JSONB;
  v_mirror_id UUID;
  v_mirror_metadata JSONB;
  v_terminated_at TIMESTAMPTZ;
  v_grant_period_start TIMESTAMPTZ;
  v_grant_period_end TIMESTAMPTZ;
  v_grant_period_key TEXT;
  v_grant_period_index INTEGER;
  v_grant_total_periods INTEGER;
  v_existing_grant_id UUID;
  v_existing_grant_transaction_id UUID;
  v_existing_grant_credits INTEGER;
  v_existing_grant_period_start TIMESTAMPTZ;
  v_existing_grant_period_end TIMESTAMPTZ;
  v_existing_grant_period_key TEXT;
  v_existing_grant_period_index INTEGER;
  v_existing_grant_total_periods INTEGER;
  v_transaction_id UUID;
  v_grant_id UUID;
BEGIN
  IF p_user_id IS NULL OR p_membership_plan_id IS NULL
     OR NULLIF(btrim(COALESCE(p_stripe_subscription_id, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_stripe_invoice_id, '')), '') IS NULL
     OR p_source_order_id IS NULL
     OR NULLIF(btrim(COALESCE(p_grant_period_key, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL
     OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start
     OR p_credits_granted IS NULL OR p_credits_granted <= 0 THEN
    RAISE EXCEPTION 'INVOICE_GRANT_ADMISSION_INPUT_INVALID';
  END IF;

  SELECT credits INTO v_balance_before
  FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_GRANT_PROFILE_MISSING: %', p_user_id;
  END IF;

  SELECT status, payment_status, metadata, stripe_customer_id, stripe_price_id, stripe_checkout_session_id
  INTO v_source_status, v_source_payment_status, v_source_metadata, v_source_customer_id, v_source_price_id, v_source_checkout_session_id
  FROM payment_orders WHERE id = p_source_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_GRANT_SOURCE_ORDER_MISSING: %', p_source_order_id;
  END IF;

  SELECT id, status, payment_status, metadata
  INTO invoice_order_id, v_invoice_status, v_invoice_payment_status, v_invoice_metadata
  FROM payment_orders
  WHERE stripe_invoice_id = p_stripe_invoice_id
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE;

  IF lower(COALESCE(v_source_status, '')) IN ('refunded', 'partially_refunded')
     OR lower(COALESCE(v_source_payment_status, '')) IN ('refunded', 'partially_refunded')
     OR v_source_metadata ? 'stripeRefund'
     OR v_source_metadata ? 'subscriptionCreditGrantReversal'
     OR lower(COALESCE(v_invoice_status, '')) IN ('refunded', 'partially_refunded')
     OR lower(COALESCE(v_invoice_payment_status, '')) IN ('refunded', 'partially_refunded')
     OR v_invoice_metadata ? 'stripeRefund'
     OR v_invoice_metadata ? 'subscriptionCreditGrantReversal' THEN
    RETURN QUERY SELECT NULL::UUID, v_balance_before, v_balance_before, 0, FALSE, FALSE, TRUE, NULL::UUID, 0, invoice_order_id;
    RETURN;
  END IF;

  SELECT id, credit_release_terminated_at, metadata
  INTO v_mirror_id, v_terminated_at, v_mirror_metadata
  FROM user_subscriptions
  WHERE user_id = p_user_id AND stripe_subscription_id = p_stripe_subscription_id
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE;

  IF v_mirror_id IS NOT NULL AND v_terminated_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, v_balance_before, v_balance_before, 0, FALSE, FALSE, TRUE, NULL::UUID, 0, invoice_order_id;
    RETURN;
  END IF;

  -- Invoice p_period_start/end are the full Stripe subscription term. The
  -- annual grant row receives its own internally derived period-01 window.
  IF p_billing_cycle = 'yearly' THEN
    IF p_grant_type IS DISTINCT FROM 'annual_monthly_release'
       OR p_period_index IS DISTINCT FROM 1
       OR p_total_periods IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'INVOICE_GRANT_ANNUAL_PERIOD_INPUT_INVALID';
    END IF;
    v_grant_period_start := p_period_start;
    v_grant_period_end := LEAST(
      (((p_period_start AT TIME ZONE 'UTC') + make_interval(months => 1)) AT TIME ZONE 'UTC'),
      p_period_end
    );
    v_grant_period_index := 1;
    v_grant_total_periods := 12;
    v_grant_period_key := format(
      'annual:%s:01',
      to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    IF v_grant_period_start >= v_grant_period_end
       OR p_grant_period_key IS DISTINCT FROM v_grant_period_key THEN
      RAISE EXCEPTION 'INVOICE_GRANT_ANNUAL_TERM_OR_KEY_NONCANONICAL';
    END IF;
  ELSIF p_billing_cycle = 'monthly' THEN
    IF p_grant_type IS DISTINCT FROM 'monthly_invoice' THEN
      RAISE EXCEPTION 'INVOICE_GRANT_MONTHLY_PERIOD_INPUT_INVALID';
    END IF;
    v_grant_period_start := p_period_start;
    v_grant_period_end := p_period_end;
    v_grant_period_index := p_period_index;
    v_grant_total_periods := p_total_periods;
    v_grant_period_key := p_grant_period_key;
  ELSE
    RAISE EXCEPTION 'INVOICE_GRANT_BILLING_CYCLE_INVALID';
  END IF;

  SELECT id, credit_transaction_id, subscription_credit_grants.credits_granted, period_start, period_end,
         grant_period_key, period_index, total_periods
  INTO v_existing_grant_id, v_existing_grant_transaction_id, v_existing_grant_credits,
       v_existing_grant_period_start, v_existing_grant_period_end,
       v_existing_grant_period_key, v_existing_grant_period_index, v_existing_grant_total_periods
  FROM subscription_credit_grants
  WHERE stripe_subscription_id = p_stripe_subscription_id
    AND (idempotency_key = p_idempotency_key OR grant_period_key = p_grant_period_key)
  ORDER BY (idempotency_key = p_idempotency_key) DESC, created_at ASC
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_existing_grant_period_start IS DISTINCT FROM v_grant_period_start
       OR v_existing_grant_period_end IS DISTINCT FROM v_grant_period_end
       OR v_existing_grant_period_key IS DISTINCT FROM v_grant_period_key
       OR v_existing_grant_period_index IS DISTINCT FROM v_grant_period_index
       OR v_existing_grant_total_periods IS DISTINCT FROM v_grant_total_periods THEN
      RAISE EXCEPTION 'INVOICE_GRANT_EXISTING_REPLAY_ROW_NONCANONICAL';
    END IF;
    RETURN QUERY SELECT v_existing_grant_transaction_id, v_balance_before, v_balance_before,
      COALESCE(v_existing_grant_credits, 0), TRUE, FALSE, FALSE, v_existing_grant_id,
      COALESCE(v_existing_grant_credits, 0), invoice_order_id;
    RETURN;
  END IF;

  v_balance_after := v_balance_before + p_credits_granted;
  INSERT INTO credit_transactions (
    user_id, amount, type, description, idempotency_key, balance_before, balance_after,
    ledger_type, reason_code, counts_as_spend, source_type, source_id, source_order_id,
    grant_period_key, metadata
  ) VALUES (
    p_user_id, p_credits_granted, 'addition', p_description, p_idempotency_key, v_balance_before, v_balance_after,
    'grant', p_grant_type, FALSE, p_source_type, p_source_id, p_source_order_id,
    v_grant_period_key, COALESCE(p_metadata, '{}'::JSONB)
  ) RETURNING id INTO v_transaction_id;

  UPDATE profiles
  SET credits = v_balance_after,
      membership_level = COALESCE(NULLIF(btrim(p_membership_level), ''), membership_level)
  WHERE id = p_user_id;

  INSERT INTO subscription_credit_grants (
    user_id, membership_plan_id, stripe_subscription_id, stripe_invoice_id, billing_cycle,
    grant_type, grant_period_key, period_start, period_end, period_index, total_periods,
    credits_granted, status, idempotency_key, credit_transaction_id, metadata, created_at, updated_at
  ) VALUES (
    p_user_id, p_membership_plan_id, p_stripe_subscription_id, p_stripe_invoice_id,
    CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
    p_grant_type, v_grant_period_key, v_grant_period_start, v_grant_period_end, v_grant_period_index, v_grant_total_periods,
    p_credits_granted, 'granted', p_idempotency_key, v_transaction_id, COALESCE(p_grant_metadata, '{}'::JSONB), v_now, v_now
  ) RETURNING id INTO v_grant_id;

  IF v_mirror_id IS NULL THEN
    INSERT INTO user_subscriptions (
      user_id, membership_plan_id, stripe_customer_id, stripe_subscription_id,
      stripe_price_id, billing_cycle, status, cancel_at_period_end,
      current_period_start, current_period_end, metadata, updated_at
    ) VALUES (
      p_user_id, p_membership_plan_id, COALESCE(v_source_customer_id, p_stripe_customer_id), p_stripe_subscription_id,
      v_source_price_id, CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END, 'active', 'false',
      p_period_start, p_period_end,
      jsonb_build_object(
        'lastInvoiceId', p_stripe_invoice_id,
        'lastInvoicePaymentStatus', COALESCE(p_payment_status, 'paid'),
        'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
      ),
      v_now
    );
  ELSE
    UPDATE user_subscriptions
    SET membership_plan_id = p_membership_plan_id,
        stripe_customer_id = COALESCE(v_source_customer_id, p_stripe_customer_id),
        stripe_price_id = v_source_price_id,
        billing_cycle = CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
        current_period_start = p_period_start,
        current_period_end = p_period_end,
        metadata = COALESCE(v_mirror_metadata, '{}'::JSONB) || jsonb_build_object(
          'lastInvoiceId', p_stripe_invoice_id,
          'lastInvoicePaymentStatus', COALESCE(p_payment_status, 'paid'),
          'transactionId', v_transaction_id,
          'subscriptionCreditGrantId', v_grant_id,
          'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
        ),
        updated_at = v_now
    WHERE id = v_mirror_id
      AND credit_release_terminated_at IS NULL;
  END IF;

  IF invoice_order_id IS NOT NULL THEN
    UPDATE payment_orders SET
      status = 'completed', payment_status = COALESCE(p_payment_status, 'paid'), fulfilled_at = v_now,
      metadata = COALESCE(v_invoice_metadata, '{}'::JSONB) || jsonb_build_object(
        'source', 'invoice.payment_succeeded', 'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id, 'grantedCredits', p_credits_granted,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
      ), updated_at = v_now
    WHERE id = invoice_order_id
      AND lower(COALESCE(status, '')) NOT IN ('refunded', 'partially_refunded')
      AND lower(COALESCE(payment_status, '')) NOT IN ('refunded', 'partially_refunded');
  ELSIF p_can_promote_checkout_order AND v_source_checkout_session_id IS NOT NULL THEN
    UPDATE payment_orders SET
      stripe_invoice_id = p_stripe_invoice_id, stripe_subscription_id = p_stripe_subscription_id,
      status = 'completed', payment_status = COALESCE(p_payment_status, 'paid'), fulfilled_at = v_now,
      metadata = COALESCE(v_source_metadata, '{}'::JSONB) || jsonb_build_object(
        'source', 'invoice.payment_succeeded', 'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id, 'grantedCredits', p_credits_granted,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
      ), updated_at = v_now
    WHERE id = p_source_order_id
      AND lower(COALESCE(status, '')) NOT IN ('refunded', 'partially_refunded')
      AND lower(COALESCE(payment_status, '')) NOT IN ('refunded', 'partially_refunded')
    RETURNING id INTO invoice_order_id;
  ELSE
    INSERT INTO payment_orders (
      user_id, item_type, item_id, billing_cycle, stripe_invoice_id, stripe_subscription_id,
      stripe_customer_id, stripe_price_id, amount_total, currency, mode, status, payment_status,
      fulfilled_at, metadata, updated_at
    ) VALUES (
      p_user_id, 'membership_plan', p_membership_plan_id,
      CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
      p_stripe_invoice_id, p_stripe_subscription_id, COALESCE(v_source_customer_id, p_stripe_customer_id),
      v_source_price_id, p_amount_total, COALESCE(p_currency, 'usd'), 'subscription', 'completed',
      COALESCE(p_payment_status, 'paid'), v_now,
      jsonb_build_object('source', 'invoice.payment_succeeded', 'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id, 'grantedCredits', p_credits_granted,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'), v_now
    ) RETURNING id INTO invoice_order_id;
  END IF;

  RETURN QUERY SELECT v_transaction_id, v_balance_before, v_balance_after, p_credits_granted,
    FALSE, TRUE, FALSE, v_grant_id, p_credits_granted, invoice_order_id;
END;
$$;


-- Reassert the SEC-1 service-role-only posture for the repaired invoice RPC.
ALTER FUNCTION public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz) TO service_role;

