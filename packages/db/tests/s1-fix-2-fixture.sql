-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local-only S1-FIX batch 2 fixture, NOT a deployment migration or full replay.
-- scheduled_job_runs columns, defaults, ACL and policy: staging catalog 2026-09-29 15:01:51 UTC.
-- profiles is a minimal helper for the admin policy; no real accounts or job rows.
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
CREATE TABLE profiles(id uuid PRIMARY KEY, role text, status text);
GRANT SELECT (id, role, status) ON profiles TO authenticated;
INSERT INTO profiles VALUES
 ('00000000-0000-4000-8000-000000000001', 'user', 'active'),
 ('00000000-0000-4000-8000-000000000003', 'admin', 'active');

CREATE TABLE scheduled_job_runs(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  job_key text NOT NULL,
  trigger_source text DEFAULT 'cron'::text NOT NULL,
  status text DEFAULT 'running'::text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  summary jsonb DEFAULT '{}'::jsonb NOT NULL,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE scheduled_job_runs ENABLE ROW LEVEL SECURITY;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON scheduled_job_runs TO anon, authenticated;
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON scheduled_job_runs TO service_role;
CREATE POLICY scheduled_job_runs_admin_all ON scheduled_job_runs FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles p
    WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM profiles p
    WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text)))));
INSERT INTO scheduled_job_runs (job_key, status, finished_at) VALUES ('ticket_auto_close', 'success', now());
