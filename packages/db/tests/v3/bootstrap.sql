-- Disposable fixture foundation: profile/module columns from packages/db/schema.ts.
-- Does not seed any real account, commercial method, provider or money state.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN;
GRANT anon,authenticated,service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO authenticated,service_role;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,email text,role text NOT NULL DEFAULT 'user',status text NOT NULL DEFAULT 'active',is_deleted text NOT NULL DEFAULT 'false');
CREATE TABLE public.modules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,active boolean NOT NULL DEFAULT false,
  platform text DEFAULT 'web',category text DEFAULT 'other',model_id uuid);
ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
GRANT SELECT(id,active) ON public.modules TO anon,authenticated;
GRANT ALL ON public.modules,public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT(id,role,status) ON public.profiles TO authenticated;
CREATE POLICY profiles_self ON public.profiles FOR SELECT TO authenticated USING(id=auth.uid());

ALTER TABLE profiles ADD COLUMN nickname text DEFAULT 'Fixture', ADD COLUMN credits integer DEFAULT 0, ADD COLUMN membership_level text DEFAULT 'free', ADD COLUMN created_at timestamptz DEFAULT '2026-01-01T00:00:00Z';
GRANT SELECT(email,nickname,credits,membership_level,created_at) ON profiles TO authenticated;
