-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- S1-FIX batch 2 (A-09): the ticket auto-close cron records its run in scheduled_job_runs through
-- service_role (insert a running row, then finish it). Clients get no privileges at all.
-- No table/data/default/policy/Storage changes. Apply remotely only with Owner approval.
BEGIN;

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scheduled_job_runs'::regclass) THEN
    RAISE EXCEPTION 'S1-FIX-2: scheduled_job_runs must already have RLS enabled';
  END IF;
END $$;

-- Clients never touch job bookkeeping; with no client privileges the existing admin policy is inert.
REVOKE ALL PRIVILEGES ON TABLE public.scheduled_job_runs FROM PUBLIC, anon, authenticated;
-- Table REVOKE does not clear old column ACLs (including PUBLIC inheritance).
DO $$
DECLARE
  columns_sql text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_sql
  FROM pg_attribute WHERE attrelid = 'public.scheduled_job_runs'::regclass
    AND attnum > 0 AND NOT attisdropped;
  EXECUTE format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    ' ON TABLE public.scheduled_job_runs FROM PUBLIC, anon, authenticated', columns_sql
  );
END $$;

-- Only capabilities missing from the observed staging ACL (service_role had SELECT only).
GRANT INSERT (job_key, trigger_source, status, started_at)
  ON TABLE public.scheduled_job_runs TO service_role;
GRANT UPDATE (status, finished_at, summary, error)
  ON TABLE public.scheduled_job_runs TO service_role;
COMMIT;
