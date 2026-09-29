-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-BASELINE: the 16 core tables that migrations 0001+ assume already exist but never create.
-- Runs exactly once on an EMPTY database, after the Supabase platform and before migration 0001.
-- It is NOT a migration and is never applied to staging or any database that already has them.
--
-- Shape = staging catalog (READ ONLY, 2026-09-30) minus everything a later migration adds itself
-- (every such ADD COLUMN uses IF NOT EXISTS, constraints/indexes/triggers/RLS/grants follow in
-- migrations), and in the early form those migrations expect where it differs from today's.
-- Anything the replay still ends up different from staging is converged by migration 0148+.
BEGIN;

-- Default privileges for objects postgres creates in public. A new Supabase project grants the
-- client roles and service_role ALL here; every migration was written against staging's narrower
-- defaults (0063, for instance, fails closed if service_role gets table SELECT by default), and
-- each migration grants what it needs explicitly. Set exactly staging's current defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT UPDATE ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
-- Staging also lists the owner explicitly in each entry (no effect on privileges).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  email text,
  nickname text,
  avatar_url text,
  role text NOT NULL DEFAULT 'user',
  status text NOT NULL DEFAULT 'active',
  membership_level text NOT NULL DEFAULT 'free',
  credits integer NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  last_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);

CREATE TABLE public.ai_models (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  model_id text NOT NULL,
  provider text NOT NULL DEFAULT 'openai',
  api_key text,
  api_endpoint text,
  description text,
  max_tokens integer NOT NULL DEFAULT 4096,
  input_limit integer NOT NULL DEFAULT 180000,
  enable_web_search text NOT NULL DEFAULT 'false',
  input_token_cost integer NOT NULL DEFAULT 0,
  output_token_cost integer NOT NULL DEFAULT 0,
  input_token_cost_above_200k integer NOT NULL DEFAULT 0,
  output_token_cost_above_200k integer NOT NULL DEFAULT 0,
  web_search_cost integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  config jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_models_pkey PRIMARY KEY (id)
);

CREATE TABLE public.conversations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  model_id uuid,
  summary text,
  summary_tokens integer,
  summary_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_user_id_profiles_id_fk FOREIGN KEY (user_id)
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT conversations_model_id_ai_models_id_fk FOREIGN KEY (model_id) REFERENCES public.ai_models(id)
);

CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id)
    REFERENCES public.conversations(id) ON DELETE CASCADE
);

CREATE TABLE public.credit_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  amount integer NOT NULL,
  type text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT credit_transactions_user_id_profiles_id_fk FOREIGN KEY (user_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.system_settings (
  key text NOT NULL,
  value jsonb,
  CONSTRAINT system_settings_pkey PRIMARY KEY (key)
);

CREATE TABLE public.tickets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  title text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'other',
  priority text NOT NULL DEFAULT 'medium',
  attachments jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tickets_pkey PRIMARY KEY (id),
  CONSTRAINT tickets_user_id_profiles_id_fk FOREIGN KEY (user_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.ticket_replies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL,
  user_id uuid,
  content text NOT NULL,
  is_admin text NOT NULL DEFAULT 'false',
  attachments jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_replies_pkey PRIMARY KEY (id),
  CONSTRAINT ticket_replies_ticket_id_tickets_id_fk FOREIGN KEY (ticket_id)
    REFERENCES public.tickets(id) ON DELETE CASCADE,
  CONSTRAINT ticket_replies_user_id_profiles_id_fk FOREIGN KEY (user_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.credit_packages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price integer NOT NULL,
  credits_amount integer NOT NULL,
  bonus_credits integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  is_popular text NOT NULL DEFAULT 'false',
  active text NOT NULL DEFAULT 'true',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_packages_pkey PRIMARY KEY (id)
);

CREATE TABLE public.invitations (
  code text NOT NULL,
  created_by uuid NOT NULL,
  used_by uuid,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_pkey PRIMARY KEY (code),
  CONSTRAINT invitations_created_by_profiles_id_fk FOREIGN KEY (created_by)
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT invitations_used_by_profiles_id_fk FOREIGN KEY (used_by)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.user_activity_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  admin_id uuid,
  action text NOT NULL,
  action_type text NOT NULL DEFAULT 'system',
  details jsonb DEFAULT '{}'::jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_activity_logs_pkey PRIMARY KEY (id),
  CONSTRAINT user_activity_logs_user_id_profiles_id_fk FOREIGN KEY (user_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT user_activity_logs_admin_id_profiles_id_fk FOREIGN KEY (admin_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.announcements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  type text NOT NULL DEFAULT 'info',
  announcement_type text NOT NULL DEFAULT 'homepage',
  banner_style text DEFAULT 'info',
  banner_link text,
  icon text DEFAULT 'Megaphone',
  icon_color text DEFAULT 'text-blue-500',
  tag text,
  tag_color text DEFAULT 'blue',
  priority integer NOT NULL DEFAULT 0,
  active text NOT NULL DEFAULT 'true',
  is_active boolean NOT NULL DEFAULT true,
  start_date timestamptz DEFAULT now(),
  end_date timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcements_pkey PRIMARY KEY (id),
  CONSTRAINT announcements_created_by_profiles_id_fk FOREIGN KEY (created_by)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.prompts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  content text NOT NULL,
  system_prompt text,
  user_prompt_template text,
  model_id uuid,
  platform text DEFAULT 'all',
  features text,
  user_questions text,
  icon text DEFAULT 'Wand2',
  category text NOT NULL DEFAULT 'general',
  is_system text NOT NULL DEFAULT 'false',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompts_pkey PRIMARY KEY (id),
  CONSTRAINT prompts_created_by_profiles_id_fk FOREIGN KEY (created_by)
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT prompts_model_id_ai_models_id_fk FOREIGN KEY (model_id)
    REFERENCES public.ai_models(id) ON DELETE SET NULL
);

CREATE TABLE public.invitation_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invite_code text NOT NULL,
  inviter_id uuid,
  inviter_email text,
  invitee_id uuid,
  invitee_email text,
  status text NOT NULL DEFAULT 'pending',
  risk_level text NOT NULL DEFAULT 'low',
  block_reason text,
  inviter_reward integer NOT NULL DEFAULT 0,
  invitee_reward integer NOT NULL DEFAULT 0,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz,
  CONSTRAINT invitation_records_pkey PRIMARY KEY (id),
  CONSTRAINT invitation_records_inviter_id_profiles_id_fk FOREIGN KEY (inviter_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT invitation_records_invitee_id_profiles_id_fk FOREIGN KEY (invitee_id)
    REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.membership_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  level text NOT NULL DEFAULT 'pro',
  monthly_price integer NOT NULL DEFAULT 990,
  yearly_price integer NOT NULL DEFAULT 9900,
  monthly_credits integer NOT NULL DEFAULT 1500,
  yearly_credits integer NOT NULL DEFAULT 20000,
  monthly_bonus_credits integer NOT NULL DEFAULT 0,
  package_discount integer NOT NULL DEFAULT 100,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  history_retention_days integer NOT NULL DEFAULT 30,
  allow_export text NOT NULL DEFAULT 'false',
  allow_batch_export text NOT NULL DEFAULT 'false',
  is_active text NOT NULL DEFAULT 'true',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_plans_pkey PRIMARY KEY (id)
);

CREATE TABLE public.modules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  full_description text,
  icon text DEFAULT 'Sparkles',
  category text NOT NULL DEFAULT 'other',
  platform text DEFAULT 'all',
  usage_count integer NOT NULL DEFAULT 0,
  credits_multiplier numeric(4,2) DEFAULT 1.00,
  sort_order integer NOT NULL DEFAULT 0,
  is_featured boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT modules_pkey PRIMARY KEY (id)
);

COMMIT;
