-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-BASELINE: converge a database built from files (platform -> packages/db/baseline -> every
-- migration) to the staging structure, which drifted outside the repository over time.
-- Every step is guarded or idempotent: on staging (already in the target state) the only effects
-- are re-creating 14 policies with identical definitions and GRANTs it already has.
-- No table rows are read or changed. Apply remotely only with Owner approval.
BEGIN;

-- 1. Ticket auto-close runs only as the Vercel cron (#506). 0010 schedules a second, database-side
--    job through pg_cron on a new database; staging has no pg_cron. Remove the job, its function
--    and the extension so a new production database has exactly one auto-close path.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$
      SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname = 'ticket-auto-close-hourly'
    $cron$;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.auto_close_stale_tickets(integer);
DROP EXTENSION IF EXISTS pg_cron;

-- 2. Legacy objects staging no longer has and no code calls (diagnostics view/RPCs replaced in
--    #519; application_logs RPCs; old credit/ticket helpers). The view also read diagnostic_results
--    with its owner's rights, around the service-role-only access of 0146.
DROP VIEW IF EXISTS public.diagnostic_latest_results;
DROP FUNCTION IF EXISTS public.cleanup_old_diagnostic_results(integer);
DROP FUNCTION IF EXISTS public.get_diagnostic_summary(integer);
DROP FUNCTION IF EXISTS public.get_test_history(text, integer);
DROP FUNCTION IF EXISTS public.cleanup_old_logs();
DROP FUNCTION IF EXISTS public.get_error_summary(integer);
DROP FUNCTION IF EXISTS public.get_log_stats(timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.get_user_credits(uuid);
DROP FUNCTION IF EXISTS public.soft_delete_ticket(uuid, uuid);

-- 3. Early client policies that staging dropped outside the repository.
DROP POLICY IF EXISTS "Users can view own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can insert own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can update own conversations" ON public.conversations;
DROP POLICY IF EXISTS conversations_delete_own ON public.conversations;
DROP POLICY IF EXISTS "Users can view messages in own conversations" ON public.messages;
DROP POLICY IF EXISTS "Users can insert messages in own conversations" ON public.messages;
DROP POLICY IF EXISTS messages_insert_own ON public.messages;
DROP POLICY IF EXISTS messages_delete_own ON public.messages;
DROP POLICY IF EXISTS invitations_select_own ON public.invitations;
DROP POLICY IF EXISTS invitations_insert_own ON public.invitations;
DROP POLICY IF EXISTS admin_all_billing_history ON public.billing_history;
DROP POLICY IF EXISTS users_own_billing_history_select ON public.billing_history;
DROP POLICY IF EXISTS admin_all_payment_orders ON public.payment_orders;
DROP POLICY IF EXISTS service_role_all_token_stats ON public.token_stats;
DROP POLICY IF EXISTS admin_all_user_subscriptions ON public.user_subscriptions;
DROP POLICY IF EXISTS admin_all_ai_usage_logs ON public.ai_usage_logs;
DROP POLICY IF EXISTS users_own_ai_usage_logs_select ON public.ai_usage_logs;
DROP POLICY IF EXISTS users_own_ai_usage_logs_insert ON public.ai_usage_logs;

-- 4. Policies re-created below in staging's form (they reference flags converted in step 5).
DROP POLICY IF EXISTS authenticated_active_ai_models_select ON public.ai_models;
DROP POLICY IF EXISTS announcements_select_active_public ON public.announcements;
DROP POLICY IF EXISTS prompts_select_active_public ON public.prompts;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
DROP POLICY IF EXISTS tickets_select_own ON public.tickets;
DROP POLICY IF EXISTS tickets_insert_own ON public.tickets;
DROP POLICY IF EXISTS tickets_update_own ON public.tickets;
DROP POLICY IF EXISTS ticket_replies_select_own ON public.ticket_replies;
DROP POLICY IF EXISTS ticket_replies_insert_own ON public.ticket_replies;
DROP POLICY IF EXISTS conversations_select_own ON public.conversations;
DROP POLICY IF EXISTS conversations_insert_own ON public.conversations;
DROP POLICY IF EXISTS conversations_update_own ON public.conversations;
DROP POLICY IF EXISTS messages_select_own ON public.messages;
DROP POLICY IF EXISTS credit_transactions_select_own ON public.credit_transactions;
DROP POLICY IF EXISTS users_own_token_stats_select ON public.token_stats;

-- 5. Flags that early migrations need as boolean and staging (and the application) keep as text
--    'true'/'false'. Only boolean columns are converted; partial indexes whose predicate compares
--    the boolean are re-created with the text literal.
DO $$
DECLARE
  flag record;
  converted boolean := false;
BEGIN
  FOR flag IN SELECT * FROM (VALUES
    ('ai_models', 'is_active', 'true'), ('prompts', 'active', 'true'),
    ('profiles', 'is_deleted', 'false'), ('conversations', 'is_deleted', 'false'),
    ('messages', 'is_deleted', 'false'), ('tickets', 'is_deleted', 'false'),
    ('ticket_replies', 'is_deleted', 'false'), ('prompts', 'is_deleted', 'false'),
    ('announcements', 'is_deleted', 'false')
  ) AS f(table_name, column_name, default_value)
  LOOP
    IF (SELECT atttypid FROM pg_attribute WHERE attrelid = format('public.%I', flag.table_name)::regclass
        AND attname = flag.column_name AND NOT attisdropped) = 'boolean'::regtype THEN
      IF NOT converted THEN
        DROP INDEX IF EXISTS public.idx_profiles_is_deleted, public.idx_profiles_active,
          public.idx_conversations_is_deleted, public.idx_conversations_user_active,
          public.idx_messages_is_deleted, public.idx_tickets_is_deleted, public.idx_tickets_user_status,
          public.idx_ticket_replies_is_deleted, public.idx_prompts_is_deleted,
          public.idx_announcements_is_deleted, public.idx_announcements_active;
        converted := true;
      END IF;
      EXECUTE format('ALTER TABLE public.%1$I ALTER COLUMN %2$I DROP DEFAULT, '
        || 'ALTER COLUMN %2$I TYPE text USING (CASE WHEN %2$I THEN ''true'' ELSE ''false'' END), '
        || 'ALTER COLUMN %2$I SET DEFAULT %3$L, ALTER COLUMN %2$I SET NOT NULL',
        flag.table_name, flag.column_name, flag.default_value);
    END IF;
  END LOOP;
  IF converted THEN
    CREATE INDEX idx_profiles_is_deleted ON public.profiles (is_deleted) WHERE is_deleted = 'false';
    CREATE INDEX idx_profiles_active ON public.profiles (status) WHERE is_deleted = 'false';
    CREATE INDEX idx_conversations_is_deleted ON public.conversations (is_deleted) WHERE is_deleted = 'false';
    CREATE INDEX idx_conversations_user_active ON public.conversations (user_id, is_deleted)
      WHERE is_deleted = 'false';
    CREATE INDEX idx_messages_is_deleted ON public.messages (is_deleted) WHERE is_deleted = 'false';
    CREATE INDEX idx_tickets_is_deleted ON public.tickets (is_deleted) WHERE is_deleted = 'false';
    CREATE INDEX idx_tickets_user_status ON public.tickets (user_id, status) WHERE is_deleted = 'false';
    CREATE INDEX idx_ticket_replies_is_deleted ON public.ticket_replies (is_deleted)
      WHERE is_deleted = 'false';
    CREATE INDEX idx_prompts_is_deleted ON public.prompts (is_deleted) WHERE is_deleted = 'false';
    CREATE INDEX idx_announcements_is_deleted ON public.announcements (is_deleted)
      WHERE is_deleted = 'false';
    CREATE INDEX idx_announcements_active ON public.announcements (active, priority DESC)
      WHERE is_deleted = 'false';
  END IF;
END $$;

-- 0002 needed boolean is_active columns that staging never had (it uses the text flag active).
ALTER TABLE public.credit_packages DROP COLUMN IF EXISTS is_active;
ALTER TABLE public.announcements DROP COLUMN IF EXISTS is_active;
ALTER TABLE public.modules ALTER COLUMN updated_at SET NOT NULL;

CREATE POLICY authenticated_active_ai_models_select ON public.ai_models FOR SELECT TO authenticated
  USING (is_active = 'true');
CREATE POLICY announcements_select_active_public ON public.announcements FOR SELECT
  TO anon, authenticated
  USING (active = 'true' AND is_deleted = 'false'
    AND (start_date IS NULL OR start_date <= now()) AND (end_date IS NULL OR end_date >= now()));
CREATE POLICY prompts_select_active_public ON public.prompts FOR SELECT TO anon, authenticated
  USING (active = 'true' AND is_deleted = 'false');
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()) AND is_deleted = 'false')
  WITH CHECK (id = (SELECT auth.uid()) AND is_deleted = 'false'
    AND char_length(btrim(nickname)) BETWEEN 1 AND 80);
CREATE POLICY tickets_select_own ON public.tickets FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND is_deleted = 'false');
CREATE POLICY tickets_insert_own ON public.tickets FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_deleted = 'false' AND status = 'open'
    AND category IN ('bug', 'feature', 'question', 'account', 'billing', 'other')
    AND CASE WHEN jsonb_typeof(attachments) = 'array' THEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(attachments) AS attachment(value)
      WHERE jsonb_typeof(attachment.value) <> 'string'
        OR NOT starts_with(attachment.value #>> '{}', (SELECT auth.uid())::text || '/')
        OR (attachment.value #>> '{}') ~ '(^|/)\.\.(/|$)'
    ) ELSE false END
  );
CREATE POLICY tickets_update_own ON public.tickets FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND is_deleted = 'false')
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_deleted = 'false' AND status = 'closed');
CREATE POLICY ticket_replies_select_own ON public.ticket_replies FOR SELECT TO authenticated
  USING (is_deleted = 'false' AND EXISTS (
    SELECT 1 FROM public.tickets t
    WHERE t.id = ticket_replies.ticket_id AND t.user_id = (SELECT auth.uid())
      AND t.is_deleted = 'false'
  ));
CREATE POLICY ticket_replies_insert_own ON public.ticket_replies FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_admin = 'false' AND is_deleted = 'false'
    AND EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_replies.ticket_id AND t.user_id = (SELECT auth.uid())
        AND t.is_deleted = 'false'
    )
  );
CREATE POLICY conversations_select_own ON public.conversations FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY conversations_insert_own ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY conversations_update_own ON public.conversations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY messages_select_own ON public.messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id AND c.user_id = auth.uid()
  ));
CREATE POLICY credit_transactions_select_own ON public.credit_transactions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY users_own_token_stats_select ON public.token_stats FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 6. Same foreign keys, staging's constraint names (tables staging created before their migration).
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('ai_usage_logs', 'ai_usage_logs_user_id_fkey', 'ai_usage_logs_user_id_profiles_id_fk'),
    ('ai_usage_logs', 'ai_usage_logs_conversation_id_fkey', 'ai_usage_logs_conversation_id_conversations_id_fk'),
    ('billing_history', 'billing_history_user_id_fkey', 'billing_history_user_id_profiles_id_fk'),
    ('billing_history', 'billing_history_transaction_id_fkey',
      'billing_history_transaction_id_credit_transactions_id_fk'),
    ('conversation_context_snapshots', 'conversation_context_snapshots_conversation_id_fkey',
      'conversation_context_snapshots_conversation_id_conversations_id'),
    ('conversation_context_snapshots', 'conversation_context_snapshots_source_message_start_id_fkey',
      'conversation_context_snapshots_source_message_start_id_messages'),
    ('conversation_context_snapshots', 'conversation_context_snapshots_source_message_end_id_fkey',
      'conversation_context_snapshots_source_message_end_id_messages_i'),
    ('modules', 'modules_created_by_fkey', 'modules_created_by_profiles_id_fk'),
    ('modules', 'modules_model_id_fkey', 'modules_model_id_ai_models_id_fk'),
    ('payment_orders', 'payment_orders_user_id_fkey', 'payment_orders_user_id_profiles_id_fk'),
    ('token_stats', 'token_stats_user_id_fkey', 'token_stats_user_id_profiles_id_fk'),
    ('token_stats', 'token_stats_conversation_id_fkey', 'token_stats_conversation_id_conversations_id_fk'),
    ('token_stats', 'token_stats_message_id_fkey', 'token_stats_message_id_messages_id_fk'),
    ('user_checkins', 'user_checkins_pkey', 'user_checkins_user_id_checkin_date_pk'),
    ('user_checkins', 'user_checkins_user_id_fkey', 'user_checkins_user_id_profiles_id_fk'),
    ('user_subscriptions', 'user_subscriptions_user_id_fkey', 'user_subscriptions_user_id_profiles_id_fk'),
    ('user_subscriptions', 'user_subscriptions_membership_plan_id_fkey',
      'user_subscriptions_membership_plan_id_membership_plans_id_fk')
  ) AS c(table_name, from_name, to_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', item.table_name)::regclass
        AND conname = item.from_name)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = format('public.%I', item.table_name)::regclass AND conname = item.to_name) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        item.table_name, item.from_name, item.to_name);
    END IF;
  END LOOP;
END $$;

-- 7. The idempotency key index must be a plain unique index (ON CONFLICT (user_id, idempotency_key)
--    cannot infer a partial one); staging has the plain form.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index
      WHERE indexrelid = to_regclass('public.idx_credit_transactions_user_idempotency_key')
        AND indpred IS NOT NULL) THEN
    DROP INDEX public.idx_credit_transactions_user_idempotency_key;
    CREATE UNIQUE INDEX idx_credit_transactions_user_idempotency_key
      ON public.credit_transactions (user_id, idempotency_key);
  END IF;
END $$;

-- 8. Table privileges staging has and the code depends on (service-role reads, client reads of
--    public catalogs and own rows under RLS). GRANT is a no-op where already held.
GRANT SELECT ON TABLE public.ai_models, public.ai_usage_logs, public.announcements,
  public.conversations, public.credit_packages, public.invitation_records, public.invitations,
  public.membership_plans, public.messages, public.modules, public.prompts,
  public.scheduled_job_runs, public.system_settings, public.tickets, public.token_stats
  TO service_role;
GRANT INSERT, UPDATE ON TABLE public.modules TO service_role;
GRANT SELECT ON TABLE public.credit_packages, public.membership_plans, public.system_settings
  TO anon, authenticated;
GRANT SELECT ON TABLE public.conversations, public.credit_transactions, public.messages,
  public.profiles, public.token_stats, public.user_checkins TO authenticated;
GRANT INSERT, UPDATE ON TABLE public.conversations TO authenticated;

-- 9. Defence in depth from 0027 that staging lost: client roles cannot write profile credits or
--    bootstrap a privileged profile. Column grants already deny this; the trigger keeps it denied
--    if a future grant widens. Service role and SECURITY DEFINER functions are unaffected.
CREATE OR REPLACE FUNCTION public.prevent_client_profile_credit_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF COALESCE(NEW.credits, 0) <> 0 THEN
        RAISE EXCEPTION 'client profile bootstrap cannot insert non-zero credits'
          USING ERRCODE = '42501';
      END IF;
      IF COALESCE(NEW.role, 'user') <> 'user' THEN
        RAISE EXCEPTION 'client profile bootstrap cannot insert privileged role'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.credits IS DISTINCT FROM OLD.credits THEN
      RAISE EXCEPTION 'client role cannot update profile credits'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_client_profile_credit_write ON public.profiles;
CREATE TRIGGER trg_prevent_client_profile_credit_write
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_client_profile_credit_write();

-- 10. Private ticket attachment bucket, as on staging (the upload route also creates it lazily).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('ticket-attachments', 'ticket-attachments', false, 5242880,
      ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
COMMIT;
