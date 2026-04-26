-- Migration: Repair active-flag RLS drift and secure scheduled_job_runs
-- Version: 0018
-- Date: 2026-03-24
-- Description: Fix legacy policy drift on tables whose active flags are still text-backed
--              in the live database, preserve boolean soft-delete posture, and enable
--              RLS on scheduled_job_runs.

-- ============================================
-- 1. Public read policies for text-backed active flags
-- ============================================

drop policy if exists "ai_models_select_active" on public.ai_models;
drop policy if exists "Anyone can view active models" on public.ai_models;
drop policy if exists "All users can view ai_models" on public.ai_models;
create policy "Anyone can view active models"
  on public.ai_models for select
  using (is_active = 'true' or is_admin());

drop policy if exists "credit_packages_select_active" on public.credit_packages;
drop policy if exists "All users can view active packages" on public.credit_packages;
create policy "All users can view active packages"
  on public.credit_packages for select
  using (active = 'true' or is_admin());

drop policy if exists "announcements_select_active" on public.announcements;
drop policy if exists "All users can view active announcements" on public.announcements;
drop policy if exists "Anyone can view active announcements" on public.announcements;
create policy "Anyone can view active announcements"
  on public.announcements for select
  using (
    active = 'true'
    and is_deleted = false
    and (start_date is null or start_date <= now())
    and (end_date is null or end_date >= now())
  );

drop policy if exists "prompts_select_active" on public.prompts;
drop policy if exists "All users can view active prompts" on public.prompts;
drop policy if exists "Anyone can view active prompts" on public.prompts;
create policy "Anyone can view active prompts"
  on public.prompts for select
  using (active = 'true' and is_deleted = false);

-- ============================================
-- 2. scheduled_job_runs RLS posture
-- ============================================

alter table public.scheduled_job_runs enable row level security;

drop policy if exists "scheduled_job_runs_admin_all" on public.scheduled_job_runs;
create policy "scheduled_job_runs_admin_all"
  on public.scheduled_job_runs for all
  using (is_admin())
  with check (is_admin());
