-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-WAFFO: 24-hour renewal grace for still-renewing Waffo card subscriptions (Owner 2026-10-12, PR #823).
-- Only pay_common_membership_facts changes: membership access is kept, no credits are granted and no
-- order, subscription or ledger row is written. Same signature, owner and grants; repeatable.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.pay_common_membership_facts(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE subscriptions jsonb; latest_order jsonb; internal_member jsonb; last_paid timestamptz; manual_member user_subscriptions;
BEGIN
  IF p_user_id IS NULL OR (current_setting('role',true) IS DISTINCT FROM 'service_role'
    AND auth.uid() IS DISTINCT FROM p_user_id AND NOT EXISTS(SELECT 1 FROM profiles
      WHERE id=auth.uid() AND role='admin' AND status='active' AND is_deleted='false')) THEN
    RAISE EXCEPTION 'PAY_COMMON_FACTS_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO subscriptions FROM (
    SELECT s.id,s.membership_plan_id,s.status,s.cancel_at_period_end,s.billing_cycle,s.current_period_end,s.metadata,
      s.payment_channel,
      CASE WHEN s.payment_channel IS NULL AND s.stripe_subscription_id IS NULL THEN 'none'
        WHEN s.payment_channel='stripe' AND (SELECT count(*) FROM payment_provider_refs r
          WHERE r.subscription_id=s.id AND r.channel=s.payment_channel AND r.merchant_namespace=s.merchant_namespace
            AND r.mode=s.payment_mode AND r.object_type='subscription')=1 THEN 'mapped'
        ELSE 'unknown' END AS mapping_state
    FROM user_subscriptions s WHERE user_id=p_user_id AND NOT EXISTS(
      SELECT 1 FROM payment_orders o WHERE o.subscription_id=s.id AND o.user_id=s.user_id
        AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL)
      ORDER BY updated_at DESC LIMIT 10
  ) x;
  SELECT jsonb_build_object('id',id,'status',status,'payment_status',payment_status,'metadata',metadata)
    INTO latest_order FROM payment_orders WHERE user_id=p_user_id AND item_type='membership_plan'
    ORDER BY updated_at DESC LIMIT 1;
  -- Internal paid orders are the authority, not the cached profile or the provider's
  -- current period. Future founder renewals and old Pro grants cannot hide a paid Gold period.
  SELECT max(o.fulfilled_at) INTO last_paid FROM payment_orders o
    WHERE o.user_id=p_user_id AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL
      AND o.fulfilled_at IS NOT NULL;
  SELECT * INTO manual_member FROM user_subscriptions s WHERE s.user_id=p_user_id
    AND s.status='admin_override' AND s.metadata ? 'adminOverride' AND s.updated_at>=last_paid
    ORDER BY s.updated_at DESC LIMIT 1;
  IF manual_member.id IS NOT NULL THEN
    subscriptions:=jsonb_build_array(jsonb_build_object('id',manual_member.id,'membership_plan_id',manual_member.membership_plan_id,
      'status','admin_override','mapping_state','none','payment_channel',NULL,'metadata',manual_member.metadata));
  ELSIF last_paid IS NOT NULL THEN
    SELECT jsonb_build_object('id',s.id,'membership_plan_id',s.membership_plan_id,
      'membership_level',o.purchase_membership_level,'mapping_state','internal_paid',
      'payment_channel',o.payment_channel,'status','active','cancel_at_period_end',s.cancel_at_period_end,
      'billing_cycle',o.billing_cycle,'current_period_end',o.entitlement_end,
      'renewal_grace_until',CASE WHEN o.entitlement_end<=now() THEN o.entitlement_end+interval '24 hours' END) INTO internal_member
    FROM payment_orders o JOIN user_subscriptions s ON s.id=o.subscription_id AND s.user_id=o.user_id
      JOIN membership_plans p ON p.id=o.item_id AND p.id=s.membership_plan_id AND p.level=o.purchase_membership_level
      JOIN profiles actor ON actor.id=o.user_id
    WHERE o.user_id=p_user_id AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL
      AND o.payment_channel IN ('stripe','waffo') AND o.payment_mode='test'
      AND s.payment_channel=o.payment_channel AND s.payment_mode=o.payment_mode AND s.merchant_namespace=o.merchant_namespace
      AND s.stripe_subscription_id IS NULL AND s.credit_release_terminated_at IS NULL
      AND o.fulfilled_at IS NOT NULL AND o.status='completed' AND o.payment_status='paid'
      AND o.qualification_state='sold' AND o.method_review_reason IS NULL
      AND o.purchase_membership_level IN ('pro','gold')
      AND o.entitlement_start<=now() AND (o.entitlement_end>now()
        -- PAY_WAFFO_RENEWAL_GRACE (Owner 2026-10-12): a card renewal is charged at the period end and
        -- its webhook (or the daily reconciliation) may land later. Keep membership access, never
        -- credits, for 24 hours after the latest paid term of a still-renewing Waffo card subscription.
        -- A stopped or stop-requested subscription ends exactly at the paid end.
        OR o.entitlement_end>now()-interval '24 hours' AND o.payment_channel='waffo' AND o.payment_method='card'
          AND o.auto_renew AND s.status='active' AND s.cancel_at_period_end='false'
          AND s.method_cancel_requested_at IS NULL AND s.method_cancel_confirmed_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM payment_orders later WHERE later.subscription_id=o.subscription_id
            AND later.id<>o.id AND later.entitlement_end>o.entitlement_end))
      AND actor.status='active' AND actor.is_deleted='false'
      AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=actor.id)
      AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(o.metadata,'{}')) part
        WHERE part.key IN ('stripeRefundReconciliation','subscriptionCreditGrantReversal','refundReconciliation','refund')
          AND (part.value->>'isFullRefund'='true' OR part.value->>'fullRefund'='true'
            OR part.value->>'reviewRequired'='true' OR part.value->>'refundType'='full'))
      AND coalesce(o.refund_approval->>'status','') NOT IN ('dispatching','pending','succeeded','review_required')
      AND EXISTS(SELECT 1 FROM payment_provider_refs ref WHERE ref.order_id=o.id AND ref.object_type='payment'
        AND ref.channel=o.payment_channel AND ref.mode=o.payment_mode AND ref.merchant_namespace=o.merchant_namespace)
    ORDER BY CASE o.purchase_membership_level WHEN 'gold' THEN 2 ELSE 1 END DESC,o.entitlement_end DESC,o.id LIMIT 1;
    IF internal_member IS NULL THEN
      SELECT jsonb_build_object('id',o.subscription_id,'mapping_state','internal_inactive','membership_level','free')
        INTO internal_member FROM payment_orders o WHERE o.user_id=p_user_id AND o.item_type='membership_plan'
          AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL ORDER BY o.fulfilled_at DESC,o.id LIMIT 1;
    END IF;
    -- An unrelated legacy subscription remains a conflict instead of silently overriding it.
    IF EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_user_id AND s.stripe_subscription_id IS NOT NULL
      AND s.status IN ('active','trialing','past_due','incomplete','unpaid')) THEN
      internal_member:=jsonb_build_object('mapping_state','unknown','membership_level','free');
    END IF;
  END IF;
  RETURN jsonb_build_object('subscriptions',subscriptions,'latest_order',latest_order,'internal_membership',internal_member);
END $fn$;
COMMIT;
