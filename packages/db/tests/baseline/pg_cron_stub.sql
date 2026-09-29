-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LOCAL-ONLY pg_cron stand-in installed as an extension script in a disposable container.
-- Records schedules in cron.job; runs nothing. Real Supabase ships the actual extension.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job(
  jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL, command text NOT NULL
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, command = excluded.command
  RETURNING jobid
$$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT count(*) > 0 FROM d
$$;
