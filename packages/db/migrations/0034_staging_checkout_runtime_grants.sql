-- Migration: staging checkout runtime grants
-- Description: Restores the minimum runtime grants and own-row policies needed
-- for staging Stripe checkout and public module reads without exposing module
-- prompt internals.

GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_orders TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_subscriptions TO service_role;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM anon, authenticated;
REVOKE SELECT ON TABLE public.payment_orders FROM anon;
REVOKE SELECT ON TABLE public.user_subscriptions FROM anon;

GRANT SELECT ON TABLE public.payment_orders TO authenticated;
GRANT SELECT ON TABLE public.user_subscriptions TO authenticated;

DROP POLICY IF EXISTS "users_own_payment_orders_select" ON public.payment_orders;
CREATE POLICY "users_own_payment_orders_select"
  ON public.payment_orders
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_own_user_subscriptions_select" ON public.user_subscriptions;
CREATE POLICY "users_own_user_subscriptions_select"
  ON public.user_subscriptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE SELECT ON TABLE public.modules FROM anon, authenticated;
GRANT SELECT (
  id,
  title,
  description,
  full_description,
  icon,
  category,
  platform,
  features,
  examples,
  preparation_questions,
  usage_count,
  credits_multiplier,
  sort_order,
  is_featured,
  active,
  created_at,
  updated_at
) ON TABLE public.modules TO anon, authenticated;
