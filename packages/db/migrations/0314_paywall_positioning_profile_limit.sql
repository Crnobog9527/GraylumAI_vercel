-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAYWALL: enforce the published positioning-profile caps in the existing OPC
-- start transaction. Count businesses directly; archived work items do not
-- release profile slots and this migration adds no archive/delete behavior.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.membership_plans
    WHERE level IS NULL OR level NOT IN ('free','pro','gold'))
    OR EXISTS (SELECT 1 FROM public.membership_plans GROUP BY level HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PAYWALL_PROFILE_LIMIT_PLAN_CONFIGURATION_REQUIRES_REVIEW';
  END IF;
END $$;

ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS positioning_profile_limit integer;

UPDATE public.membership_plans
SET positioning_profile_limit = COALESCE(positioning_profile_limit,
  CASE level WHEN 'free' THEN 1 WHEN 'pro' THEN 3 WHEN 'gold' THEN 6 END)
WHERE positioning_profile_limit IS NULL;

-- During database-first rollout, old application versions may still insert a
-- plan without the new column. Fill the per-tier default before NOT NULL checks.
CREATE OR REPLACE FUNCTION public.membership_plans_positioning_profile_limit_default()
RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.positioning_profile_limit IS NULL THEN
    NEW.positioning_profile_limit := CASE NEW.level
      WHEN 'free' THEN 1 WHEN 'pro' THEN 3 WHEN 'gold' THEN 6 ELSE NULL END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_membership_plans_positioning_profile_limit_default ON public.membership_plans;
CREATE TRIGGER trg_membership_plans_positioning_profile_limit_default
BEFORE INSERT ON public.membership_plans
FOR EACH ROW EXECUTE FUNCTION public.membership_plans_positioning_profile_limit_default();

ALTER TABLE public.membership_plans
  ALTER COLUMN positioning_profile_limit SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.membership_plans'::regclass
      AND conname = 'membership_plans_positioning_profile_limit_check') THEN
    ALTER TABLE public.membership_plans
      ADD CONSTRAINT membership_plans_positioning_profile_limit_check
      CHECK (positioning_profile_limit BETWEEN 1 AND 1000);
  END IF;
END $$;

-- The old six-argument function must not remain as a cap-bypassing overload.
-- Recreate the same entry point with a server-owned effective membership tier;
-- internal account-strategy callers keep working through the default value.
DROP FUNCTION IF EXISTS public.opc_start_b1(uuid,uuid,text,text,uuid,text);
DROP FUNCTION IF EXISTS public.opc_start_b1(uuid,uuid,text,text,uuid,text,text);

CREATE FUNCTION public.opc_start_b1(
  p_actor_id uuid,
  p_request_id uuid,
  p_registration text,
  p_mode text,
  p_business_id uuid DEFAULT NULL,
  p_business_name text DEFAULT NULL,
  p_membership_level text DEFAULT 'free'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  result jsonb;
  d opc_drafts;
  b opc_businesses;
  mapping opc_draft_businesses;
  actor profiles;
  membership_facts jsonb;
  internal_member jsonb;
  subscriptions jsonb;
  latest_order jsonb;
  order_metadata jsonb;
  requested_name text := trim(coalesce(p_business_name,''));
  effective_level text;
  plan_id uuid;
  plan_limit integer;
  active_business_count integer;
  uncertain_subscription boolean;
  duplicate_active_subscriptions boolean;
  payment_attention boolean;
  expired_cancellation boolean;
  canceled_subscription_without_active boolean;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_request_id IS NULL OR p_membership_level NOT IN ('free','pro','gold') THEN
    RAISE EXCEPTION 'OPC_INPUT';
  END IF;

  -- This per-actor row lock serializes new profile starts and membership-level
  -- settlement. Every count and insert below observes the same transaction.
  SELECT * INTO actor FROM profiles WHERE id=p_actor_id FOR UPDATE;
  IF actor.id IS NULL OR actor.status IS DISTINCT FROM 'active'
    OR actor.is_deleted::text IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'OPC_DENIED';
  END IF;

  IF p_business_id IS NOT NULL THEN
    SELECT * INTO b FROM opc_businesses
      WHERE id=p_business_id AND actor_id=p_actor_id FOR SHARE;
    IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED'; END IF;
  ELSIF char_length(requested_name) NOT BETWEEN 1 AND 120 THEN
    requested_name := '未命名业务';
  END IF;

  -- Never trust a cached profile tier or a stale app read to raise the cap.
  effective_level := CASE
    WHEN p_membership_level='gold' AND actor.membership_level='gold' THEN 'gold'
    WHEN p_membership_level IN ('pro','gold') AND actor.membership_level IN ('pro','gold') THEN 'pro'
    ELSE 'free' END;

  -- Recheck the authoritative payment projection after taking the actor lock.
  -- In particular, an ended internal membership is internal_inactive even if
  -- the cached profiles.membership_level has not yet been settled to free.
  membership_facts := pay_common_membership_facts(p_actor_id);
  internal_member := membership_facts->'internal_membership';
  IF internal_member->>'mapping_state'='internal_inactive'
    OR (internal_member ? 'mapping_state'
      AND internal_member->>'mapping_state' NOT IN ('internal_paid','internal_inactive')) THEN
    effective_level := 'free';
  ELSIF internal_member->>'mapping_state'='internal_paid' THEN
    effective_level := CASE WHEN internal_member->>'membership_level' IN ('pro','gold')
      THEN internal_member->>'membership_level' ELSE 'free' END;
  END IF;

  subscriptions := coalesce(membership_facts->'subscriptions','[]'::jsonb);
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(subscriptions) AS candidate(value)
    WHERE candidate.value->>'mapping_state' IS NOT NULL
      AND candidate.value->>'mapping_state' NOT IN ('none','mapped')
  ) INTO uncertain_subscription;
  SELECT count(*) > 1 FROM jsonb_array_elements(subscriptions) AS candidate(value)
  WHERE candidate.value->>'payment_channel'='stripe'
    AND candidate.value->>'mapping_state'='mapped'
    AND lower(coalesce(candidate.value->>'status',''))
      IN ('active','trialing','past_due','incomplete','unpaid')
  INTO duplicate_active_subscriptions;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(subscriptions) AS candidate(value)
    WHERE candidate.value->>'payment_channel'='stripe'
      AND candidate.value->>'mapping_state'='mapped'
      AND lower(coalesce(candidate.value->>'status','')) IN ('past_due','incomplete','unpaid')
  ) INTO payment_attention;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(subscriptions) AS candidate(value)
    WHERE candidate.value->>'payment_channel'='stripe'
      AND candidate.value->>'mapping_state'='mapped'
      AND lower(coalesce(candidate.value->>'status','')) IN ('active','trialing')
      AND lower(coalesce(candidate.value->>'cancel_at_period_end','false'))='true'
      AND candidate.value->>'current_period_end' IS NOT NULL
      AND (candidate.value->>'current_period_end')::timestamptz<=now()
  ) INTO expired_cancellation;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(subscriptions) AS candidate(value)
    WHERE candidate.value->>'payment_channel'='stripe'
      AND candidate.value->>'mapping_state'='mapped'
      AND lower(coalesce(candidate.value->>'status','')) IN ('canceled','cancelled')
  ) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(subscriptions) AS candidate(value)
    WHERE candidate.value->>'payment_channel'='stripe'
      AND candidate.value->>'mapping_state'='mapped'
      AND lower(coalesce(candidate.value->>'status',''))
        IN ('active','trialing','past_due','incomplete','unpaid')
  ) INTO canceled_subscription_without_active;
  IF uncertain_subscription OR duplicate_active_subscriptions
    OR payment_attention OR expired_cancellation
    OR (canceled_subscription_without_active AND actor.membership_level<>'free') THEN
    effective_level := 'free';
  END IF;

  latest_order := membership_facts->'latest_order';
  order_metadata := coalesce(latest_order->'metadata','{}'::jsonb);
  IF lower(coalesce(latest_order->>'status','')) IN ('refunded','partially_refunded','partial_refunded')
    OR lower(coalesce(latest_order->>'payment_status','')) IN ('refunded','partially_refunded','partial_refunded')
    OR EXISTS (
      SELECT 1 FROM jsonb_each(order_metadata) AS part(key,value)
      WHERE part.key IN ('stripeRefundReconciliation','subscriptionCreditGrantReversal','refundReconciliation','refund')
        AND (part.value->>'isFullRefund'='true' OR part.value->>'fullRefund'='true'
          OR part.value->>'reviewRequired'='true' OR part.value->>'refundType'='full')
    ) THEN
    effective_level := 'free';
  END IF;

  SELECT id,positioning_profile_limit INTO plan_id,plan_limit
  FROM membership_plans WHERE level=effective_level FOR SHARE;
  IF plan_id IS NULL OR plan_limit IS NULL OR plan_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OPC_PROFILE_LIMIT_UNAVAILABLE';
  END IF;

  -- A mapped request replay keeps its original business even if the account is
  -- now over its lower tier limit. Only a genuinely new business consumes a slot.
  IF p_business_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM opc_drafts existing
    JOIN opc_draft_businesses existing_business ON existing_business.draft_id=existing.draft_id
    WHERE existing.actor_id=p_actor_id AND existing.request_id=p_request_id
  ) THEN
    SELECT count(*)::integer INTO active_business_count
    FROM opc_businesses business
    WHERE business.actor_id=p_actor_id AND business.erased_at IS NULL;
    IF active_business_count>=plan_limit THEN
      RAISE EXCEPTION 'OPC_PROFILE_LIMIT';
    END IF;
  END IF;

  result := opc_start(p_actor_id,p_request_id,p_registration,p_mode);
  SELECT * INTO d FROM opc_drafts
    WHERE draft_id=(result->>'draftId')::uuid AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO mapping FROM opc_draft_businesses WHERE draft_id=d.draft_id;
  IF mapping.business_id IS NOT NULL THEN
    IF p_business_id IS NOT NULL AND mapping.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';
    END IF;
    SELECT * INTO b FROM opc_businesses WHERE id=mapping.business_id;
  ELSE
    IF p_business_id IS NULL THEN
      INSERT INTO opc_businesses(actor_id,name) VALUES(p_actor_id,requested_name) RETURNING * INTO b;
    END IF;
    INSERT INTO opc_draft_businesses VALUES(d.draft_id,b.id);
  END IF;

  RETURN result||jsonb_build_object('businessId',b.id,'businessName',b.name);
END $$;

REVOKE ALL ON FUNCTION public.opc_start_b1(uuid,uuid,text,text,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_start_b1(uuid,uuid,text,text,uuid,text,text) TO service_role;

COMMIT;
