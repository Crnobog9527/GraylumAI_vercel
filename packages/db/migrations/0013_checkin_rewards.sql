-- Migration: Daily check-in persistence and reward claiming
-- Description: Adds user_checkins ledger plus an atomic reward claim function.

CREATE TABLE IF NOT EXISTS user_checkins (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  month_key TEXT NOT NULL,
  streak_day INTEGER NOT NULL CHECK (streak_day BETWEEN 1 AND 5),
  reward_credits INTEGER NOT NULL DEFAULT 0,
  monthly_bonus_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_user_checkins_user_month ON user_checkins(user_id, month_key);
CREATE INDEX IF NOT EXISTS idx_user_checkins_created_at ON user_checkins(created_at DESC);

ALTER TABLE user_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_user_checkins_select" ON user_checkins;
CREATE POLICY "users_own_user_checkins_select"
  ON user_checkins
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_own_user_checkins_insert" ON user_checkins;
CREATE POLICY "users_own_user_checkins_insert"
  ON user_checkins
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_all_user_checkins" ON user_checkins;
CREATE POLICY "admin_all_user_checkins"
  ON user_checkins
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE OR REPLACE FUNCTION get_system_setting_int(p_key TEXT, p_default INTEGER)
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
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION claim_daily_checkin(p_user_id UUID)
RETURNS TABLE (
  already_claimed BOOLEAN,
  checkin_date TEXT,
  streak_day INTEGER,
  reward_credits INTEGER,
  monthly_bonus_credits INTEGER,
  total_reward_credits INTEGER,
  monthly_checkin_count INTEGER
) AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE user_checkins IS '用户每日签到流水，按北京时间记录每日唯一签到和奖励';
COMMENT ON FUNCTION claim_daily_checkin(UUID) IS '原子化执行每日签到、积分发放和交易流水写入';
