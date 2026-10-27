-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-RW PR-B (number 0414 assigned by the controller): catalog version numbers for the Node process cache (db-rw-redesign-v1 section 4).
-- Slow-changing, administrator-written catalogs are read on every turn: system settings, the model catalog and the Skill
-- catalog. A Node process may keep what it read in memory as long as the catalog has not changed since. This migration
-- gives each catalog one version number that a trigger raises on every change of its tables:
--   settings: system_settings
--   models:   ai_models
--   skills:   modules, skills, skill_revisions, skill_revision_revocations, skill_packages
-- catalog_versions_snapshot() returns the three numbers and the cache switch (system_settings runtime_rw_v2.catalogCache,
-- off unless set to true) in one read. Balances, grants, tombstones, Session state and a user's membership are never
-- versioned here and never cached. Database functions keep reading these tables themselves; nothing here changes them.
-- Only rows a statement actually inserts, changes or deletes raise a version (row triggers; an unchanged UPDATE or an
-- ON CONFLICT DO NOTHING raises nothing), so no per-turn write contends for these rows: every writer of these tables is an
-- administrator action, a Skill publication, a seven-day price refresh or the capacity marker cron.
-- Compatibility: new table, triggers and function only; old application code never reads them. Repeatable: IF NOT EXISTS,
-- ON CONFLICT DO NOTHING, CREATE OR REPLACE and DROP TRIGGER IF EXISTS. Recovery: turn the switch off (Node reads fresh
-- again), or drop the triggers, the function and the table; nothing else depends on them.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.catalog_versions (
  name text PRIMARY KEY CHECK (name IN ('settings','models','skills')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  bumped_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.catalog_versions(name) VALUES ('settings'),('models'),('skills') ON CONFLICT (name) DO NOTHING;
ALTER TABLE public.catalog_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_versions FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.catalog_versions_bump()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 UPDATE catalog_versions SET version=version+1,bumped_at=now() WHERE name=TG_ARGV[0];
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.catalog_versions_bump() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.catalog_versions_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  'enabled', COALESCE((SELECT value->'catalogCache'='true'::jsonb FROM system_settings
   WHERE key='runtime_rw_v2' AND jsonb_typeof(value)='object'), false),
  'settings', (SELECT version FROM catalog_versions WHERE name='settings'),
  'models', (SELECT version FROM catalog_versions WHERE name='models'),
  'skills', (SELECT version FROM catalog_versions WHERE name='skills'))
$function$;
REVOKE ALL ON FUNCTION public.catalog_versions_snapshot() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.catalog_versions_snapshot() TO service_role;

DO $$
DECLARE t record;
BEGIN
 FOR t IN SELECT * FROM (VALUES ('system_settings','settings'),('ai_models','models'),('modules','skills'),('skills','skills'),
  ('skill_revisions','skills'),('skill_revision_revocations','skills'),('skill_packages','skills')) v(tab,grp) LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS catalog_versions_row ON public.%I',t.tab);
  EXECUTE format('DROP TRIGGER IF EXISTS catalog_versions_change ON public.%I',t.tab);
  EXECUTE format('DROP TRIGGER IF EXISTS catalog_versions_insert_delete ON public.%I',t.tab);
  EXECUTE format('DROP TRIGGER IF EXISTS catalog_versions_truncate ON public.%I',t.tab);
  EXECUTE format('CREATE TRIGGER catalog_versions_insert_delete AFTER INSERT OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_versions_bump(%L)',t.tab,t.grp);
  EXECUTE format('CREATE TRIGGER catalog_versions_change AFTER UPDATE ON public.%I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.catalog_versions_bump(%L)',t.tab,t.grp);
  EXECUTE format('CREATE TRIGGER catalog_versions_truncate AFTER TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_versions_bump(%L)',t.tab,t.grp);
 END LOOP;
END $$;

COMMIT;
