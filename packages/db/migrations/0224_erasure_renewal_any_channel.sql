-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: the "cancel auto-renewal first" block (E4, Owner 2026-09-30) applies to every payment
-- channel. 0147/0194 only counted rows with a Stripe subscription id, but Waffo (0211) and Stripe
-- Managed Payments / mainland card subscriptions leave stripe_subscription_id NULL.
-- Channel-neutral rule: an active-like subscription renews until its own stop-renewal fact,
-- cancel_at_period_end, is 'true'. Every channel writes it: Stripe webhooks sync it, Waffo inserts
-- 'false' only for auto_renew orders and sets 'true' only on a confirmed cancel, and non-renewing
-- purchases are inserted with 'true'. A requested but unconfirmed cancel still blocks (as in 0194).
-- Order-level auto_renew is frozen at purchase and never flips on cancel, so it cannot clear a block.
-- Reads no column added after 0211; correct whether merged before or after other payment migrations.
-- Same signatures, so account_erasure_confirm and account_erasure_financial_proof pick this up.
BEGIN;

CREATE OR REPLACE FUNCTION public.account_erasure_renewing(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_profile_id
  AND lower(s.status) IN ('active','trialing','past_due','incomplete','unpaid','paused')
  AND s.cancel_at_period_end::text IS DISTINCT FROM 'true');
$$;

-- Where each renewing subscription is cancelled, without exposing provider ids. A legacy Stripe
-- subscription id means the Stripe customer portal; otherwise the subscription's own channel.
CREATE OR REPLACE FUNCTION public.account_erasure_renewal_channels(p_profile_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(DISTINCT CASE WHEN s.stripe_subscription_id IS NOT NULL THEN 'stripe_portal'
   WHEN s.payment_channel IN ('stripe','waffo') THEN s.payment_channel ELSE 'other' END),'[]'::jsonb)
 FROM user_subscriptions s WHERE s.user_id=p_profile_id
  AND lower(s.status) IN ('active','trialing','past_due','incomplete','unpaid','paused')
  AND s.cancel_at_period_end::text IS DISTINCT FROM 'true';
$$;

-- Same keys as 0147 plus renewalChannels; paid access end now covers every channel.
CREATE OR REPLACE FUNCTION public.account_erasure_preview(p_profile_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'credits', coalesce((SELECT p.credits FROM public.profiles p WHERE p.id = p_profile_id), 0),
    'subscriptionRenewing', public.account_erasure_renewing(p_profile_id),
    'renewalChannels', public.account_erasure_renewal_channels(p_profile_id),
    'subscriptionActiveUntil', (
      SELECT max(s.current_period_end) FROM public.user_subscriptions s
      WHERE s.user_id = p_profile_id
        AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')),
    'pendingPayments', (SELECT count(*) FROM public.payment_orders o
      WHERE o.user_id = p_profile_id AND o.status = 'pending'),
    'runsInFlight', (SELECT count(*) FROM public.bill2_runs r
      WHERE r.actor_id = p_profile_id AND r.state IN ('prepared', 'dispatched', 'unknown', 'cost_pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id)
  );
$$;

REVOKE ALL ON FUNCTION public.account_erasure_renewing(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_erasure_renewal_channels(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.account_erasure_preview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_preview(uuid) TO service_role;
COMMIT;
