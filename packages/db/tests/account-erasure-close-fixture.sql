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

-- Test seeding only (the integration test has no SQL access).
GRANT SELECT, INSERT, UPDATE ON user_subscriptions, payment_orders, fixture_notes TO service_role;

-- Worst-case Supabase-style defaults: tables/functions the migration creates would be granted to every client role.
-- The migration must still end with only the explicit grants it writes.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
