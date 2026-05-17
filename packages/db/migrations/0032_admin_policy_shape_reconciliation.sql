-- Migration: admin policy shape reconciliation
-- Related issue: #148
--
-- Purpose:
--   Codify admin policy shape without requiring public/anon access to is_admin.
--
-- Scope:
--   - Avoids is_admin dependency in public/anon RLS paths.
--   - Uses direct profiles.role/status checks for authenticated admin policies.
--   - Locks down is_admin EXECUTE posture if the helper exists.
--   - Does not seed data.
--   - Does not configure secrets or environment values.
--   - Do not apply to production without explicit owner approval.

-- If the legacy helper exists from an earlier migration or manual repair, keep
-- it non-callable by client roles. This migration intentionally does not create
-- public.is_admin().
DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.is_admin() SET search_path = public, pg_temp';
    EXECUTE 'REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.is_admin() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.is_admin() FROM authenticated';
  END IF;
END $$;

-- profiles: remove the legacy helper-backed admin policy. Recreating this with
-- a direct profiles lookup would recurse through profiles RLS; admin runtime
-- access uses service_role after application-level adminProcedure checks.
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "profiles_admin_all" ON public.profiles';
  END IF;
END $$;

-- conversations
DO $$
BEGIN
  IF to_regclass('public.conversations') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "conversations_admin_select" ON public.conversations';
    EXECUTE $policy$
      CREATE POLICY "conversations_admin_select"
        ON public.conversations FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- messages
DO $$
BEGIN
  IF to_regclass('public.messages') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "messages_admin_select" ON public.messages';
    EXECUTE $policy$
      CREATE POLICY "messages_admin_select"
        ON public.messages FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- credit_transactions
DO $$
BEGIN
  IF to_regclass('public.credit_transactions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "credit_transactions_insert_service" ON public.credit_transactions';
    EXECUTE 'DROP POLICY IF EXISTS "credit_transactions_admin_all" ON public.credit_transactions';
    EXECUTE 'DROP POLICY IF EXISTS "credit_transactions_select_admin" ON public.credit_transactions';
    EXECUTE $policy$
      CREATE POLICY "credit_transactions_select_admin"
        ON public.credit_transactions FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- ai_models: authenticated users can read active models; admins get a separate
-- direct role-check read policy. Anonymous users do not need this table.
DO $$
BEGIN
  IF to_regclass('public.ai_models') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "ai_models_select_active" ON public.ai_models';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active models" ON public.ai_models';
    EXECUTE 'DROP POLICY IF EXISTS "All users can view ai_models" ON public.ai_models';
    EXECUTE 'DROP POLICY IF EXISTS "authenticated_active_ai_models_select" ON public.ai_models';
    EXECUTE 'DROP POLICY IF EXISTS "ai_models_admin_all" ON public.ai_models';
    EXECUTE 'DROP POLICY IF EXISTS "ai_models_select_admin" ON public.ai_models';
    EXECUTE $policy$
      CREATE POLICY "authenticated_active_ai_models_select"
        ON public.ai_models FOR SELECT
        TO authenticated
        USING (is_active = 'true')
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "ai_models_select_admin"
        ON public.ai_models FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- system_settings: public policy stays key-scoped; admin read access is a
-- separate authenticated policy.
DO $$
BEGIN
  IF to_regclass('public.system_settings') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "system_settings_select_all" ON public.system_settings';
    EXECUTE 'DROP POLICY IF EXISTS "system_settings_admin_all" ON public.system_settings';
    EXECUTE 'DROP POLICY IF EXISTS "system_settings_select_public_maintenance" ON public.system_settings';
    EXECUTE 'DROP POLICY IF EXISTS "system_settings_select_public_user_facing" ON public.system_settings';
    EXECUTE 'DROP POLICY IF EXISTS "system_settings_select_admin" ON public.system_settings';
    EXECUTE $policy$
      CREATE POLICY "system_settings_select_public_user_facing"
        ON public.system_settings FOR SELECT
        TO anon, authenticated
        USING (
          key IN (
            'site_name',
            'support_email',
            'maintenance_mode',
            'home_show_onboarding',
            'home_show_featured_modules',
            'chat_show_model_selector',
            'max_input_characters',
            'enable_free_tier',
            'free_tier_messages',
            'enable_long_text_warning',
            'long_text_warning_threshold',
            'show_token_usage_stats',
            'chat_prompt_text',
            'chat_welcome_message',
            'chat_billing_hint',
            'input_credits_per_1k',
            'output_credits_per_1k'
          )
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "system_settings_select_admin"
        ON public.system_settings FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- tickets
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "tickets_admin_all" ON public.tickets';
    EXECUTE 'DROP POLICY IF EXISTS "tickets_select_admin" ON public.tickets';
    EXECUTE $policy$
      CREATE POLICY "tickets_select_admin"
        ON public.tickets FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- ticket_replies: keep user-owned insert behavior without helper-backed admin
-- fallback. Admin replies are written through service_role runtime paths.
DO $$
BEGIN
  IF to_regclass('public.ticket_replies') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "ticket_replies_insert_own" ON public.ticket_replies';
    EXECUTE 'DROP POLICY IF EXISTS "ticket_replies_admin_all" ON public.ticket_replies';
    EXECUTE 'DROP POLICY IF EXISTS "ticket_replies_select_admin" ON public.ticket_replies';
    EXECUTE $policy$
      CREATE POLICY "ticket_replies_insert_own"
        ON public.ticket_replies FOR INSERT
        TO authenticated
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.tickets t
            WHERE t.id = ticket_replies.ticket_id
              AND t.user_id = auth.uid()
          )
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "ticket_replies_select_admin"
        ON public.ticket_replies FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- credit_packages
DO $$
BEGIN
  IF to_regclass('public.credit_packages') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_select_active" ON public.credit_packages';
    EXECUTE 'DROP POLICY IF EXISTS "All users can view active packages" ON public.credit_packages';
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_select_active_public" ON public.credit_packages';
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_admin_all" ON public.credit_packages';
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_select_admin" ON public.credit_packages';
    EXECUTE $policy$
      CREATE POLICY "credit_packages_select_active_public"
        ON public.credit_packages FOR SELECT
        TO anon, authenticated
        USING (active = 'true')
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "credit_packages_select_admin"
        ON public.credit_packages FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- invitations
DO $$
BEGIN
  IF to_regclass('public.invitations') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "invitations_admin_all" ON public.invitations';
    EXECUTE 'DROP POLICY IF EXISTS "invitations_select_admin" ON public.invitations';
    EXECUTE $policy$
      CREATE POLICY "invitations_select_admin"
        ON public.invitations FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- user_activity_logs: service/runtime writes should use service_role. Keep a
-- direct admin read policy without helper dependency.
DO $$
BEGIN
  IF to_regclass('public.user_activity_logs') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "user_activity_logs_insert_service" ON public.user_activity_logs';
    EXECUTE 'DROP POLICY IF EXISTS "user_activity_logs_admin_all" ON public.user_activity_logs';
    EXECUTE 'DROP POLICY IF EXISTS "user_activity_logs_select_admin" ON public.user_activity_logs';
    EXECUTE $policy$
      CREATE POLICY "user_activity_logs_select_admin"
        ON public.user_activity_logs FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- announcements
DO $$
BEGIN
  IF to_regclass('public.announcements') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "announcements_select_active" ON public.announcements';
    EXECUTE 'DROP POLICY IF EXISTS "All users can view active announcements" ON public.announcements';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active announcements" ON public.announcements';
    EXECUTE 'DROP POLICY IF EXISTS "announcements_select_active_public" ON public.announcements';
    EXECUTE 'DROP POLICY IF EXISTS "announcements_admin_all" ON public.announcements';
    EXECUTE 'DROP POLICY IF EXISTS "announcements_select_admin" ON public.announcements';
    EXECUTE $policy$
      CREATE POLICY "announcements_select_active_public"
        ON public.announcements FOR SELECT
        TO anon, authenticated
        USING (
          active = 'true'
          AND is_deleted = 'false'
          AND (start_date IS NULL OR start_date <= now())
          AND (end_date IS NULL OR end_date >= now())
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "announcements_select_admin"
        ON public.announcements FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- prompts
DO $$
BEGIN
  IF to_regclass('public.prompts') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "prompts_select_active" ON public.prompts';
    EXECUTE 'DROP POLICY IF EXISTS "All users can view active prompts" ON public.prompts';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active prompts" ON public.prompts';
    EXECUTE 'DROP POLICY IF EXISTS "prompts_select_active_public" ON public.prompts';
    EXECUTE 'DROP POLICY IF EXISTS "prompts_admin_all" ON public.prompts';
    EXECUTE 'DROP POLICY IF EXISTS "prompts_select_admin" ON public.prompts';
    EXECUTE $policy$
      CREATE POLICY "prompts_select_active_public"
        ON public.prompts FOR SELECT
        TO anon, authenticated
        USING (active = 'true' AND is_deleted = 'false')
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "prompts_select_admin"
        ON public.prompts FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- invitation_records
DO $$
BEGIN
  IF to_regclass('public.invitation_records') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "invitation_records_admin_all" ON public.invitation_records';
    EXECUTE 'DROP POLICY IF EXISTS "invitation_records_select_admin" ON public.invitation_records';
    EXECUTE $policy$
      CREATE POLICY "invitation_records_select_admin"
        ON public.invitation_records FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- membership_plans
DO $$
BEGIN
  IF to_regclass('public.membership_plans') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_select_all" ON public.membership_plans';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active membership plans" ON public.membership_plans';
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_select_active_public" ON public.membership_plans';
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_admin_all" ON public.membership_plans';
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_select_admin" ON public.membership_plans';
    EXECUTE $policy$
      CREATE POLICY "membership_plans_select_active_public"
        ON public.membership_plans FOR SELECT
        TO anon, authenticated
        USING (is_active = 'true')
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "membership_plans_select_admin"
        ON public.membership_plans FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- modules
DO $$
BEGIN
  IF to_regclass('public.modules') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_active" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active modules" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_active_public" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_admin_all" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_admin" ON public.modules';
    EXECUTE $policy$
      CREATE POLICY "modules_select_active_public"
        ON public.modules FOR SELECT
        TO anon, authenticated
        USING (active = 'true')
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "modules_select_admin"
        ON public.modules FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- conversation_context_snapshots
DO $$
BEGIN
  IF to_regclass('public.conversation_context_snapshots') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "context_snapshots_select_own_or_admin" ON public.conversation_context_snapshots';
    EXECUTE 'DROP POLICY IF EXISTS "context_snapshots_admin_all" ON public.conversation_context_snapshots';
    EXECUTE $policy$
      CREATE POLICY "context_snapshots_select_own_or_admin"
        ON public.conversation_context_snapshots FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.conversations c
            WHERE c.id = conversation_id
              AND c.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "context_snapshots_admin_all"
        ON public.conversation_context_snapshots FOR ALL
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;

-- scheduled_job_runs
DO $$
BEGIN
  IF to_regclass('public.scheduled_job_runs') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "scheduled_job_runs_admin_all" ON public.scheduled_job_runs';
    EXECUTE $policy$
      CREATE POLICY "scheduled_job_runs_admin_all"
        ON public.scheduled_job_runs FOR ALL
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;
