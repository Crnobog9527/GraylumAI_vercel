-- Migration: Harden public route data access by removing app-layer admin fallbacks
-- Version: 0019
-- Date: 2026-03-27
-- Description: Allow anonymous reads only for explicitly public rows/keys and
--              move invitation code validation to a dedicated SECURITY DEFINER RPC.

-- ============================================
-- 1. system_settings public keys
-- ============================================

drop policy if exists "system_settings_select_all" on public.system_settings;
drop policy if exists "system_settings_select_public_maintenance" on public.system_settings;
drop policy if exists "system_settings_select_public_user_facing" on public.system_settings;

create policy "system_settings_select_public_user_facing"
  on public.system_settings for select
  using (
    key in (
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
    or auth.uid() is not null
  );

comment on policy "system_settings_select_public_user_facing" on public.system_settings is
  '匿名用户仅可读取前台显示所需配置项，其余设置仍要求认证用户访问';

-- ============================================
-- 2. membership_plans public active reads
-- ============================================

drop policy if exists "membership_plans_select_all" on public.membership_plans;
drop policy if exists "Anyone can view active membership plans" on public.membership_plans;

create policy "Anyone can view active membership plans"
  on public.membership_plans for select
  using (is_active = 'true' or is_admin());

-- ============================================
-- 3. modules public active reads
-- ============================================

drop policy if exists "modules_select_active" on public.modules;
drop policy if exists "Anyone can view active modules" on public.modules;

create policy "Anyone can view active modules"
  on public.modules for select
  using (active = 'true' or is_admin());

-- ============================================
-- 4. invitation validation RPC
-- ============================================

create or replace function public.validate_invitation_code(input_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.invitations
    where code = input_code
      and status = 'active'
  );
end;
$$;

revoke all on function public.validate_invitation_code(text) from public;
grant execute on function public.validate_invitation_code(text) to anon, authenticated, service_role;
