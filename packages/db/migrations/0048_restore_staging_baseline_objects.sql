-- Migration: 0048_restore_staging_baseline_objects
-- Purpose: restore the repository-defined STG-FIX staging baseline objects.
-- Scope: claim_daily_checkin, application_logs, diagnostic_results, and their
-- directly corresponding repository-defined RLS, policies, and grants.
-- This migration is intentionally expand-only. It does not inspect or rewrite
-- production, and it does not drop existing objects or policies.

-- ---------------------------------------------------------------------------
-- diagnostic_results dependencies and table
-- Source of truth: packages/db/migrations/0005_diagnostics.sql
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE TYPE public.diagnostic_status AS ENUM (
    'passed', 'failed', 'warning', 'skipped', 'error'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE public.diagnostic_category AS ENUM (
    'ai', 'billing', 'security', 'performance', 'data'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS public.diagnostic_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id text NOT NULL,
  test_name text NOT NULL,
  category public.diagnostic_category NOT NULL,
  status public.diagnostic_status NOT NULL,
  message text,
  details jsonb DEFAULT '{}',
  latency_ms integer,
  run_by uuid REFERENCES public.profiles(id),
  run_type text DEFAULT 'manual' CHECK (run_type IN ('manual', 'cron', 'ci')),
  batch_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_results_batch_id
  ON public.diagnostic_results(batch_id);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_test_id
  ON public.diagnostic_results(test_id);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_category
  ON public.diagnostic_results(category);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_status
  ON public.diagnostic_results(status);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_created_at
  ON public.diagnostic_results(created_at DESC);

ALTER TABLE public.diagnostic_results ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'diagnostic_results'
      AND policyname = 'Admins can view all diagnostic results'
  ) THEN
    EXECUTE 'CREATE POLICY "Admins can view all diagnostic results" ON public.diagnostic_results
      FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = ''admin''
      ))';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'diagnostic_results'
      AND policyname = 'Admins can insert diagnostic results'
  ) THEN
    EXECUTE 'CREATE POLICY "Admins can insert diagnostic results" ON public.diagnostic_results
      FOR INSERT
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = ''admin''
      ))';
  END IF;
END
$$;

GRANT SELECT, INSERT ON TABLE public.diagnostic_results TO authenticated;

COMMENT ON TABLE public.diagnostic_results IS 'Stores results of system diagnostic tests';
COMMENT ON COLUMN public.diagnostic_results.test_id
  IS 'Unique identifier for the test type (e.g., ai_routing, billing_prededuct)';
COMMENT ON COLUMN public.diagnostic_results.batch_id
  IS 'Groups results from the same diagnostic run';
COMMENT ON COLUMN public.diagnostic_results.run_type
  IS 'How the test was triggered: manual, cron, or ci';

-- ---------------------------------------------------------------------------
-- application_logs table
-- Source of truth: packages/db/migrations/0006_application_logs.sql and
-- the service-policy removal in packages/db/migrations/0015_security_advisor_hardening.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.application_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  category text NOT NULL CHECK (
    category IN ('auth', 'billing', 'ai', 'database', 'security', 'system', 'api')
  ),
  message text NOT NULL,
  context jsonb DEFAULT '{}',
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  request_id text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_application_logs_user_id
  ON public.application_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_application_logs_created_at
  ON public.application_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_logs_category
  ON public.application_logs(category);
CREATE INDEX IF NOT EXISTS idx_application_logs_level
  ON public.application_logs(level);
CREATE INDEX IF NOT EXISTS idx_application_logs_request_id
  ON public.application_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_application_logs_user_created
  ON public.application_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_logs_level_created
  ON public.application_logs(level, created_at DESC);

ALTER TABLE public.application_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'application_logs'
      AND policyname = 'Admin can view all logs'
  ) THEN
    EXECUTE 'CREATE POLICY "Admin can view all logs" ON public.application_logs
      FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = auth.uid() AND profiles.role = ''admin''
      ))';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'application_logs'
      AND policyname = 'Users can view own logs'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own logs" ON public.application_logs
      FOR SELECT
      USING (user_id = auth.uid())';
  END IF;
END
$$;

GRANT SELECT ON TABLE public.application_logs TO authenticated;

COMMENT ON TABLE public.application_logs IS '应用日志表 - 存储关键业务日志，用于问题排查和审计';

-- ---------------------------------------------------------------------------
-- claim_daily_checkin function
-- Source of truth: packages/db/migrations/0027_balance_write_surface_lockdown.sql
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_daily_checkin(p_user_id uuid)
RETURNS TABLE (
  already_claimed boolean,
  checkin_date text,
  streak_day integer,
  reward_credits integer,
  monthly_bonus_credits integer,
  total_reward_credits integer,
  monthly_checkin_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today date := timezone('Asia/Shanghai', now())::date;
  v_month_key text := to_char(v_today, 'YYYY-MM');
  v_existing public.user_checkins%ROWTYPE;
  v_previous public.user_checkins%ROWTYPE;
  v_streak_day integer;
  v_reward_credits integer;
  v_monthly_bonus_credits integer;
  v_total_reward_credits integer;
  v_monthly_count_before integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'claim_daily_checkin user mismatch';
  END IF;

  SELECT * INTO v_existing
  FROM public.user_checkins AS uc
  WHERE uc.user_id = p_user_id
    AND uc.checkin_date = v_today;

  IF FOUND THEN
    SELECT COUNT(*) INTO v_monthly_count_before
    FROM public.user_checkins AS uc
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
  FROM public.user_checkins AS uc
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
    'checkin_day' || v_streak_day::text,
    CASE v_streak_day
      WHEN 1 THEN 5
      WHEN 2 THEN 10
      WHEN 3 THEN 15
      WHEN 4 THEN 20
      ELSE 25
    END
  );

  SELECT COUNT(*) INTO v_monthly_count_before
  FROM public.user_checkins AS uc
  WHERE uc.user_id = p_user_id
    AND uc.month_key = v_month_key;

  v_monthly_bonus_credits := CASE
    WHEN v_monthly_count_before = 29 THEN get_system_setting_int('checkin_monthly_bonus', 50)
    ELSE 0
  END;

  v_total_reward_credits := v_reward_credits + v_monthly_bonus_credits;

  INSERT INTO public.user_checkins (
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

  UPDATE public.profiles
  SET credits = COALESCE(credits, 0) + v_total_reward_credits
  WHERE id = p_user_id;

  INSERT INTO public.credit_transactions (
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

REVOKE ALL ON FUNCTION public.claim_daily_checkin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_daily_checkin(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_daily_checkin(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_checkin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_checkin(uuid) TO service_role;

COMMENT ON FUNCTION public.claim_daily_checkin(uuid)
  IS 'Atomically executes one daily checkin for the authenticated user; direct authenticated calls must match auth.uid() and p_user_id';
