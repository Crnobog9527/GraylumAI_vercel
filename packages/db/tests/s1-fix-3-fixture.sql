-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local-only S1-FIX batch 3 fixture, NOT a deployment migration or full replay.
-- Table ACLs of every public table where anon/authenticated hold any privilege, the two fully
-- revoked tables' columns and policies, and postgres' public table defaults: staging catalog
-- 2026-09-29 16:17:55 UTC. Other tables are reduced to one id column; no real rows or accounts.
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
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO anon, authenticated, service_role;

CREATE TABLE profiles(id uuid PRIMARY KEY, role text, status text);
INSERT INTO profiles VALUES
 ('00000000-0000-4000-8000-000000000001', 'user', 'active'),
 ('00000000-0000-4000-8000-000000000003', 'admin', 'active');

CREATE TYPE diagnostic_status AS ENUM ('passed', 'failed', 'warning', 'skipped', 'error');
CREATE TYPE diagnostic_category AS ENUM ('ai', 'billing', 'security', 'performance', 'data');
CREATE TABLE diagnostic_results(
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  test_id text NOT NULL,
  test_name text NOT NULL,
  category diagnostic_category NOT NULL,
  status diagnostic_status NOT NULL,
  message text,
  details jsonb DEFAULT '{}'::jsonb,
  latency_ms integer,
  run_by uuid,
  run_type text DEFAULT 'manual'::text,
  batch_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE POLICY "Admins can insert diagnostic results" ON diagnostic_results FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
CREATE POLICY "Admins can view all diagnostic results" ON diagnostic_results FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
CREATE TABLE application_logs(
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  level text NOT NULL,
  category text NOT NULL,
  message text NOT NULL,
  context jsonb,
  user_id uuid,
  request_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE POLICY "Admin can view all logs" ON application_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
CREATE POLICY "Users can view own logs" ON application_logs FOR SELECT USING (user_id = auth.uid());
CREATE TABLE subscription_credit_grants(id uuid PRIMARY KEY, user_id uuid);
CREATE POLICY admin_all_subscription_credit_grants ON subscription_credit_grants FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
CREATE POLICY users_own_subscription_credit_grants_select ON subscription_credit_grants FOR SELECT
  USING (auth.uid() = user_id);
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['ai_models', 'ai_usage_logs', 'billing_history',
    'conversation_context_snapshots', 'conversations', 'credit_packages', 'credit_transactions',
    'invitation_records', 'invitations', 'membership_plans', 'messages', 'modules',
    'payment_orders', 'prompts', 'system_settings', 'token_stats', 'user_checkins',
    'user_subscriptions'] LOOP
    EXECUTE format('CREATE TABLE %I(id uuid PRIMARY KEY)', name);
  END LOOP;
END $$;
DO $$
DECLARE
  rel record;
BEGIN
  FOR rel IN SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rel.relname);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated, service_role', rel.relname);
  END LOOP;
END $$;
CREATE POLICY profiles_select_own ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
-- A table the migration must leave untouched (no client grant on staging).
CREATE TABLE opc_accounts(id uuid PRIMARY KEY);
ALTER TABLE opc_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_accounts FROM anon, authenticated, service_role;

GRANT MAINTAIN ON ai_models TO anon;
GRANT MAINTAIN ON ai_models TO authenticated;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON ai_models TO service_role;
GRANT MAINTAIN ON ai_usage_logs TO anon;
GRANT MAINTAIN ON ai_usage_logs TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON ai_usage_logs TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON application_logs TO anon;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON application_logs TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON application_logs TO service_role;
GRANT MAINTAIN ON billing_history TO anon;
GRANT MAINTAIN ON billing_history TO authenticated;
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON billing_history TO service_role;
GRANT MAINTAIN ON conversation_context_snapshots TO anon;
GRANT MAINTAIN ON conversation_context_snapshots TO authenticated;
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON conversation_context_snapshots TO service_role;
GRANT MAINTAIN ON conversations TO anon;
GRANT INSERT, MAINTAIN, SELECT, UPDATE ON conversations TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON conversations TO service_role;
GRANT MAINTAIN, SELECT ON credit_packages TO anon;
GRANT MAINTAIN, SELECT ON credit_packages TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON credit_packages TO service_role;
GRANT MAINTAIN ON credit_transactions TO anon;
GRANT MAINTAIN, SELECT ON credit_transactions TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON diagnostic_results TO anon;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON diagnostic_results TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON diagnostic_results TO service_role;
GRANT MAINTAIN ON invitation_records TO anon;
GRANT MAINTAIN ON invitation_records TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON invitation_records TO service_role;
GRANT MAINTAIN ON invitations TO anon;
GRANT MAINTAIN ON invitations TO authenticated;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON invitations TO service_role;
GRANT MAINTAIN, SELECT ON membership_plans TO anon;
GRANT MAINTAIN, SELECT ON membership_plans TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON membership_plans TO service_role;
GRANT MAINTAIN ON messages TO anon;
GRANT MAINTAIN, SELECT ON messages TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON messages TO service_role;
GRANT MAINTAIN ON modules TO anon;
GRANT MAINTAIN ON modules TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON modules TO service_role;
GRANT MAINTAIN ON payment_orders TO anon;
GRANT MAINTAIN, SELECT ON payment_orders TO authenticated;
GRANT INSERT, MAINTAIN, SELECT, UPDATE ON payment_orders TO service_role;
GRANT SELECT ON profiles TO authenticated;
GRANT DELETE ON profiles TO service_role;
GRANT MAINTAIN ON prompts TO anon;
GRANT MAINTAIN ON prompts TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON prompts TO service_role;
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON subscription_credit_grants TO anon;
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON subscription_credit_grants TO authenticated;
GRANT MAINTAIN, SELECT ON system_settings TO anon;
GRANT MAINTAIN, SELECT ON system_settings TO authenticated;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON system_settings TO service_role;
GRANT MAINTAIN ON token_stats TO anon;
GRANT MAINTAIN, SELECT ON token_stats TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE ON token_stats TO service_role;
GRANT MAINTAIN ON user_checkins TO anon;
GRANT MAINTAIN, SELECT ON user_checkins TO authenticated;
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON user_checkins TO service_role;
GRANT MAINTAIN ON user_subscriptions TO anon;
GRANT MAINTAIN, SELECT ON user_subscriptions TO authenticated;
GRANT INSERT, MAINTAIN, SELECT, UPDATE ON user_subscriptions TO service_role;
-- Representative staging column grants that the migration must keep.
GRANT SELECT (id) ON modules TO anon, authenticated;
GRANT SELECT (id) ON ai_models TO authenticated;

INSERT INTO diagnostic_results (test_id, test_name, category, status, message, created_at) VALUES
 ('ai_routing', 'AI routing', 'ai', 'passed', 'synthetic', now() - interval '1 hour'),
 ('ai_routing', 'AI routing', 'ai', 'failed', 'synthetic old', now() - interval '40 days');
INSERT INTO application_logs (level, category, message) VALUES ('warn', 'system', 'synthetic');
INSERT INTO subscription_credit_grants VALUES ('00000000-0000-4000-8000-0000000000a1', NULL);
