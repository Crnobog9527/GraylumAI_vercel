-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP: a paid Pro -> Gold upgrade deliberately retains both credit sources.
-- Reuse the authoritative paid-membership projection and the existing source allocator.
-- No balance, grant, subscription or order data is rewritten. Database-first compatible.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE src text;anchor text;replacement text;
BEGIN
 src:=pg_get_functiondef('public.atomic_pre_deduct(uuid,integer,text,uuid)'::regprocedure);
 IF position('-- PAY-STRIPE-MP upgrade overlap' IN src)=0 THEN
  anchor:='  v_pre_deduct_id UUID;';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_UPGRADE_RESERVE_DECLARATION_MISMATCH'; END IF;
  src:=replace(src,anchor,anchor||E'\n  v_effective_subscription_id UUID;\n  v_effective_membership JSONB;');
  anchor:=$old$  IF v_covering_count > 1 OR v_canonical_candidate_count > 1 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: %',
      GREATEST(v_covering_count, v_canonical_candidate_count);
  END IF;$old$;
  replacement:=$new$  -- PAY-STRIPE-MP upgrade overlap: allow only the paid upgrade's exact prior subscription.
  -- The census still validates EVERY current source. Malformed, frozen, terminated,
  -- untrusted and unrelated duplicate sources retain their existing protections.
  IF v_covering_count > 1 OR v_canonical_candidate_count > 1 THEN
    v_effective_membership := pay_common_membership_facts(p_user_id)->'internal_membership';
    IF v_effective_membership->>'mapping_state'='internal_paid' THEN
      v_effective_subscription_id := (v_effective_membership->>'id')::uuid;
    END IF;
    IF v_covering_count<>2 OR v_canonical_candidate_count<>2 OR NOT EXISTS (
      SELECT 1 FROM payment_orders upgrade
      JOIN user_subscriptions prior ON prior.id=upgrade.method_prior_subscription AND prior.user_id=upgrade.user_id
      JOIN subscription_credit_grants old_grant ON old_grant.subscription_id=prior.id AND old_grant.user_id=prior.user_id
      JOIN subscription_credit_grants new_grant ON new_grant.subscription_id=upgrade.subscription_id
        AND new_grant.user_id=upgrade.user_id
      WHERE upgrade.user_id=p_user_id AND upgrade.subscription_id=v_effective_subscription_id
        AND upgrade.method_transition='upgrade' AND upgrade.purchase_membership_level='gold'
        AND upgrade.status='completed' AND upgrade.payment_status='paid' AND upgrade.fulfilled_at IS NOT NULL
        AND upgrade.method_review_reason IS NULL AND NOT pay_dispute_order_frozen(upgrade.id)
        AND (prior.cancel_at_period_end='true' OR prior.method_cancel_requested_at IS NOT NULL)
        AND old_grant.stripe_subscription_id IS NULL AND new_grant.stripe_subscription_id IS NULL
        AND old_grant.status='granted' AND new_grant.status='granted'
        AND old_grant.accounting_state='trusted' AND new_grant.accounting_state='trusted'
        AND NOT old_grant.dispute_frozen AND NOT new_grant.dispute_frozen
        AND old_grant.period_start<=now() AND old_grant.period_end>now()
        AND new_grant.period_start<=now() AND new_grant.period_end>now()
    ) THEN
      RAISE EXCEPTION 'PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: %',
        GREATEST(v_covering_count, v_canonical_candidate_count);
    END IF;
  END IF;$new$;
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_UPGRADE_RESERVE_CENSUS_MISMATCH'; END IF;
  src:=replace(src,anchor,replacement);
  anchor:='  FOR UPDATE OF g;';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_UPGRADE_RESERVE_SELECTION_MISMATCH'; END IF;
  src:=replace(src,anchor,$selection$    AND (v_effective_subscription_id IS NULL OR g.subscription_id=v_effective_subscription_id)
  FOR UPDATE OF g;$selection$);
  EXECUTE src;
 END IF;

 -- The newly selected primary grant has an internal subscription id. Settlement already
 -- understands that id; confirmed-delivery-failure compensation must use the same binding.
 src:=pg_get_functiondef('public.bill2_payg_compensate(bill2_runs,bill2_calls)'::regprocedure);
 IF position('-- PAY-STRIPE-MP internal compensation' IN src)=0 THEN
  anchor:='us.stripe_subscription_id=cg.stripe_subscription_id';
  replacement:='(us.id=cg.subscription_id OR (cg.subscription_id IS NULL AND us.stripe_subscription_id=cg.stripe_subscription_id))';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_UPGRADE_COMPENSATION_MISMATCH'; END IF;
  src:=replace(src,anchor,replacement);
  EXECUTE replace(src,'BEGIN',E'BEGIN\n -- PAY-STRIPE-MP internal compensation');
 END IF;

 -- A supported Gold refund restores the still-paid Pro. The authoritative projection
 -- already excludes the refunded Gold; its latest-order status must not erase Pro's cap.
 src:=pg_get_functiondef('public.opc_start_b1(uuid,uuid,text,text,uuid,text,text)'::regprocedure);
 IF position('-- PAY-STRIPE-MP authoritative cap' IN src)=0 THEN
  anchor:=$old$  IF lower(coalesce(latest_order->>'status','')) IN ('refunded','partially_refunded','partial_refunded')$old$;
  replacement:=$new$  -- PAY-STRIPE-MP authoritative cap: paid fallback already excludes refunded sources.
  IF internal_member->>'mapping_state' IS DISTINCT FROM 'internal_paid' AND (
    lower(coalesce(latest_order->>'status','')) IN ('refunded','partially_refunded','partial_refunded')$new$;
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_UPGRADE_CAP_REFUND_MISMATCH'; END IF;
  src:=replace(src,anchor,replacement);
  anchor:=E'    ) THEN\n    effective_level := ''free'';\n  END IF;\n\n  SELECT id,positioning_profile_limit';
  replacement:=E'    )) THEN\n    effective_level := ''free'';\n  END IF;\n\n  SELECT id,positioning_profile_limit';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_UPGRADE_CAP_BOUNDARY_MISMATCH'; END IF;
  EXECUTE replace(src,anchor,replacement);
 END IF;
END $patch$;
COMMIT;
