-- Migration: Stripe hosted checkout and subscription persistence
-- Description: Adds Stripe price ID columns plus payment order/subscription tables

ALTER TABLE credit_packages
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS stripe_monthly_price_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_yearly_price_id TEXT;

CREATE TABLE IF NOT EXISTS payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('credit_package', 'membership_plan')),
  item_id UUID NOT NULL,
  billing_cycle TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_cycle IN ('one_time', 'monthly', 'yearly')),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_invoice_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  amount_total INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',
  mode TEXT NOT NULL CHECK (mode IN ('payment', 'subscription')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  payment_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fulfilled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  membership_plan_id UUID REFERENCES membership_plans(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_price_id TEXT,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  status TEXT NOT NULL,
  cancel_at_period_end TEXT NOT NULL DEFAULT 'false',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_subscription_id ON payment_orders(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_payment_orders_select" ON payment_orders;
CREATE POLICY "users_own_payment_orders_select"
  ON payment_orders
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_all_payment_orders" ON payment_orders;
CREATE POLICY "admin_all_payment_orders"
  ON payment_orders
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "users_own_user_subscriptions_select" ON user_subscriptions;
CREATE POLICY "users_own_user_subscriptions_select"
  ON user_subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_all_user_subscriptions" ON user_subscriptions;
CREATE POLICY "admin_all_user_subscriptions"
  ON user_subscriptions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

COMMENT ON COLUMN credit_packages.stripe_price_id IS 'Stripe test/live Price ID for one-time package checkout';
COMMENT ON COLUMN membership_plans.stripe_monthly_price_id IS 'Stripe Price ID for monthly subscription checkout';
COMMENT ON COLUMN membership_plans.stripe_yearly_price_id IS 'Stripe Price ID for yearly subscription checkout';
COMMENT ON TABLE payment_orders IS 'Stripe checkout/invoice fulfillment ledger with idempotent order state';
COMMENT ON TABLE user_subscriptions IS 'Current and historical Stripe-backed user subscription records';
