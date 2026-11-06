-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Emergency restore of the pre-0224 definitions (0194 renewing, 0147 preview). Function-only change:
-- no data is written by 0224, so nothing else needs restoring. Restoring re-opens the Waffo/MP gap.
-- Order matters: the preview must stop calling the helper before the helper is dropped.
BEGIN;
CREATE OR REPLACE FUNCTION public.account_erasure_renewing(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_profile_id AND s.stripe_subscription_id IS NOT NULL
 AND lower(s.status) IN ('active','trialing','past_due','incomplete','unpaid','paused')
 AND s.cancel_at_period_end::text IS DISTINCT FROM 'true');
$$;
CREATE OR REPLACE FUNCTION public.account_erasure_preview(p_profile_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'credits', coalesce((SELECT p.credits FROM public.profiles p WHERE p.id = p_profile_id), 0),
    'subscriptionRenewing', public.account_erasure_renewing(p_profile_id),
    'subscriptionActiveUntil', (
      SELECT max(s.current_period_end) FROM public.user_subscriptions s
      WHERE s.user_id = p_profile_id AND s.stripe_subscription_id IS NOT NULL
        AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid')),
    'pendingPayments', (SELECT count(*) FROM public.payment_orders o
      WHERE o.user_id = p_profile_id AND o.status = 'pending'),
    -- CORE-PATH-V2 V2-12 F: bill2_runs is gone; the turns still open or settling are the money in flight (as the current preview counts them).
    'runsInFlight', (SELECT count(*) FROM public.turns t WHERE t.actor_id = p_profile_id AND (t.state <> 'closed' OR t.settlement = 'pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id)
  );
$$;
DROP FUNCTION IF EXISTS public.account_erasure_renewal_channels(uuid);
COMMIT;
