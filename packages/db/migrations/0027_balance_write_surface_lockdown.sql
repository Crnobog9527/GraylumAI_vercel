-- Migration: balance write-surface lockdown
-- Description: Restricts direct profile credit writes and balance-mutating RPC execution.

-- Keep the existing own-row profile RLS policy, but remove broad table-level
-- UPDATE from client roles. Grant back only the profile fields users edit,
-- and allow the existing user bootstrap to insert an own profile with zero credits.
REVOKE INSERT ON TABLE public.profiles FROM PUBLIC;
REVOKE INSERT ON TABLE public.profiles FROM anon;
REVOKE INSERT ON TABLE public.profiles FROM authenticated;
REVOKE UPDATE ON TABLE public.profiles FROM PUBLIC;
REVOKE UPDATE ON TABLE public.profiles FROM anon;
REVOKE UPDATE ON TABLE public.profiles FROM authenticated;
REVOKE UPDATE (credits) ON TABLE public.profiles FROM PUBLIC;
REVOKE UPDATE (credits) ON TABLE public.profiles FROM anon;
REVOKE UPDATE (credits) ON TABLE public.profiles FROM authenticated;
GRANT INSERT (id, email, nickname, avatar_url, role, credits) ON TABLE public.profiles TO authenticated;
GRANT UPDATE (email, nickname, avatar_url) ON TABLE public.profiles TO authenticated;

DROP POLICY IF EXISTS "profiles_insert_own_zero_credits" ON public.profiles;
CREATE POLICY "profiles_insert_own_zero_credits"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = id
    AND credits = 0
    AND role = 'user'
  );

CREATE OR REPLACE FUNCTION public.prevent_client_profile_credit_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF COALESCE(NEW.credits, 0) <> 0 THEN
        RAISE EXCEPTION 'client profile bootstrap cannot insert non-zero credits'
          USING ERRCODE = '42501';
      END IF;

      IF COALESCE(NEW.role, 'user') <> 'user' THEN
        RAISE EXCEPTION 'client profile bootstrap cannot insert privileged role'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.credits IS DISTINCT FROM OLD.credits THEN
      RAISE EXCEPTION 'client role cannot update profile credits'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_client_profile_credit_write ON public.profiles;
CREATE TRIGGER trg_prevent_client_profile_credit_write
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_client_profile_credit_write();

-- Ledger/accounting tables remain readable through existing RLS policies, but
-- client roles must not write synthetic balance, usage, payment, or subscription rows.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM authenticated;
DROP POLICY IF EXISTS "credit_transactions_insert_service" ON public.credit_transactions;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.billing_history FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.billing_history FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.billing_history FROM authenticated;
DROP POLICY IF EXISTS "users_own_billing_history_insert" ON public.billing_history;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.token_stats FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.token_stats FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.token_stats FROM authenticated;
DROP POLICY IF EXISTS "users_own_token_stats_insert" ON public.token_stats;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM authenticated;

-- Service-only ledger and fulfillment RPCs.
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_claim_invitation_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.atomic_apply_invitation_rebate(UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_invitation_rebate(UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_invitation_rebate(UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_apply_invitation_rebate(UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_credit_package(TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-- checkin is intentionally user-callable from the protected tRPC route. Keep it
-- available to authenticated users, but enforce the caller/user match in the DB.
CREATE OR REPLACE FUNCTION public.claim_daily_checkin(p_user_id UUID)
RETURNS TABLE (
  already_claimed BOOLEAN,
  checkin_date TEXT,
  streak_day INTEGER,
  reward_credits INTEGER,
  monthly_bonus_credits INTEGER,
  total_reward_credits INTEGER,
  monthly_checkin_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today DATE := timezone('Asia/Shanghai', now())::date;
  v_month_key TEXT := to_char(v_today, 'YYYY-MM');
  v_existing user_checkins%ROWTYPE;
  v_previous user_checkins%ROWTYPE;
  v_streak_day INTEGER;
  v_reward_credits INTEGER;
  v_monthly_bonus_credits INTEGER;
  v_total_reward_credits INTEGER;
  v_monthly_count_before INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'claim_daily_checkin user mismatch';
  END IF;

  SELECT * INTO v_existing
  FROM user_checkins AS uc
  WHERE uc.user_id = p_user_id
    AND uc.checkin_date = v_today;

  IF FOUND THEN
    SELECT COUNT(*) INTO v_monthly_count_before
    FROM user_checkins AS uc
    WHERE uc.user_id = p_user_id
      AND uc.month_key = v_month_key;

    RETURN QUERY
    SELECT
      TRUE,
      to_char(v_today, 'YYYY-MM-DD'),
      v_existing.streak_day,
      v_existing.reward_credits,
      v_existing.monthly_bonus_credits,
      v_existing.reward_credits + v_existing.monthly_bonus_credits,
      v_monthly_count_before;
    RETURN;
  END IF;

  SELECT * INTO v_previous
  FROM user_checkins AS uc
  WHERE uc.user_id = p_user_id
    AND uc.checkin_date = (v_today - 1);

  IF FOUND THEN
    v_streak_day := CASE
      WHEN v_previous.streak_day >= 5 THEN 1
      ELSE v_previous.streak_day + 1
    END;
  ELSE
    v_streak_day := 1;
  END IF;

  v_reward_credits := get_system_setting_int(
    'checkin_day' || v_streak_day::TEXT,
    CASE v_streak_day
      WHEN 1 THEN 5
      WHEN 2 THEN 10
      WHEN 3 THEN 15
      WHEN 4 THEN 20
      ELSE 25
    END
  );

  SELECT COUNT(*) INTO v_monthly_count_before
  FROM user_checkins AS uc
  WHERE uc.user_id = p_user_id
    AND uc.month_key = v_month_key;

  v_monthly_bonus_credits := CASE
    WHEN v_monthly_count_before = 29 THEN get_system_setting_int('checkin_monthly_bonus', 50)
    ELSE 0
  END;

  v_total_reward_credits := v_reward_credits + v_monthly_bonus_credits;

  INSERT INTO user_checkins (
    user_id,
    checkin_date,
    month_key,
    streak_day,
    reward_credits,
    monthly_bonus_credits
  ) VALUES (
    p_user_id,
    v_today,
    v_month_key,
    v_streak_day,
    v_reward_credits,
    v_monthly_bonus_credits
  );

  UPDATE profiles
  SET credits = COALESCE(credits, 0) + v_total_reward_credits
  WHERE id = p_user_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description
  ) VALUES (
    p_user_id,
    v_total_reward_credits,
    'checkin',
    CASE
      WHEN v_monthly_bonus_credits > 0 THEN format('每日签到奖励（第%s天）+ 月度全勤奖', v_streak_day)
      ELSE format('每日签到奖励（第%s天）', v_streak_day)
    END
  );

  RETURN QUERY
  SELECT
    FALSE,
    to_char(v_today, 'YYYY-MM-DD'),
    v_streak_day,
    v_reward_credits,
    v_monthly_bonus_credits,
    v_total_reward_credits,
    v_monthly_count_before + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_daily_checkin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_daily_checkin(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_daily_checkin(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_checkin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_checkin(UUID) TO service_role;

COMMENT ON FUNCTION public.claim_daily_checkin(UUID)
  IS 'Atomically executes one daily checkin for the authenticated user; direct authenticated calls must match auth.uid() and p_user_id';
