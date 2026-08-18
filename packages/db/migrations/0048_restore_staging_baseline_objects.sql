-- Migration: 0048_restore_staging_baseline_objects
-- Purpose: restore the repository-defined STG-FIX staging baseline objects.
-- Scope: claim_daily_checkin, application_logs, diagnostic_results, and their
-- directly corresponding repository-defined RLS and policies.
-- This migration is intentionally expand-only. It does not inspect or rewrite
-- production, and it does not drop existing objects or policies.
--
-- IMPORTANT: IF NOT EXISTS / CREATE OR REPLACE are restoration mechanisms, not
-- parity proof. Before any separately authorized staging application, the
-- complete live fingerprints defined in STG-FIX-STRUCTURE-COMPARISON.md must be
-- captured. If an object already exists and any required fingerprint differs,
-- the apply must BLOCK/STOP rather than treating name existence as success.

-- ---------------------------------------------------------------------------
-- C2 direct dependency normalization
-- Source of truth: packages/db/migrations/0013_checkin_rewards.sql and
-- packages/db/migrations/0015_security_advisor_hardening.sql
-- ---------------------------------------------------------------------------

-- The current staging dependency drift is a known disposable-test shape:
-- checkin_date is TEXT, the streak-day check is absent, the primary-key index
-- is user_checkins_user_id_checkin_date_pk, and the only policy is the observed
-- user_checkins_select_own policy. Only that exact shape may discard rows while
-- changing the column type. Any other TEXT shape fails closed.
CREATE TABLE IF NOT EXISTS public.user_checkins (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  month_key TEXT NOT NULL,
  streak_day INTEGER NOT NULL CHECK (streak_day BETWEEN 1 AND 5),
  reward_credits INTEGER NOT NULL DEFAULT 0,
  monthly_bonus_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, checkin_date)
);

DO $$
DECLARE
  v_checkin_date_type TEXT;
  v_column_count INTEGER;
  v_total_column_count INTEGER;
  v_pk_index_count INTEGER;
  v_total_index_count INTEGER;
  v_check_count INTEGER;
  v_policy_count INTEGER;
BEGIN
  SELECT c.data_type
  INTO v_checkin_date_type
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'user_checkins'
    AND c.column_name = 'checkin_date';

  IF v_checkin_date_type = 'text' THEN
    SELECT COUNT(*)
    INTO v_column_count
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'user_checkins'
      AND (
        (c.column_name = 'user_id' AND c.data_type = 'uuid')
        OR (c.column_name = 'checkin_date' AND c.data_type = 'text')
        OR (c.column_name = 'month_key' AND c.data_type = 'text')
        OR (c.column_name = 'streak_day' AND c.data_type = 'integer')
        OR (c.column_name = 'reward_credits' AND c.data_type = 'integer')
        OR (c.column_name = 'monthly_bonus_credits' AND c.data_type = 'integer')
        OR (c.column_name = 'created_at' AND c.data_type = 'timestamp with time zone')
      );

    SELECT COUNT(*)
    INTO v_total_column_count
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'user_checkins';

    SELECT COUNT(*)
    INTO v_pk_index_count
    FROM pg_index AS i
    JOIN pg_class AS index_rel ON index_rel.oid = i.indexrelid
    JOIN pg_class AS table_rel ON table_rel.oid = i.indrelid
    JOIN pg_namespace AS table_ns ON table_ns.oid = table_rel.relnamespace
    WHERE table_ns.nspname = 'public'
      AND table_rel.relname = 'user_checkins'
      AND index_rel.relname = 'user_checkins_user_id_checkin_date_pk'
      AND i.indisprimary;

    SELECT COUNT(*)
    INTO v_total_index_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_checkins';

    SELECT COUNT(*)
    INTO v_check_count
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.user_checkins'::regclass
      AND con.contype = 'c';

    SELECT COUNT(*)
    INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_checkins'
      AND policyname = 'user_checkins_select_own';

    IF v_column_count <> 7
       OR v_total_column_count <> 7
       OR v_pk_index_count <> 1
       OR v_total_index_count <> 1
       OR v_check_count <> 0
       OR v_policy_count <> 1
       OR (SELECT COUNT(*) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'user_checkins') <> 1 THEN
      RAISE EXCEPTION
        'C2 refuses to normalize unknown public.user_checkins TEXT drift shape';
    END IF;

    TRUNCATE TABLE public.user_checkins;
    ALTER TABLE public.user_checkins
      ALTER COLUMN checkin_date TYPE DATE USING checkin_date::DATE;
  ELSIF v_checkin_date_type IS DISTINCT FROM 'date' THEN
    RAISE EXCEPTION
      'C2 refuses public.user_checkins with unsupported checkin_date type: %',
      v_checkin_date_type;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.user_checkins'::regclass
      AND conname = 'user_checkins_streak_day_check'
  ) THEN
    ALTER TABLE public.user_checkins
      ADD CONSTRAINT user_checkins_streak_day_check
      CHECK (streak_day BETWEEN 1 AND 5);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_user_checkins_user_month
  ON public.user_checkins(user_id, month_key);
CREATE INDEX IF NOT EXISTS idx_user_checkins_created_at
  ON public.user_checkins(created_at DESC);

ALTER TABLE public.user_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_checkins_select_own" ON public.user_checkins;
DROP POLICY IF EXISTS "users_own_user_checkins_select" ON public.user_checkins;
DROP POLICY IF EXISTS "users_own_user_checkins_insert" ON public.user_checkins;
DROP POLICY IF EXISTS "admin_all_user_checkins" ON public.user_checkins;

CREATE POLICY "users_own_user_checkins_select"
  ON public.user_checkins
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_own_user_checkins_insert"
  ON public.user_checkins
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin_all_user_checkins"
  ON public.user_checkins
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

COMMENT ON TABLE public.user_checkins IS '用户每日签到流水，按北京时间记录每日唯一签到和奖励';

CREATE OR REPLACE FUNCTION public.get_system_setting_int(
  p_key TEXT,
  p_default INTEGER
)
RETURNS INTEGER AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT value #>> '{}' INTO v_raw
  FROM system_settings
  WHERE key = p_key;

  IF v_raw IS NULL OR v_raw = '' OR v_raw !~ '^-?[0-9]+$' THEN
    RETURN p_default;
  END IF;

  RETURN v_raw::INTEGER;
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- diagnostic_results dependencies and table
-- Source of truth: packages/db/migrations/0005_diagnostics.sql plus the
-- service-policy removal in packages/db/migrations/0015_security_advisor_hardening.sql
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

-- Deliberately no table GRANT/REVOKE here. The current repository migrations
-- establish RLS/policy intent for diagnostic_results but do not deterministically
-- bind the exact hosted table ACL/default-privilege result. Inventing one here
-- would violate the fail-closed parity requirement. A separately authorized
-- live grant fingerprint must establish the expected ACL before any apply.

COMMENT ON TABLE public.diagnostic_results IS 'Stores results of system diagnostic tests';
COMMENT ON COLUMN public.diagnostic_results.test_id
  IS 'Unique identifier for the test type (e.g., ai_routing, billing_prededuct)';
COMMENT ON COLUMN public.diagnostic_results.batch_id
  IS 'Groups results from the same diagnostic run';
COMMENT ON COLUMN public.diagnostic_results.run_type
  IS 'How the test was triggered: manual, cron, or ci';

-- ---------------------------------------------------------------------------
-- application_logs table
-- Source of truth: packages/db/migrations/0006_application_logs.sql,
-- packages/db/migrations/0007_performance_indexes.sql, and the service-policy
-- removal in packages/db/migrations/0015_security_advisor_hardening.sql
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
CREATE INDEX IF NOT EXISTS idx_application_logs_context
  ON public.application_logs(context);
CREATE INDEX IF NOT EXISTS idx_application_logs_created
  ON public.application_logs(created_at DESC);

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

-- Deliberately no table GRANT/REVOKE here for the same reason as
-- diagnostic_results: repository SQL does not bind the exact hosted table ACL
-- or default-privilege outcome. Later grant fingerprint parity is mandatory.

COMMENT ON TABLE public.application_logs IS '应用日志表 - 存储关键业务日志，用于问题排查和审计';

-- ---------------------------------------------------------------------------
-- claim_daily_checkin function
-- Source of truth: packages/db/migrations/0027_balance_write_surface_lockdown.sql
-- ---------------------------------------------------------------------------

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
