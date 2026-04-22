-- Migration: Supabase Security Advisor cleanup follow-up
-- Date: 2026-04-01
-- Description:
--   1. Ensure scheduled_job_runs is protected by RLS in hosted environments
--      that may have missed the earlier hardening migration.
--   2. Lock search_path on Stripe fulfillment SECURITY DEFINER functions so
--      Supabase Security Advisor no longer reports them as mutable.

-- ============================================
-- 1. scheduled_job_runs RLS
-- ============================================

alter table if exists public.scheduled_job_runs enable row level security;

drop policy if exists "scheduled_job_runs_admin_all" on public.scheduled_job_runs;
create policy "scheduled_job_runs_admin_all"
  on public.scheduled_job_runs for all
  using (is_admin())
  with check (is_admin());

-- ============================================
-- 2. Lock SECURITY DEFINER function search_path
-- ============================================

alter function public.atomic_fulfill_credit_package(text, text)
  set search_path = public, pg_temp;

alter function public.atomic_fulfill_membership_invoice(
  text,
  text,
  integer,
  text,
  text,
  text,
  timestamptz,
  timestamptz
)
  set search_path = public, pg_temp;
