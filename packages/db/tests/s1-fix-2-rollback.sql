-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- S1-FIX batch 2 (0145) rollback ONLY to staging catalog 2026-09-29 15:01:51 UTC.
-- Restores the broken cron bookkeeping and client TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.
-- Separately authorize remote use. Does not undo job runs recorded while 0145 was active.
BEGIN;
REVOKE INSERT (job_key, trigger_source, status, started_at)
  ON TABLE public.scheduled_job_runs FROM service_role;
REVOKE UPDATE (status, finished_at, summary, error)
  ON TABLE public.scheduled_job_runs FROM service_role;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.scheduled_job_runs TO anon, authenticated;
COMMIT;
