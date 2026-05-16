-- #148 Phase 2B-2A: client-role non-DML grant hardening.
--
-- Purpose:
-- - Remove unnecessary REFERENCES/TRIGGER/TRUNCATE privileges from client roles.
-- - Scope is limited to anon/authenticated on selected public app tables.
--
-- This migration deliberately does not:
-- - Revoke SELECT, INSERT, UPDATE, or DELETE.
-- - Alter RLS policies.
-- - Alter function EXECUTE grants.
-- - Affect service_role grants.
-- - Seed data or change runtime application behavior.
--
-- Do not apply this migration to production without explicit owner approval.

REVOKE REFERENCES ON TABLE public.ai_models FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.ai_models FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.ai_models FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.ai_usage_logs FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.ai_usage_logs FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.ai_usage_logs FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.announcements FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.announcements FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.announcements FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.billing_history FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.billing_history FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.billing_history FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.conversation_context_snapshots FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.conversation_context_snapshots FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.conversation_context_snapshots FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.conversations FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.conversations FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.conversations FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.credit_packages FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.credit_packages FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.credit_packages FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.credit_transactions FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.credit_transactions FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.credit_transactions FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.invitation_records FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.invitation_records FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.invitation_records FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.invitations FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.invitations FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.invitations FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.membership_plans FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.membership_plans FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.membership_plans FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.messages FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.messages FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.messages FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.modules FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.modules FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.modules FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.payment_orders FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.payment_orders FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.payment_orders FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.profiles FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.profiles FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.profiles FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.prompts FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.prompts FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.prompts FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.system_settings FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.system_settings FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.system_settings FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.tickets FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.tickets FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.tickets FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.token_stats FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.token_stats FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.token_stats FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.user_checkins FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.user_checkins FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.user_checkins FROM anon, authenticated;

REVOKE REFERENCES ON TABLE public.user_subscriptions FROM anon, authenticated;
REVOKE TRIGGER ON TABLE public.user_subscriptions FROM anon, authenticated;
REVOKE TRUNCATE ON TABLE public.user_subscriptions FROM anon, authenticated;

-- Verification query sketch, for an owner-approved staging apply only:
-- - Inspect role_table_grants for remaining REFERENCES/TRIGGER/TRUNCATE on the
--   target tables for the two client roles.
-- - Inspect role_table_grants for SELECT/INSERT/UPDATE/DELETE on the same
--   tables to confirm expected runtime grants remain unchanged.
--
-- Rollback sketch, comments only:
-- - With owner approval, restore the same three revoked non-DML privileges on
--   the same target tables to the same two client roles.
