-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP: distinguish one-time wallets from stopped card subscriptions, and display verified async failures.
-- Owner A (2026-10-21, #1233 comment 6317202631): ordinary wallet renewals append to the paid end;
-- remaining time is retained and credits start with the new period. Founder renewal rules are unchanged.
-- Reuse existing SECURITY DEFINER ownership/row locks, orders, grants and cron. No new table/column/grant.
-- Deploy SQL first: old callers still use closed_unpaid and ignore the additional payment_method JSON field.
-- Recovery: revert application code and retain SQL; forward-fix if needed. Never remove paid terms/grants
-- or restore the old constraint once a wallet_renewal exists. No historical data is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_method_transition_check;
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_method_transition_check
  CHECK(method_transition IN ('upgrade','founder_renewal','wallet_renewal'));
DO $patch$
DECLARE source text;
  method_old constant text := $old$'payment_channel',o.payment_channel,'status','active'$old$;
  method_new constant text := $new$'payment_channel',o.payment_channel,'payment_method',o.payment_method,'status','active'$new$;
  close_old constant text := $old$IF p_state='closed_unpaid' THEN$old$;
  close_new constant text := $new$IF p_state='failed_attempt_unpaid' THEN
    IF o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_method NOT IN ('wechat_pay','alipay')
      OR coalesce(p_payment,'') !~ '^pi_[A-Za-z0-9_-]{1,160}$' OR p_amount IS DISTINCT FROM 0
      OR p_currency IS DISTINCT FROM o.currency OR p_paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'PAY_WAFFO_NOT_TERMINAL_UNPAID'; END IF;
    -- A failed attempt can still be retried on this Checkout. Keep its reservation and original identity.
    IF o.payment_status='unpaid' AND o.fulfilled_at IS NULL AND o.qualification_state='reserved'
      AND o.purchase_closed_at IS NULL THEN
      UPDATE payment_orders SET method_review_reason='wallet_payment_failed' WHERE id=o.id;
    END IF;
    RETURN o.qualification_state;
  END IF;
  IF p_state IN ('closed_unpaid','failed_unpaid') THEN$new$;
  mark_old constant text := $old$purchase_closed_at=coalesce(purchase_closed_at,clock_timestamp()) WHERE id=o.id;$old$;
  mark_new constant text := $new$purchase_closed_at=coalesce(purchase_closed_at,clock_timestamp()),
      method_review_reason=CASE WHEN p_state='failed_unpaid' THEN 'async_payment_failed' ELSE method_review_reason END WHERE id=o.id;$new$;
BEGIN
  source:=pg_get_functiondef('public.pay_common_membership_facts(uuid)'::regprocedure);
  IF position(method_new IN source)=0 THEN
    IF array_length(string_to_array(source,method_old),1)<>2 THEN RAISE EXCEPTION 'PAY_WALLET_FACTS_PATCH_MISMATCH'; END IF;
    EXECUTE replace(source,method_old,method_new);
  END IF;
  source:=pg_get_functiondef('public.pay_waffo_observe_qualification(uuid,text,text,text,text,text,integer,text,timestamptz)'::regprocedure);
  IF position(close_new IN source)=0 THEN
    IF array_length(string_to_array(source,close_old),1)<>2 OR array_length(string_to_array(source,mark_old),1)<>2 THEN
      RAISE EXCEPTION 'PAY_WALLET_FAILURE_PATCH_MISMATCH';
    END IF;
    EXECUTE replace(replace(source,close_old,close_new),mark_old,mark_new);
  ELSIF position(mark_new IN source)=0 THEN
    RAISE EXCEPTION 'PAY_WALLET_FAILURE_PATCH_MISMATCH';
  END IF;
  source:=pg_get_functiondef('public.pay_waffo_observe_qualification(uuid,text,text,text,text,text,integer,text,timestamptz)'::regprocedure);
  IF position('A verified retry clears only its failed-attempt display marker.' IN source)=0 THEN
    IF array_length(string_to_array(source,'IF o.qualification_state=''sold'' THEN RETURN ''sold''; END IF;'),1)<>2 THEN
      RAISE EXCEPTION 'PAY_WALLET_RETRY_PATCH_MISMATCH'; END IF;
    EXECUTE replace(source,'IF o.qualification_state=''sold'' THEN RETURN ''sold''; END IF;',
      $retry$-- A verified retry clears only its failed-attempt display marker.
  IF o.method_review_reason='wallet_payment_failed' THEN
    UPDATE payment_orders SET method_review_reason=NULL WHERE id=o.id;
  END IF;
  IF o.qualification_state='sold' THEN RETURN 'sold'; END IF;$retry$);
  END IF;
END $patch$;

-- Guarded text patches preserve 0328's repurchase protections and 0329's source-scoped test clocks.
DO $renewal$
DECLARE source text; row_ record;
BEGIN
 FOR row_ IN SELECT * FROM (VALUES
  ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
   $old$p_transition NOT IN ('upgrade','founder_renewal')$old$,
   $new$p_transition NOT IN ('upgrade','founder_renewal','wallet_renewal')$new$),
  ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
   $old$    ELSE
      IF p_offer<>'founder_renewal'$old$,
   $new$    ELSIF p_transition='wallet_renewal' THEN
      IF prior.payment_channel IS DISTINCT FROM 'stripe' OR prior.payment_method NOT IN ('wechat_pay','alipay')
        OR p_method NOT IN ('wechat_pay','alipay') OR prior.auto_renew IS DISTINCT FROM false
        OR old_sub.status IS DISTINCT FROM 'active' OR old_sub.credit_release_terminated_at IS NOT NULL
        OR prior.qualification_state IS DISTINCT FROM 'sold' OR prior.entitlement_end<=now()
        OR prior.offer_kind IN ('founder','founder_renewal') OR p_offer NOT IN ('standard','founder')
        OR p_cycle NOT IN ('monthly','yearly') OR NOT EXISTS(SELECT 1 FROM membership_plans
          WHERE id=p_item AND level=prior.purchase_membership_level)
        OR EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=prior.id AND freeze_state='frozen')
        OR EXISTS(SELECT 1 FROM payment_orders other WHERE other.user_id=p_user AND other.payment_mode=p_mode
          AND other.payment_status='paid' AND other.status='completed' AND other.fulfilled_at IS NOT NULL
          AND (other.purchase_membership_level=prior.purchase_membership_level AND other.entitlement_end>prior.entitlement_end
            OR prior.purchase_membership_level='pro' AND other.purchase_membership_level='gold' AND other.entitlement_end>now())) THEN
        RAISE EXCEPTION 'PAY_WAFFO_TRANSITION_DENIED'; END IF;
    ELSE
      IF p_offer<>'founder_renewal'$new$),
  ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone)',
   $old$  IF o.method_transition='founder_renewal' AND$old$,
   $new$  IF o.method_transition='wallet_renewal' THEN
   IF o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_method NOT IN ('wechat_pay','alipay')
     OR o.auto_renew IS DISTINCT FROM false OR o.offer_kind NOT IN ('standard','founder')
     OR p_start IS DISTINCT FROM (SELECT entitlement_end FROM payment_orders WHERE id=o.source_order_id)
     OR p_end<=p_paid_at THEN RAISE EXCEPTION 'PAY_WAFFO_TERM_INVALID'; END IF;
   -- Cash is authoritative, but a refunded/frozen source cannot authorize a new paid term silently.
   IF NOT EXISTS(SELECT 1 FROM payment_orders prior JOIN user_subscriptions s ON s.id=prior.subscription_id
     WHERE prior.id=o.source_order_id AND prior.user_id=o.user_id AND prior.payment_mode=o.payment_mode
       AND prior.subscription_id=o.method_prior_subscription AND prior.payment_channel='stripe'
       AND prior.payment_method IN ('wechat_pay','alipay') AND prior.auto_renew=false
       AND prior.offer_kind NOT IN ('founder','founder_renewal') AND prior.purchase_membership_level=o.purchase_membership_level
       AND prior.payment_status='paid' AND prior.status='completed' AND prior.qualification_state='sold'
       AND prior.fulfilled_at IS NOT NULL AND s.credit_release_terminated_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=prior.id AND freeze_state='frozen')) THEN
    UPDATE payment_orders SET method_review_reason='wallet_renewal_source_unavailable' WHERE id=o.id;
    RETURN jsonb_build_object('state','review','reason','wallet_renewal_source_unavailable');
   END IF;
  END IF;
  IF o.method_transition='founder_renewal' AND$new$),
  ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone)',
   $old$o.method_transition IS DISTINCT FROM 'founder_renewal' AND p_start<>p_paid_at$old$,
   $new$(o.method_transition IS NULL OR o.method_transition NOT IN ('founder_renewal','wallet_renewal')) AND p_start<>p_paid_at$new$),
  ('pay_waffo_release_due(integer)',
   $old$FOR row IN SELECT o.id FROM payment_orders o$old$,
   $new$FOR row IN SELECT o.id,o.billing_cycle FROM payment_orders o$new$),
  ('pay_waffo_release_due(integer)',
   $old$AND o.billing_cycle='yearly'$old$,
   $new$AND (o.billing_cycle='yearly' OR o.billing_cycle='monthly' AND o.method_transition='wallet_renewal')$new$),
  ('pay_waffo_release_due(integer)',
   $old$generate_series(1,12) idx$old$,
   $new$generate_series(1,CASE o.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END) idx$new$),
  ('pay_waffo_release_due(integer)',
   $old$g.source_order_id=o.id AND g.period_index=idx$old$,
   $new$g.source_order_id=o.id AND (g.period_index=idx OR o.billing_cycle='monthly'
       AND g.grant_period_key='payment:'||o.id::text||':01')$new$),
  ('pay_waffo_release_due(integer)',
   $old$FOR i IN 1..12 LOOP$old$,
   $new$FOR i IN 1..CASE row.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END LOOP$new$),
  ('pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
   $old$IF total IS NULL OR total<=0$old$,
   $new$IF total IS NULL OR total<0 OR total=0 AND (
     o.item_type IS DISTINCT FROM 'membership_plan' OR o.method_transition IS DISTINCT FROM 'wallet_renewal'
     OR o.entitlement_start IS NULL OR o.entitlement_start<=clock_timestamp()
     OR EXISTS(SELECT 1 FROM subscription_credit_grants WHERE source_order_id=o.id)
     OR EXISTS(SELECT 1 FROM credit_transactions WHERE source_order_id=o.id AND amount<>0))$new$)
 ) AS patches(signature,old_,new_) LOOP
  source:=pg_get_functiondef(('public.'||row_.signature)::regprocedure);
  IF position(row_.new_ IN source)=0 THEN
   IF array_length(string_to_array(source,row_.old_),1)<>2 THEN
    RAISE EXCEPTION 'PAY_WALLET_RENEWAL_PATCH_MISMATCH: % / %',row_.signature,row_.old_; END IF;
   EXECUTE replace(source,row_.old_,row_.new_);
  END IF;
 END LOOP;
END $renewal$;
COMMIT;
