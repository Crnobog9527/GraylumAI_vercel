-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- S1-FIX batch 3 (0146) rollback ONLY to staging catalog 2026-09-29 16:17:55 UTC.
-- Restores client TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, full client access to diagnostic_results
-- and application_logs, and postgres' client table defaults. The diagnostics code of this batch
-- keeps working after rollback (service_role access is unchanged). Separately authorize remote use.
BEGIN;
GRANT MAINTAIN ON TABLE public.ai_models, public.ai_usage_logs, public.billing_history,
  public.conversation_context_snapshots, public.conversations, public.credit_packages,
  public.credit_transactions, public.invitation_records, public.invitations,
  public.membership_plans, public.messages, public.modules, public.payment_orders, public.prompts,
  public.system_settings, public.token_stats, public.user_checkins, public.user_subscriptions
  TO anon, authenticated;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.subscription_credit_grants
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.diagnostic_results, public.application_logs
  TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO anon, authenticated;
COMMIT;
