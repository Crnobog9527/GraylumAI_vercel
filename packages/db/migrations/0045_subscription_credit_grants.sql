/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: subscription_credit_grants
-- Description:
--   Adds an idempotent subscription credit release ledger for monthly invoice
--   grants and annual monthly release grants. Source only: do not apply to
--   staging or production without explicit owner approval.

CREATE TABLE IF NOT EXISTS public.subscription_credit_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  membership_plan_id UUID REFERENCES public.membership_plans(id) ON DELETE SET NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_invoice_id TEXT,
  billing_cycle TEXT NOT NULL,
  grant_type TEXT NOT NULL,
  grant_period_key TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  period_index INTEGER,
  total_periods INTEGER,
  credits_granted INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  idempotency_key TEXT NOT NULL,
  credit_transaction_id UUID REFERENCES public.credit_transactions(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.subscription_credit_grants
  DROP CONSTRAINT IF EXISTS subscription_credit_grants_billing_cycle_check;

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_billing_cycle_check
  CHECK (billing_cycle IN ('monthly', 'yearly'));

ALTER TABLE public.subscription_credit_grants
  DROP CONSTRAINT IF EXISTS subscription_credit_grants_grant_type_check;

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_grant_type_check
  CHECK (grant_type IN ('monthly_invoice', 'annual_monthly_release', 'upgrade', 'manual', 'reversal'));

ALTER TABLE public.subscription_credit_grants
  DROP CONSTRAINT IF EXISTS subscription_credit_grants_status_check;

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_status_check
  CHECK (status IN ('granted', 'skipped', 'reversed', 'failed'));

ALTER TABLE public.subscription_credit_grants
  DROP CONSTRAINT IF EXISTS subscription_credit_grants_period_index_check;

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_period_index_check
  CHECK (
    period_index IS NULL
    OR (
      total_periods IS NOT NULL
      AND period_index >= 1
      AND period_index <= total_periods
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS subscription_credit_grants_idempotency_key_key
  ON public.subscription_credit_grants(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_subscription_credit_grants_user_time
  ON public.subscription_credit_grants(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_credit_grants_subscription_period
  ON public.subscription_credit_grants(stripe_subscription_id, grant_period_key);

CREATE INDEX IF NOT EXISTS idx_subscription_credit_grants_invoice
  ON public.subscription_credit_grants(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

ALTER TABLE public.subscription_credit_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_subscription_credit_grants_select" ON public.subscription_credit_grants;
CREATE POLICY "users_own_subscription_credit_grants_select"
  ON public.subscription_credit_grants
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_all_subscription_credit_grants" ON public.subscription_credit_grants;
CREATE POLICY "admin_all_subscription_credit_grants"
  ON public.subscription_credit_grants
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

COMMENT ON TABLE public.subscription_credit_grants
  IS 'Billing Engine v1.5 idempotent ledger for subscription credit releases, including annual monthly releases.';

COMMENT ON COLUMN public.subscription_credit_grants.grant_period_key
  IS 'Stable release period key, for example invoice:in_xxx or sub_xxx:YYYY-MM:NN.';

COMMENT ON COLUMN public.subscription_credit_grants.idempotency_key
  IS 'Unique key preventing duplicate subscription credit release from webhook or scheduled catch-up.';

COMMENT ON COLUMN public.subscription_credit_grants.credit_transaction_id
  IS 'Matching credit_transactions row written with ledger_type=grant and counts_as_spend=false.';
