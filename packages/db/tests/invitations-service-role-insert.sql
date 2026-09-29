-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Disposable fixture of the diagnosed staging ACL, not a full migration replay.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.invitations (
  code text PRIMARY KEY,
  created_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_select_admin ON public.invitations FOR SELECT
  TO authenticated USING (false);
-- Mirror service_role=rDxtm; no INSERT, UPDATE or DELETE.
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.invitations TO service_role;
CREATE TEMP TABLE original_posture AS
  SELECT relacl::text AS acl, relrowsecurity, relforcerowsecurity,
    (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p
      WHERE schemaname = 'public' AND tablename = 'invitations') AS policies
  FROM pg_class WHERE oid = 'public.invitations'::regclass;

-- This helper actually executes SQL under each role, not only ACL inspection.
CREATE FUNCTION pg_temp.assert_denied(actor text, statement text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', actor);
  BEGIN
    EXECUTE statement;
    RAISE EXCEPTION 'Expected permission denial for %', actor;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
END;
$$;
SELECT pg_temp.assert_denied('service_role',
  $q$INSERT INTO public.invitations(code, created_by)
    VALUES ('BEFORE', '00000000-0000-0000-0000-000000000001')$q$);
\echo PASS: service role insert denied before migration

\ir ../migrations/0141_invitations_service_role_insert.sql
CREATE TEMP TABLE first_application AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.invitations'::regclass;
\ir ../migrations/0141_invitations_service_role_insert.sql
DO $$
BEGIN
  IF (SELECT acl FROM first_application) IS DISTINCT FROM
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.invitations'::regclass)
  THEN RAISE EXCEPTION 'Migration is not idempotent'; END IF;
END;
$$;
SET LOCAL ROLE service_role;
INSERT INTO public.invitations(code, created_by) VALUES
  ('AFTER', '00000000-0000-0000-0000-000000000001');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.invitations WHERE code = 'AFTER'
      AND created_by = '00000000-0000-0000-0000-000000000001') <> 1
  THEN RAISE EXCEPTION 'Service role insert/read-back failed'; END IF;
END;
$$;
RESET ROLE;
\echo PASS: migration is idempotent and service role can insert/read back

DO $$
DECLARE actor text; privilege text; statement text;
BEGIN
  FOREACH actor IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(actor, 'public.invitations', privilege)
      THEN RAISE EXCEPTION 'Unexpected client privilege: % %', actor, privilege; END IF;
    END LOOP;
    FOREACH statement IN ARRAY ARRAY[
      'SELECT * FROM public.invitations',
      'INSERT INTO public.invitations(code,created_by) VALUES (''DENIED'',''00000000-0000-0000-0000-000000000002'')',
      'UPDATE public.invitations SET status = ''used'' WHERE code = ''AFTER''',
      'DELETE FROM public.invitations WHERE code = ''AFTER'''
    ] LOOP
      PERFORM pg_temp.assert_denied(actor, statement);
    END LOOP;
  END LOOP;
  FOREACH privilege IN ARRAY ARRAY['UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('service_role', 'public.invitations', privilege)
    THEN RAISE EXCEPTION 'Unexpected service role privilege: %', privilege; END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM original_posture o, pg_class c
    WHERE c.oid = 'public.invitations'::regclass
      AND c.relrowsecurity = o.relrowsecurity AND c.relforcerowsecurity = o.relforcerowsecurity
      AND o.policies = (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p
        WHERE schemaname = 'public' AND tablename = 'invitations')
  ) THEN RAISE EXCEPTION 'RLS posture changed'; END IF;
END;
$$;
SELECT pg_temp.assert_denied('service_role', 'UPDATE public.invitations SET status = ''used''');
SELECT pg_temp.assert_denied('service_role', 'DELETE FROM public.invitations');
\echo PASS: client SELECT/DML denied, service UPDATE/DELETE denied, RLS unchanged

-- Validate the inverse only against this declared pre-migration fixture.
REVOKE INSERT ON TABLE public.invitations FROM service_role;
DO $$
BEGIN
  IF (SELECT acl FROM original_posture) IS DISTINCT FROM
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.invitations'::regclass)
  THEN RAISE EXCEPTION 'Rollback did not restore original ACL'; END IF;
  IF (SELECT count(*) FROM public.invitations WHERE code = 'AFTER') <> 1
  THEN RAISE EXCEPTION 'Rollback changed existing data'; END IF;
END;
$$;
SELECT pg_temp.assert_denied('service_role',
  $q$INSERT INTO public.invitations(code, created_by)
    VALUES ('ROLLBACK', '00000000-0000-0000-0000-000000000001')$q$);
\echo PASS: rollback restores ACL without deleting generated code
ROLLBACK;
