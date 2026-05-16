-- Migration: restore staging helper functions
-- Related issue: #148
--
-- Purpose:
--   Reconcile missing repo-covered helper/functions for staging reproducibility.
--
-- Safety notes:
--   - Does not seed data.
--   - Does not configure secrets.
--   - Does not execute chat or billing flows.
--   - Does not touch production by itself.
--   - Do not apply without owner approval.
--
-- Sources:
--   - is_admin(): 0001_ai_billing_tables.sql, search_path posture from 0015_security_advisor_hardening.sql.
--   - atomic_fulfill_*: 0018_payment_fulfillment_atomicity.sql, search_path posture from 0021_supabase_security_advisor_cleanup.sql.
--   - validate_invitation_code(): 0019_public_route_rls_hardening.sql.
--   - atomic_apply_credit_ledger_entry(): 0024_atomic_apply_credit_ledger_entry.sql, execute posture from 0027_balance_write_surface_lockdown.sql.
--   - atomic_claim_invitation_code(): 0025_atomic_claim_invitation_code.sql, execute posture from 0027_balance_write_surface_lockdown.sql.

-- 检查用户是否是管理员的函数
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.is_admin() SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION atomic_fulfill_credit_package(
  p_checkout_session_id TEXT,
  p_payment_status TEXT DEFAULT 'paid'
)
RETURNS TABLE (
  order_id UUID,
  user_id UUID,
  granted_credits INTEGER,
  fulfilled_at TIMESTAMPTZ,
  already_fulfilled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id UUID;
  v_user_id UUID;
  v_package_id UUID;
  v_package_name TEXT;
  v_credits_amount INTEGER;
  v_bonus_credits INTEGER;
  v_total_credits INTEGER;
  v_transaction_id UUID;
  v_fulfilled_at TIMESTAMPTZ;
  v_existing_fulfilled_at TIMESTAMPTZ;
  v_metadata JSONB;
BEGIN
  SELECT id, user_id, item_id, fulfilled_at, metadata
  INTO v_order_id, v_user_id, v_package_id, v_existing_fulfilled_at, v_metadata
  FROM payment_orders
  WHERE stripe_checkout_session_id = p_checkout_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found for checkout session %', p_checkout_session_id;
  END IF;

  IF v_existing_fulfilled_at IS NOT NULL THEN
    RETURN QUERY SELECT v_order_id, v_user_id, 0, v_existing_fulfilled_at, TRUE;
    RETURN;
  END IF;

  IF v_user_id IS NULL OR v_package_id IS NULL THEN
    RAISE EXCEPTION 'invalid payment order for checkout session %', p_checkout_session_id;
  END IF;

  SELECT name, credits_amount, bonus_credits
  INTO v_package_name, v_credits_amount, v_bonus_credits
  FROM credit_packages
  WHERE id = v_package_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit package not found for checkout session %', p_checkout_session_id;
  END IF;

  v_total_credits := COALESCE(v_credits_amount, 0) + COALESCE(v_bonus_credits, 0);
  v_fulfilled_at := NOW();

  PERFORM 1
  FROM profiles
  WHERE id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for checkout session %', p_checkout_session_id;
  END IF;

  UPDATE profiles
  SET credits = credits + v_total_credits
  WHERE id = v_user_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description
  ) VALUES (
    v_user_id,
    v_total_credits,
    'purchase',
    format('Stripe 购买积分包: %s [checkout:%s]', v_package_name, p_checkout_session_id)
  )
  RETURNING id INTO v_transaction_id;

  UPDATE payment_orders
  SET
    status = 'completed',
    payment_status = COALESCE(p_payment_status, 'paid'),
    fulfilled_at = v_fulfilled_at,
    updated_at = v_fulfilled_at,
    metadata = COALESCE(v_metadata, '{}'::jsonb) || jsonb_build_object(
      'transactionId', v_transaction_id,
      'grantedCredits', v_total_credits,
      'fulfillmentSource', 'atomic_fulfill_credit_package'
    )
  WHERE id = v_order_id;

  RETURN QUERY SELECT v_order_id, v_user_id, v_total_credits, v_fulfilled_at, FALSE;
END;
$$;

alter function public.atomic_fulfill_credit_package(text, text)
  set search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION atomic_fulfill_credit_package(TEXT, TEXT) IS 'Atomically grants one-time package credits and marks the checkout order fulfilled.';

CREATE OR REPLACE FUNCTION atomic_fulfill_membership_invoice(
  p_invoice_id TEXT,
  p_subscription_id TEXT,
  p_amount_total INTEGER,
  p_currency TEXT DEFAULT 'usd',
  p_payment_status TEXT DEFAULT 'paid',
  p_stripe_customer_id TEXT DEFAULT NULL,
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_period_end TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  invoice_order_id UUID,
  user_id UUID,
  granted_credits INTEGER,
  fulfilled_at TIMESTAMPTZ,
  already_fulfilled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice_order_id UUID;
  v_existing_fulfilled_at TIMESTAMPTZ;
  v_invoice_metadata JSONB;
  v_session_order_user_id UUID;
  v_session_order_item_id UUID;
  v_session_order_billing_cycle TEXT;
  v_session_order_customer_id TEXT;
  v_session_order_price_id TEXT;
  v_plan_id UUID;
  v_plan_name TEXT;
  v_plan_level TEXT;
  v_monthly_credits INTEGER;
  v_yearly_credits INTEGER;
  v_monthly_bonus_credits INTEGER;
  v_granted_credits INTEGER;
  v_transaction_id UUID;
  v_fulfilled_at TIMESTAMPTZ;
BEGIN
  SELECT id, fulfilled_at, metadata
  INTO v_invoice_order_id, v_existing_fulfilled_at, v_invoice_metadata
  FROM payment_orders
  WHERE stripe_invoice_id = p_invoice_id
  FOR UPDATE;

  IF FOUND AND v_existing_fulfilled_at IS NOT NULL THEN
    SELECT user_id INTO v_session_order_user_id
    FROM payment_orders
    WHERE id = v_invoice_order_id;

    RETURN QUERY SELECT v_invoice_order_id, v_session_order_user_id, 0, v_existing_fulfilled_at, TRUE;
    RETURN;
  END IF;

  SELECT user_id, item_id, billing_cycle, stripe_customer_id, stripe_price_id
  INTO v_session_order_user_id, v_session_order_item_id, v_session_order_billing_cycle, v_session_order_customer_id, v_session_order_price_id
  FROM payment_orders
  WHERE stripe_subscription_id = p_subscription_id
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR v_session_order_user_id IS NULL OR v_session_order_item_id IS NULL THEN
    RAISE EXCEPTION 'subscription order not found for invoice %', p_invoice_id;
  END IF;

  SELECT id, name, level, monthly_credits, yearly_credits, monthly_bonus_credits
  INTO v_plan_id, v_plan_name, v_plan_level, v_monthly_credits, v_yearly_credits, v_monthly_bonus_credits
  FROM membership_plans
  WHERE id = v_session_order_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership plan not found for invoice %', p_invoice_id;
  END IF;

  PERFORM 1
  FROM profiles
  WHERE id = v_session_order_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for invoice %', p_invoice_id;
  END IF;

  v_session_order_billing_cycle := CASE
    WHEN v_session_order_billing_cycle = 'yearly' THEN 'yearly'
    ELSE 'monthly'
  END;

  v_granted_credits := CASE
    WHEN v_session_order_billing_cycle = 'yearly' THEN COALESCE(v_yearly_credits, 0)
    ELSE COALESCE(v_monthly_credits, 0) + COALESCE(v_monthly_bonus_credits, 0)
  END;

  v_fulfilled_at := NOW();

  UPDATE profiles
  SET
    membership_level = v_plan_level,
    credits = credits + v_granted_credits
  WHERE id = v_session_order_user_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description
  ) VALUES (
    v_session_order_user_id,
    v_granted_credits,
    'addition',
    format(
      'Stripe 会员积分到账: %s (%s) [invoice:%s]',
      v_plan_name,
      CASE WHEN v_session_order_billing_cycle = 'yearly' THEN '年付' ELSE '月付' END,
      p_invoice_id
    )
  )
  RETURNING id INTO v_transaction_id;

  INSERT INTO user_subscriptions (
    user_id,
    membership_plan_id,
    stripe_customer_id,
    stripe_subscription_id,
    stripe_price_id,
    billing_cycle,
    status,
    cancel_at_period_end,
    current_period_start,
    current_period_end,
    metadata,
    updated_at
  ) VALUES (
    v_session_order_user_id,
    v_plan_id,
    COALESCE(v_session_order_customer_id, p_stripe_customer_id),
    p_subscription_id,
    v_session_order_price_id,
    v_session_order_billing_cycle,
    COALESCE(p_payment_status, 'paid'),
    'false',
    p_period_start,
    p_period_end,
    jsonb_build_object(
      'lastInvoiceId', p_invoice_id,
      'transactionId', v_transaction_id,
      'fulfillmentSource', 'atomic_fulfill_membership_invoice'
    ),
    v_fulfilled_at
  )
  ON CONFLICT (stripe_subscription_id) DO UPDATE
  SET
    membership_plan_id = EXCLUDED.membership_plan_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    billing_cycle = EXCLUDED.billing_cycle,
    status = EXCLUDED.status,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    metadata = COALESCE(user_subscriptions.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = EXCLUDED.updated_at;

  IF v_invoice_order_id IS NOT NULL THEN
    UPDATE payment_orders
    SET
      user_id = v_session_order_user_id,
      item_type = 'membership_plan',
      item_id = v_plan_id,
      billing_cycle = v_session_order_billing_cycle,
      stripe_subscription_id = p_subscription_id,
      stripe_customer_id = COALESCE(v_session_order_customer_id, p_stripe_customer_id),
      stripe_price_id = v_session_order_price_id,
      amount_total = p_amount_total,
      currency = COALESCE(p_currency, 'usd'),
      mode = 'subscription',
      status = 'completed',
      payment_status = COALESCE(p_payment_status, 'paid'),
      fulfilled_at = v_fulfilled_at,
      updated_at = v_fulfilled_at,
      metadata = COALESCE(v_invoice_metadata, '{}'::jsonb) || jsonb_build_object(
        'transactionId', v_transaction_id,
        'grantedCredits', v_granted_credits,
        'fulfillmentSource', 'atomic_fulfill_membership_invoice'
      )
    WHERE id = v_invoice_order_id;
  ELSE
    INSERT INTO payment_orders (
      user_id,
      item_type,
      item_id,
      billing_cycle,
      stripe_invoice_id,
      stripe_subscription_id,
      stripe_customer_id,
      stripe_price_id,
      amount_total,
      currency,
      mode,
      status,
      payment_status,
      fulfilled_at,
      metadata,
      updated_at
    ) VALUES (
      v_session_order_user_id,
      'membership_plan',
      v_plan_id,
      v_session_order_billing_cycle,
      p_invoice_id,
      p_subscription_id,
      COALESCE(v_session_order_customer_id, p_stripe_customer_id),
      v_session_order_price_id,
      p_amount_total,
      COALESCE(p_currency, 'usd'),
      'subscription',
      'completed',
      COALESCE(p_payment_status, 'paid'),
      v_fulfilled_at,
      jsonb_build_object(
        'source', 'invoice.payment_succeeded',
        'transactionId', v_transaction_id,
        'grantedCredits', v_granted_credits,
        'fulfillmentSource', 'atomic_fulfill_membership_invoice'
      ),
      v_fulfilled_at
    )
    RETURNING id INTO v_invoice_order_id;
  END IF;

  RETURN QUERY SELECT v_invoice_order_id, v_session_order_user_id, v_granted_credits, v_fulfilled_at, FALSE;
END;
$$;

alter function public.atomic_fulfill_membership_invoice(
  text,
  text,
  integer,
  text,
  text,
  text,
  timestamptz,
  timestamptz
)
  set search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) IS 'Atomically applies a paid subscription invoice, grants credits, syncs subscription state, and marks the invoice order fulfilled.';

create or replace function public.validate_invitation_code(input_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.invitations
    where code = input_code
      and status = 'active'
  );
end;
$$;

revoke all on function public.validate_invitation_code(text) from public;
grant execute on function public.validate_invitation_code(text) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION atomic_apply_credit_ledger_entry(
  p_user_id UUID,
  p_amount INTEGER,
  p_type TEXT,
  p_description TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  transaction_id UUID,
  balance_before INTEGER,
  balance_after INTEGER,
  amount INTEGER,
  is_idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_transaction_id UUID;
  v_existing_transaction RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'amount must be non-zero';
  END IF;

  IF p_type IS NULL OR btrim(p_type) = '' THEN
    RAISE EXCEPTION 'transaction type is required';
  END IF;

  SELECT credits
  INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for user %', p_user_id;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT ct.id, ct.balance_before, ct.balance_after, ct.amount
    INTO v_existing_transaction
    FROM credit_transactions AS ct
    WHERE ct.user_id = p_user_id
      AND ct.idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing_transaction.id,
        v_existing_transaction.balance_before,
        v_existing_transaction.balance_after,
        v_existing_transaction.amount,
        TRUE;
      RETURN;
    END IF;
  END IF;

  v_balance_after := v_balance_before + p_amount;

  IF v_balance_after < 0 THEN
    RAISE EXCEPTION 'insufficient credits for user %: balance %, adjustment %',
      p_user_id,
      v_balance_before,
      p_amount;
  END IF;

  UPDATE profiles
  SET credits = v_balance_after
  WHERE id = p_user_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description,
    idempotency_key,
    balance_before,
    balance_after
  ) VALUES (
    p_user_id,
    p_amount,
    p_type,
    p_description,
    p_idempotency_key,
    v_balance_before,
    v_balance_after
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT
    v_transaction_id,
    v_balance_before,
    v_balance_after,
    p_amount,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT)
  IS 'Atomically applies one credit ledger entry by locking profiles, updating credits, inserting credit_transactions, and honoring per-user idempotency keys';

CREATE OR REPLACE FUNCTION atomic_claim_invitation_code(
  p_invitation_code TEXT,
  p_invitee_id UUID,
  p_invitee_email TEXT,
  p_claim_status TEXT,
  p_risk_level TEXT,
  p_block_reason TEXT DEFAULT NULL,
  p_inviter_reward INTEGER DEFAULT 0,
  p_invitee_reward INTEGER DEFAULT 0,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
  invitation_record_id UUID,
  invitation_code TEXT,
  inviter_id UUID,
  invitee_id UUID,
  status TEXT,
  risk_level TEXT,
  block_reason TEXT,
  inviter_reward INTEGER,
  invitee_reward INTEGER,
  inviter_transaction_id UUID,
  invitee_transaction_id UUID,
  is_idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation_code TEXT := btrim(p_invitation_code);
  v_invitation RECORD;
  v_existing_record RECORD;
  v_profile RECORD;
  v_inviter_id UUID;
  v_inviter_email TEXT;
  v_invitee_profile_found BOOLEAN := FALSE;
  v_inviter_ledger RECORD;
  v_invitee_ledger RECORD;
  v_inviter_transaction_id UUID;
  v_invitee_transaction_id UUID;
  v_inviter_idempotency_key TEXT;
  v_invitee_idempotency_key TEXT;
  v_inviter_description TEXT;
  v_invitee_description TEXT;
  v_invitation_record_id UUID;
  v_rewarded_at TIMESTAMPTZ;
BEGIN
  IF v_invitation_code IS NULL OR v_invitation_code = '' THEN
    RAISE EXCEPTION 'invitation code is required';
  END IF;

  IF p_invitee_id IS NULL THEN
    RAISE EXCEPTION 'invitee_id is required';
  END IF;

  IF p_invitee_email IS NULL OR btrim(p_invitee_email) = '' THEN
    RAISE EXCEPTION 'invitee_email is required';
  END IF;

  IF p_claim_status NOT IN ('rewarded', 'rejected') THEN
    RAISE EXCEPTION 'invalid invitation claim status: %', p_claim_status;
  END IF;

  IF p_risk_level NOT IN ('low', 'medium', 'high') THEN
    RAISE EXCEPTION 'invalid invitation risk level: %', p_risk_level;
  END IF;

  IF COALESCE(p_inviter_reward, 0) < 0 OR COALESCE(p_invitee_reward, 0) < 0 THEN
    RAISE EXCEPTION 'invitation rewards must be non-negative';
  END IF;

  IF p_claim_status <> 'rewarded'
    AND (COALESCE(p_inviter_reward, 0) <> 0 OR COALESCE(p_invitee_reward, 0) <> 0) THEN
    RAISE EXCEPTION 'rejected invitation claims cannot grant rewards';
  END IF;

  SELECT i.code, i.created_by, i.status, i.used_by
  INTO v_invitation
  FROM invitations AS i
  WHERE i.code = v_invitation_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation code not found: %', v_invitation_code;
  END IF;

  SELECT ir.*
  INTO v_existing_record
  FROM invitation_records AS ir
  WHERE ir.invite_code = v_invitation_code
    AND ir.invitee_id = p_invitee_id
  LIMIT 1;

  IF FOUND THEN
    v_inviter_idempotency_key := format(
      'invitation_claim:inviter:%s:%s:%s',
      v_invitation_code,
      v_existing_record.inviter_id,
      p_invitee_id
    );
    v_invitee_idempotency_key := format(
      'invitation_claim:invitee:%s:%s',
      v_invitation_code,
      p_invitee_id
    );

    IF COALESCE(v_existing_record.inviter_reward, 0) > 0 THEN
      SELECT ct.id
      INTO v_inviter_transaction_id
      FROM credit_transactions AS ct
      WHERE ct.user_id = v_existing_record.inviter_id
        AND ct.idempotency_key = v_inviter_idempotency_key
      LIMIT 1;
    END IF;

    IF COALESCE(v_existing_record.invitee_reward, 0) > 0 THEN
      SELECT ct.id
      INTO v_invitee_transaction_id
      FROM credit_transactions AS ct
      WHERE ct.user_id = p_invitee_id
        AND ct.idempotency_key = v_invitee_idempotency_key
      LIMIT 1;
    END IF;

    IF v_invitation.status = 'active' THEN
      UPDATE invitations AS i
      SET
        status = 'used',
        used_by = v_existing_record.invitee_id
      WHERE i.code = v_invitation_code;
    END IF;

    RETURN QUERY SELECT
      v_existing_record.id,
      v_existing_record.invite_code,
      v_existing_record.inviter_id,
      v_existing_record.invitee_id,
      v_existing_record.status,
      v_existing_record.risk_level,
      v_existing_record.block_reason,
      v_existing_record.inviter_reward,
      v_existing_record.invitee_reward,
      v_inviter_transaction_id,
      v_invitee_transaction_id,
      TRUE;
    RETURN;
  END IF;

  IF v_invitation.status <> 'active' OR v_invitation.used_by IS NOT NULL THEN
    RAISE EXCEPTION 'invitation code is not active: %', v_invitation_code;
  END IF;

  IF v_invitation.created_by = p_invitee_id THEN
    RAISE EXCEPTION 'cannot claim own invitation code';
  END IF;

  FOR v_profile IN
    SELECT p.id, p.email, p.credits
    FROM profiles AS p
    WHERE p.id IN (v_invitation.created_by, p_invitee_id)
    ORDER BY p.id
    FOR UPDATE
  LOOP
    IF v_profile.id = v_invitation.created_by THEN
      v_inviter_id := v_profile.id;
      v_inviter_email := v_profile.email;
    ELSIF v_profile.id = p_invitee_id THEN
      v_invitee_profile_found := TRUE;
    END IF;
  END LOOP;

  IF v_inviter_id IS NULL THEN
    RAISE EXCEPTION 'inviter profile not found: %', v_invitation.created_by;
  END IF;

  IF NOT v_invitee_profile_found THEN
    RAISE EXCEPTION 'invitee profile not found: %', p_invitee_id;
  END IF;

  v_inviter_idempotency_key := format(
    'invitation_claim:inviter:%s:%s:%s',
    v_invitation_code,
    v_inviter_id,
    p_invitee_id
  );
  v_invitee_idempotency_key := format(
    'invitation_claim:invitee:%s:%s',
    v_invitation_code,
    p_invitee_id
  );
  v_inviter_description := format('邀请奖励：%s 注册成功', p_invitee_email);
  v_invitee_description := format('邀请码奖励：使用 %s 完成注册', v_invitation_code);

  IF COALESCE(p_invitee_reward, 0) > 0 THEN
    SELECT *
    INTO v_invitee_ledger
    FROM atomic_apply_credit_ledger_entry(
      p_invitee_id,
      p_invitee_reward,
      'addition',
      v_invitee_description,
      v_invitee_idempotency_key
    );
    v_invitee_transaction_id := v_invitee_ledger.transaction_id;
  END IF;

  IF COALESCE(p_inviter_reward, 0) > 0 THEN
    SELECT *
    INTO v_inviter_ledger
    FROM atomic_apply_credit_ledger_entry(
      v_inviter_id,
      p_inviter_reward,
      'addition',
      v_inviter_description,
      v_inviter_idempotency_key
    );
    v_inviter_transaction_id := v_inviter_ledger.transaction_id;
  END IF;

  v_rewarded_at := CASE WHEN p_claim_status = 'rewarded' THEN NOW() ELSE NULL END;

  INSERT INTO invitation_records (
    invite_code,
    inviter_id,
    inviter_email,
    invitee_id,
    invitee_email,
    status,
    risk_level,
    block_reason,
    inviter_reward,
    invitee_reward,
    ip_address,
    user_agent,
    rewarded_at
  ) VALUES (
    v_invitation_code,
    v_inviter_id,
    v_inviter_email,
    p_invitee_id,
    p_invitee_email,
    p_claim_status,
    p_risk_level,
    p_block_reason,
    COALESCE(p_inviter_reward, 0),
    COALESCE(p_invitee_reward, 0),
    p_ip_address,
    p_user_agent,
    v_rewarded_at
  )
  RETURNING id INTO v_invitation_record_id;

  UPDATE invitations AS i
  SET
    status = 'used',
    used_by = p_invitee_id
  WHERE i.code = v_invitation_code;

  RETURN QUERY SELECT
    v_invitation_record_id,
    v_invitation_code,
    v_inviter_id,
    p_invitee_id,
    p_claim_status,
    p_risk_level,
    p_block_reason,
    COALESCE(p_inviter_reward, 0),
    COALESCE(p_invitee_reward, 0),
    v_inviter_transaction_id,
    v_invitee_transaction_id,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) IS 'Atomically claims one invitation code by locking the invitation and profiles, applying invitation reward ledger entries, inserting invitation_records, and marking the invitation used';
