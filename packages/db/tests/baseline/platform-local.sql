-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LOCAL-ONLY stand-in for what a fresh Supabase project provides before any Graylum SQL runs.
-- Never apply to a real environment: Supabase creates these roles/schemas itself.
-- Mirrors the platform facts the migrations depend on: client roles, auth.uid(), the extensions
-- schema, a minimal storage.buckets, and the default public privileges of a new project.
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')), '')::text
$$;

CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" SCHEMA extensions;

CREATE SCHEMA storage;
CREATE TABLE storage.buckets(
  id text PRIMARY KEY, name text NOT NULL, owner uuid, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
