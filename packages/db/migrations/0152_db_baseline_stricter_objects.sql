-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-BASELINE: add the 13 constraints / 77 indexes missing from staging.
-- Controller verified all 90 keys absent, no violations or missing columns:
-- PR #539, issuecomment-5907191601, precheck commit e8c6c23b74ff30f20c2c5525f4e843f3523c20d6.
-- Definitions are verbatim catalog definitions from a database built from repository files.
-- No business rows are changed. Any new violating row aborts this entire transaction.
-- On a file-built database every object already exists: this is a structural no-op.
-- Apply remotely only by the controller after Owner approval; sequence after PR #538.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.ai_usage_logs'::regclass AND conname = 'ai_usage_logs_status_check'
  ) THEN
    ALTER TABLE public.ai_usage_logs
      ADD CONSTRAINT ai_usage_logs_status_check
      CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'timeout'::text, 'rate_limited'::text, 'moderation_blocked'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.billing_history'::regclass AND conname = 'billing_history_operation_type_check'
  ) THEN
    ALTER TABLE public.billing_history
      ADD CONSTRAINT billing_history_operation_type_check
      CHECK ((operation_type = ANY (ARRAY['pre_deduct'::text, 'settle'::text, 'refund'::text, 'abort_settle'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.conversation_context_snapshots'::regclass AND conname = 'conversation_context_snapshots_snapshot_type_check'
  ) THEN
    ALTER TABLE public.conversation_context_snapshots
      ADD CONSTRAINT conversation_context_snapshots_snapshot_type_check
      CHECK ((snapshot_type = ANY (ARRAY['rolling_summary'::text, 'search_digest'::text, 'compression_checkpoint'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.payment_orders'::regclass AND conname = 'payment_orders_billing_cycle_check'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_billing_cycle_check
      CHECK ((billing_cycle = ANY (ARRAY['one_time'::text, 'monthly'::text, 'yearly'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.payment_orders'::regclass AND conname = 'payment_orders_item_type_check'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_item_type_check
      CHECK ((item_type = ANY (ARRAY['credit_package'::text, 'membership_plan'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.payment_orders'::regclass AND conname = 'payment_orders_mode_check'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_mode_check
      CHECK ((mode = ANY (ARRAY['payment'::text, 'subscription'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.payment_orders'::regclass AND conname = 'payment_orders_stripe_checkout_session_id_key'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_stripe_checkout_session_id_key
      UNIQUE (stripe_checkout_session_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.payment_orders'::regclass AND conname = 'payment_orders_stripe_invoice_id_key'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_stripe_invoice_id_key
      UNIQUE (stripe_invoice_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_credits_non_negative'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_credits_non_negative
      CHECK ((credits >= 0));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.scheduled_job_runs'::regclass AND conname = 'scheduled_job_runs_status_check'
  ) THEN
    ALTER TABLE public.scheduled_job_runs
      ADD CONSTRAINT scheduled_job_runs_status_check
      CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.scheduled_job_runs'::regclass AND conname = 'scheduled_job_runs_trigger_source_check'
  ) THEN
    ALTER TABLE public.scheduled_job_runs
      ADD CONSTRAINT scheduled_job_runs_trigger_source_check
      CHECK ((trigger_source = ANY (ARRAY['manual'::text, 'cron'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.user_subscriptions'::regclass AND conname = 'user_subscriptions_billing_cycle_check'
  ) THEN
    ALTER TABLE public.user_subscriptions
      ADD CONSTRAINT user_subscriptions_billing_cycle_check
      CHECK ((billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text])));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.user_subscriptions'::regclass AND conname = 'user_subscriptions_stripe_subscription_id_key'
  ) THEN
    ALTER TABLE public.user_subscriptions
      ADD CONSTRAINT user_subscriptions_stripe_subscription_id_key
      UNIQUE (stripe_subscription_id);
  END IF;
END $$;

-- Three indexes below are owned by the UNIQUE constraints above and already exist
-- after those constraints are added. IF NOT EXISTS preserves that ownership and name.
CREATE INDEX IF NOT EXISTS idx_ai_models_is_active
  ON public.ai_models USING btree (is_active);

CREATE INDEX IF NOT EXISTS idx_ai_models_name
  ON public.ai_models USING btree (name);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at
  ON public.ai_usage_logs USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_request_id
  ON public.ai_usage_logs USING btree (request_id) WHERE (request_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_status
  ON public.ai_usage_logs USING btree (status);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
  ON public.ai_usage_logs USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id
  ON public.ai_usage_logs USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_status
  ON public.ai_usage_logs USING btree (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_announcements_active
  ON public.announcements USING btree (active, priority DESC) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_announcements_active_priority_created_at
  ON public.announcements USING btree (active, priority DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_announcements_is_deleted
  ON public.announcements USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_announcements_type
  ON public.announcements USING btree (announcement_type);

CREATE INDEX IF NOT EXISTS idx_billing_history_created_at
  ON public.billing_history USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_history_operation_type
  ON public.billing_history USING btree (operation_type);

CREATE INDEX IF NOT EXISTS idx_billing_history_user_created
  ON public.billing_history USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_history_user_id
  ON public.billing_history USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_billing_history_user_operation
  ON public.billing_history USING btree (user_id, operation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation_created
  ON public.conversation_context_snapshots USING btree (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON public.conversations USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_is_deleted
  ON public.conversations USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_conversations_user_active
  ON public.conversations USING btree (user_id, is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON public.conversations USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at
  ON public.credit_transactions USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_type
  ON public.credit_transactions USING btree (type);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_created
  ON public.credit_transactions USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id
  ON public.credit_transactions USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_type_created_at
  ON public.credit_transactions USING btree (user_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitation_records_created_at
  ON public.invitation_records USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitation_records_inviter_id
  ON public.invitation_records USING btree (inviter_id);

CREATE INDEX IF NOT EXISTS idx_invitation_records_ip_address_created_at
  ON public.invitation_records USING btree (ip_address, created_at DESC) WHERE (ip_address IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_invitation_records_risk_level_created_at
  ON public.invitation_records USING btree (risk_level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitation_records_status
  ON public.invitation_records USING btree (status);

CREATE INDEX IF NOT EXISTS idx_invitation_records_status_created_at
  ON public.invitation_records USING btree (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitations_created_by
  ON public.invitations USING btree (created_by);

CREATE INDEX IF NOT EXISTS idx_invitations_status
  ON public.invitations USING btree (status);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages USING btree (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON public.messages USING btree (conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_is_deleted
  ON public.messages USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_modules_created_by
  ON public.modules USING btree (created_by);

CREATE INDEX IF NOT EXISTS idx_modules_model_id
  ON public.modules USING btree (model_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status
  ON public.payment_orders USING btree (status);

CREATE INDEX IF NOT EXISTS idx_payment_orders_subscription_id
  ON public.payment_orders USING btree (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id
  ON public.payment_orders USING btree (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_stripe_checkout_session_id_key
  ON public.payment_orders USING btree (stripe_checkout_session_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_stripe_invoice_id_key
  ON public.payment_orders USING btree (stripe_invoice_id);

CREATE INDEX IF NOT EXISTS idx_profiles_active
  ON public.profiles USING btree (status) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_profiles_created_at
  ON public.profiles USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profiles_is_deleted
  ON public.profiles USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_profiles_membership_level
  ON public.profiles USING btree (membership_level);

CREATE INDEX IF NOT EXISTS idx_profiles_role
  ON public.profiles USING btree (role);

CREATE INDEX IF NOT EXISTS idx_profiles_status_created_at
  ON public.profiles USING btree (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_active_sort_created_at
  ON public.prompts USING btree (active, sort_order DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_category_active_sort_created_at
  ON public.prompts USING btree (category, active, sort_order DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_is_deleted
  ON public.prompts USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS scheduled_job_runs_job_key_started_at_idx
  ON public.scheduled_job_runs USING btree (job_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_replies_is_deleted
  ON public.ticket_replies USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_tickets_category_created_at
  ON public.tickets USING btree (category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_created_at
  ON public.tickets USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_is_deleted
  ON public.tickets USING btree (is_deleted) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_tickets_priority
  ON public.tickets USING btree (priority);

CREATE INDEX IF NOT EXISTS idx_tickets_priority_created_at
  ON public.tickets USING btree (priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_status
  ON public.tickets USING btree (status);

CREATE INDEX IF NOT EXISTS idx_tickets_status_created_at
  ON public.tickets USING btree (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id
  ON public.tickets USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_tickets_user_status
  ON public.tickets USING btree (user_id, status) WHERE (is_deleted = 'false'::text);

CREATE INDEX IF NOT EXISTS idx_token_stats_conversation_id
  ON public.token_stats USING btree (conversation_id);

CREATE INDEX IF NOT EXISTS idx_token_stats_created_at
  ON public.token_stats USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_stats_model_used
  ON public.token_stats USING btree (model_used);

CREATE INDEX IF NOT EXISTS idx_token_stats_user_created
  ON public.token_stats USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_stats_user_id
  ON public.token_stats USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_action_type
  ON public.user_activity_logs USING btree (action_type);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_admin_id
  ON public.user_activity_logs USING btree (admin_id) WHERE (admin_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_created
  ON public.user_activity_logs USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id
  ON public.user_activity_logs USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status
  ON public.user_subscriptions USING btree (status);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id
  ON public.user_subscriptions USING btree (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_stripe_subscription_id_key
  ON public.user_subscriptions USING btree (stripe_subscription_id);

COMMIT;
