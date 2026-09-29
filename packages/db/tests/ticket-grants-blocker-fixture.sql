-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local-only B02 fixture, NOT a deployment migration or full replay.
-- Ticket columns/defaults, ACLs and policies: staging catalog 2026-09-29 08:32:02 UTC.
-- profiles/auth are minimal test helpers; no real accounts, tickets or attachments.
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
GRANT SELECT (id,role,status) ON profiles TO authenticated;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_profile_own ON profiles FOR SELECT TO authenticated USING (id=auth.uid());
INSERT INTO profiles VALUES
 ('00000000-0000-4000-8000-000000000001','user','active'),
 ('00000000-0000-4000-8000-000000000002','user','active'),
 ('00000000-0000-4000-8000-000000000003','admin','active');
CREATE TABLE tickets(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  category text DEFAULT 'other'::text NOT NULL,
  priority text DEFAULT 'medium'::text NOT NULL,
  attachments jsonb DEFAULT '[]'::jsonb,
  status text DEFAULT 'open'::text NOT NULL,
  is_deleted text DEFAULT 'false'::text NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
GRANT MAINTAIN ON tickets TO anon;
GRANT MAINTAIN ON tickets TO authenticated;
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON tickets TO service_role;
CREATE TABLE ticket_replies(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  content text NOT NULL,
  is_admin text DEFAULT 'false'::text NOT NULL,
  attachments jsonb DEFAULT '[]'::jsonb,
  is_deleted text DEFAULT 'false'::text NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ticket_replies ENABLE ROW LEVEL SECURITY;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ticket_replies TO anon;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ticket_replies TO authenticated;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ticket_replies TO service_role;
CREATE POLICY tickets_select_admin ON tickets FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text))))
;
CREATE POLICY ticket_replies_insert_own ON ticket_replies FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_replies.ticket_id) AND (t.user_id = auth.uid()))))
;
CREATE POLICY ticket_replies_select_admin ON ticket_replies FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text))))
;
INSERT INTO tickets (id,user_id,title) VALUES
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','fixture'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','fixture');
INSERT INTO ticket_replies (id,ticket_id,user_id,content) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001','fixture'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000002','fixture');
