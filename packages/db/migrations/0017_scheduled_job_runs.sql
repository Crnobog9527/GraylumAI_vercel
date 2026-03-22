create table if not exists public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_key text not null,
  trigger_source text not null default 'cron' check (trigger_source in ('manual', 'cron')),
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists scheduled_job_runs_job_key_started_at_idx
  on public.scheduled_job_runs (job_key, started_at desc);
