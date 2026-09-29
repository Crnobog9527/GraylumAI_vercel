-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local-only S1-FIX batch 1 fixture, NOT a deployment migration or full replay.
-- profiles/announcements/user_activity_logs/credit_transactions/system_settings columns, defaults,
-- ACLs and 0144-relevant policies: staging catalog 2026-09-29 13:18:38 UTC (system_settings public key
-- list abbreviated; credit/settings admin policies and the credit normalize trigger omitted).
-- conversations/messages/tickets/user_checkins are minimal router helpers. No real accounts or rows.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
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
  last_login_at timestamp with time zone,
  last_ip text,
  is_deleted text DEFAULT 'false'::text NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
GRANT MAINTAIN ON profiles TO anon;
GRANT SELECT, MAINTAIN ON profiles TO authenticated;
GRANT DELETE ON profiles TO service_role;
GRANT INSERT (id, email, nickname, role, status, membership_level, credits),
  SELECT (id, email, nickname, role, status, membership_level, credits, is_deleted, created_at),
  UPDATE (membership_level) ON profiles TO service_role;
CREATE POLICY profiles_select_own ON profiles FOR SELECT TO authenticated USING ((auth.uid() = id));
-- Staging comment (pg_description, read-only check 2026-09-29) equals 0046's text.
COMMENT ON POLICY profiles_select_own ON profiles
  IS 'Users may read their own profile; missing profile bootstrap is handled server-side by service_role grants in 0046.';

CREATE TABLE announcements(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  title text NOT NULL,
  content text NOT NULL,
  type text DEFAULT 'info'::text NOT NULL,
  announcement_type text DEFAULT 'homepage'::text NOT NULL,
  banner_style text DEFAULT 'info'::text,
  banner_link text,
  icon text DEFAULT 'Megaphone'::text,
  icon_color text DEFAULT 'text-blue-500'::text,
  tag text,
  tag_color text DEFAULT 'blue'::text,
  priority integer DEFAULT 0 NOT NULL,
  active text DEFAULT 'true'::text NOT NULL,
  is_deleted text DEFAULT 'false'::text NOT NULL,
  deleted_at timestamp with time zone,
  start_date timestamp with time zone DEFAULT now(),
  end_date timestamp with time zone,
  created_by uuid CONSTRAINT announcements_created_by_profiles_id_fk
    REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
GRANT MAINTAIN ON announcements TO anon, authenticated;
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON announcements TO service_role;
CREATE POLICY announcements_select_active_public ON announcements FOR SELECT TO anon, authenticated
  USING (((active = 'true'::text) AND (is_deleted = 'false'::text)
    AND ((start_date IS NULL) OR (start_date <= now())) AND ((end_date IS NULL) OR (end_date >= now()))));
CREATE POLICY announcements_select_admin ON announcements FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles p
    WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text)))));

CREATE TABLE user_activity_logs(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid CONSTRAINT user_activity_logs_user_id_profiles_id_fk
    REFERENCES profiles(id) ON DELETE SET NULL,
  admin_id uuid CONSTRAINT user_activity_logs_admin_id_profiles_id_fk
    REFERENCES profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  action_type text DEFAULT 'system'::text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  ip_address text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE user_activity_logs ENABLE ROW LEVEL SECURITY;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON user_activity_logs TO anon, authenticated, service_role;
CREATE POLICY user_activity_logs_select_admin ON user_activity_logs FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles p
    WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text)))));

CREATE TABLE credit_transactions(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  amount integer NOT NULL,
  type text NOT NULL,
  description text,
  idempotency_key text,
  balance_before bigint,
  balance_after bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  ledger_type text,
  reason_code text,
  counts_as_spend boolean DEFAULT false NOT NULL,
  source_type text,
  source_id text,
  source_order_id uuid,
  source_refund_id text,
  grant_period_key text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  bill2_run_id uuid
);
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
GRANT MAINTAIN ON credit_transactions TO anon;
GRANT SELECT, MAINTAIN ON credit_transactions TO authenticated;
GRANT SELECT (id, user_id, amount, type, description, idempotency_key, balance_before, balance_after,
  created_at, ledger_type, reason_code, counts_as_spend, source_type, source_order_id,
  grant_period_key, metadata) ON credit_transactions TO service_role;
GRANT UPDATE (ledger_type, reason_code, counts_as_spend, source_type, source_id, source_order_id,
  source_refund_id, grant_period_key, metadata) ON credit_transactions TO service_role;
CREATE POLICY credit_transactions_select_own ON credit_transactions FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

CREATE TABLE system_settings(key text NOT NULL PRIMARY KEY, value jsonb);
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, MAINTAIN ON system_settings TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON system_settings TO service_role;
CREATE POLICY system_settings_select_home_analysis ON system_settings FOR SELECT TO anon, authenticated
  USING ((key = 'home_analysis_module_id'::text));
CREATE POLICY system_settings_select_public_user_facing ON system_settings FOR SELECT
  TO anon, authenticated USING ((key = ANY (ARRAY['site_name'::text, 'support_email'::text])));

-- Minimal helpers for the real admin/check-in routers; not staging copies.
CREATE TABLE conversations(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid,
  is_deleted text DEFAULT 'false', created_at timestamptz DEFAULT now());
CREATE TABLE messages(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id), is_deleted text DEFAULT 'false');
CREATE TABLE tickets(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid,
  status text DEFAULT 'open', is_deleted boolean DEFAULT false);
CREATE TABLE user_checkins(user_id uuid, checkin_date text, streak_day int, reward_credits int,
  monthly_bonus_credits int, month_key text);
GRANT SELECT ON conversations, messages, tickets TO service_role;
GRANT SELECT ON user_checkins TO authenticated;
ALTER TABLE user_checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_checkins_own ON user_checkins FOR SELECT TO authenticated USING (user_id = auth.uid());

INSERT INTO profiles (id, email, nickname, role, credits, last_ip) VALUES
 ('00000000-0000-4000-8000-000000000001', 'owner@example.test', 'owner', 'user', 100, '192.0.2.1'),
 ('00000000-0000-4000-8000-000000000002', 'other@example.test', 'other', 'user', 100, '192.0.2.2'),
 ('00000000-0000-4000-8000-000000000003', 'admin@example.test', 'admin', 'admin', 100, NULL);
INSERT INTO announcements (id, title, content, announcement_type, active, start_date, end_date, priority) VALUES
 ('30000000-0000-4000-8000-000000000001', 'live', 'fixture', 'banner', 'true', now() - interval '1 day', NULL, 5),
 ('30000000-0000-4000-8000-000000000002', 'off', 'fixture', 'banner', 'false', now() - interval '1 day', NULL, 9),
 ('30000000-0000-4000-8000-000000000003', 'expired', 'fixture', 'banner', 'true', now() - interval '2 day',
  now() - interval '1 day', 9);
INSERT INTO user_activity_logs (user_id, admin_id, action, action_type) VALUES
 ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'fixture', 'system');
INSERT INTO credit_transactions (user_id, amount, type, description, source_id) VALUES
 ('00000000-0000-4000-8000-000000000001', 5, 'addition', 'fixture', 'hidden-source'),
 ('00000000-0000-4000-8000-000000000002', -3, 'deduction', 'fixture', 'hidden-source');
INSERT INTO system_settings VALUES ('checkin_day1', '7'::jsonb), ('site_name', '"fixture"'::jsonb);
