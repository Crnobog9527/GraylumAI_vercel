-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-A rollback. Refuses once any account was closed: rolling back would let a closed
-- profile (status='deleted') be treated as usable by older code. Separately authorize remote use.
BEGIN;
DO $$
DECLARE
  rel record;
BEGIN
  IF to_regclass('public.account_erasure_requests') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.account_erasure_requests) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ROLLBACK_REFUSED: closed accounts exist';
  END IF;
  FOR rel IN
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'account_open_required'
  LOOP
    EXECUTE format('DROP POLICY account_open_required ON public.%I', rel.tablename);
  END LOOP;
END $$;
-- Restore the staging definitions read 2026-09-30 (without the closed-account check).
CREATE OR REPLACE FUNCTION public.claim_daily_checkin(p_user_id uuid)
 RETURNS TABLE(already_claimed boolean, checkin_date text, streak_day integer, reward_credits integer, monthly_bonus_credits integer, total_reward_credits integer, monthly_checkin_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.soft_delete_conversation(p_conversation_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

DROP TRIGGER IF EXISTS account_erasure_profile_guard ON public.profiles;
DROP FUNCTION IF EXISTS public.account_erasure_note_error(uuid, text);
DROP FUNCTION IF EXISTS public.account_erasure_confirm(uuid, uuid);
DROP FUNCTION IF EXISTS public.account_erasure_preview(uuid);
DROP FUNCTION IF EXISTS public.account_erasure_renewing(uuid);
DROP FUNCTION IF EXISTS public.account_erasure_profile_guard();
DROP FUNCTION IF EXISTS public.current_account_is_closed();
DROP TABLE IF EXISTS public.account_erasure_requests;
COMMIT;
