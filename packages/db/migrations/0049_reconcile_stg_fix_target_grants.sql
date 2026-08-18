-- Migration: 0049_reconcile_stg_fix_target_grants
-- Purpose: restore the durable-proven DML grants missing after migration 0048.
-- Scope: only public.application_logs and public.diagnostic_results table grants.
-- This migration is expand-only and intentionally contains no REVOKE,
-- ALTER DEFAULT PRIVILEGES, or structural changes.

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.application_logs
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.application_logs
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.application_logs
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.diagnostic_results
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.diagnostic_results
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.diagnostic_results
TO service_role;
