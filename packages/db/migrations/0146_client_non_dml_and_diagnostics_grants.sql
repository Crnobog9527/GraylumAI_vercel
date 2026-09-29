-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- S1-FIX batch 3 (B-02/B-03): client roles never TRUNCATE/REFERENCES/TRIGGER/MAINTAIN a public
-- table, and have no access at all to diagnostic_results (admin page now reads and writes through
-- service_role) or application_logs (no client reader; server DB logging is never initialised).
-- Also stops tables created by postgres from inheriting those privileges by default.
-- No table/data/policy/service_role/Storage changes. Apply remotely only with Owner approval.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE oid IN (
      'public.diagnostic_results'::regclass, 'public.application_logs'::regclass
    ) AND relrowsecurity) <> 2 THEN
    RAISE EXCEPTION 'S1-FIX-3: diagnostic_results and application_logs must have RLS enabled';
  END IF;
END $$;

-- B-02/B-03 on every public relation (no client code path uses any of these); column-level
-- REFERENCES is cleared too. SELECT/INSERT/UPDATE/DELETE of other tables are left as they are.
DO $$
DECLARE
  rel record;
  columns_sql text;
BEGIN
  FOR rel IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.%I'
      ' FROM PUBLIC, anon, authenticated', rel.relname);
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_sql
    FROM pg_attribute WHERE attrelid = rel.oid AND attnum > 0 AND NOT attisdropped;
    IF columns_sql IS NOT NULL THEN
      EXECUTE format('REVOKE REFERENCES (%1$s) ON TABLE public.%2$I FROM PUBLIC, anon, authenticated',
        columns_sql, rel.relname);
    END IF;
  END LOOP;
END $$;

-- Clients keep nothing on these two tables; their admin/own-row policies become inert.
REVOKE ALL PRIVILEGES ON TABLE public.diagnostic_results, public.application_logs
  FROM PUBLIC, anon, authenticated;
-- Table REVOKE does not clear old column ACLs (including PUBLIC inheritance).
DO $$
DECLARE
  table_name text;
  columns_sql text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['diagnostic_results', 'application_logs'] LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_sql
    FROM pg_attribute WHERE attrelid = format('public.%I', table_name)::regclass
      AND attnum > 0 AND NOT attisdropped;
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
      ' ON TABLE public.%2$I FROM PUBLIC, anon, authenticated', columns_sql, table_name
    );
  END LOOP;
END $$;

-- Recurrence source found on staging: postgres' public table defaults grant clients Dxtm.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM PUBLIC, anon, authenticated;

-- Fail closed if any client non-DML privilege survived (e.g. an object owned by another role).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated')) r(role_name)
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(privilege)
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r.role_name, c.oid, p.privilege)
  ) OR EXISTS (
    SELECT 1 FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated')) r(role_name)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    WHERE c.oid IN ('public.diagnostic_results'::regclass, 'public.application_logs'::regclass)
      AND has_table_privilege(r.role_name, c.oid, p.privilege)
  ) THEN
    RAISE EXCEPTION 'S1-FIX-3: a client privilege survived; inspect ownership/ACL before applying';
  END IF;
END $$;
COMMIT;
