-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Disposable DATA-ERASURE PR-A fixture. profiles follows the staging catalog shape and ACLs recorded
-- in s1-fix-1-fixture.sql plus 0144; the other tables keep only the columns the migration reads.
-- Seeds no real account, provider or money state.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
CREATE ROLE erasure_auth LOGIN SUPERUSER;
ALTER ROLE erasure_auth SET search_path = auth, public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

CREATE TABLE profiles(
  id uuid NOT NULL PRIMARY KEY,
  email text,
  nickname text,
  avatar_url text,
  role text DEFAULT 'user'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  membership_level text DEFAULT 'free'::text NOT NULL,
  credits integer DEFAULT 0 NOT NULL,
  is_deleted text DEFAULT 'false'::text NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON profiles TO authenticated;
GRANT UPDATE (nickname) ON profiles TO authenticated;
GRANT DELETE ON profiles TO service_role;
GRANT INSERT (id, email, nickname, role, status, membership_level, credits),
  SELECT (id, email, nickname, role, status, membership_level, credits, is_deleted, created_at, avatar_url),
  UPDATE (membership_level, email, role, status) ON profiles TO service_role;
CREATE POLICY profiles_select_own ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY profiles_update_own ON profiles FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()) AND is_deleted = 'false')
  WITH CHECK (id = (SELECT auth.uid()) AND is_deleted = 'false');

CREATE TABLE user_subscriptions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  status text NOT NULL,
  cancel_at_period_end text NOT NULL DEFAULT 'false',
  current_period_end timestamptz
);
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON user_subscriptions TO authenticated;
CREATE POLICY users_own_subscriptions_select ON user_subscriptions FOR SELECT USING (auth.uid() = user_id);

CREATE TABLE payment_orders(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status text NOT NULL
);
ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON payment_orders TO authenticated;
CREATE POLICY users_own_payment_orders_select ON payment_orders FOR SELECT USING (auth.uid() = user_id);

-- BILL2 tables have no client or service_role grants (0105).
CREATE TABLE bill2_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES profiles(id),
  state text NOT NULL DEFAULT 'prepared'
);
ALTER TABLE bill2_runs ENABLE ROW LEVEL SECURITY;

-- A client-readable private table like conversations/messages, with a column-level grant variant.
CREATE TABLE fixture_notes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id),
  body text NOT NULL
);
ALTER TABLE fixture_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON fixture_notes TO authenticated;
CREATE POLICY fixture_notes_own ON fixture_notes FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TABLE fixture_column_notes(id uuid PRIMARY KEY, user_id uuid NOT NULL, body text);
ALTER TABLE fixture_column_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT (id, body) ON fixture_column_notes TO authenticated;
CREATE POLICY fixture_column_notes_own ON fixture_column_notes FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Client-executable SECURITY DEFINER RPCs as they exist on staging (2026-09-30 read-only extract).
CREATE TABLE user_checkins(
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  checkin_date date NOT NULL,
  month_key text NOT NULL,
  streak_day integer NOT NULL CHECK (streak_day BETWEEN 1 AND 5),
  reward_credits integer NOT NULL DEFAULT 0,
  monthly_bonus_credits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, checkin_date)
);
ALTER TABLE user_checkins ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON user_checkins TO authenticated;
CREATE POLICY users_own_user_checkins_select ON user_checkins FOR SELECT USING (auth.uid() = user_id);
CREATE TABLE credit_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  amount integer NOT NULL,
  type text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
-- Fixture stub: staging reads system_settings; defaults are enough for these tests.
CREATE FUNCTION get_system_setting_int(p_key text, p_default integer) RETURNS integer
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$ SELECT p_default $$;
CREATE TABLE conversations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  is_deleted text NOT NULL DEFAULT 'false',
  deleted_at timestamptz
);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE TABLE messages(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  is_deleted text NOT NULL DEFAULT 'false',
  deleted_at timestamptz
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
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
REVOKE ALL ON FUNCTION public.claim_daily_checkin(uuid), public.soft_delete_conversation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_daily_checkin(uuid), public.soft_delete_conversation(uuid, uuid)
  TO authenticated, service_role;

-- Test seeding only (the integration test has no SQL access).
GRANT SELECT, INSERT, UPDATE ON user_subscriptions, payment_orders, fixture_notes, conversations TO service_role;
GRANT SELECT ON user_checkins, credit_transactions, messages TO service_role;

-- Worst-case Supabase-style defaults: tables/functions the migration creates would be granted to every client role.
-- The migration must still end with only the explicit grants it writes.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
