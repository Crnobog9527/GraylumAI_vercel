-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CHARGEBACK G2: withdrawing a dispute hold (won) re-releases the paused monthly credits (Owner 2026-11-14, MASTER_PLAN 2.1;
-- record AD). Number 0537 assigned by the controller (renumbered from 0531); applies after 0530.
-- While a dispute holds an order, pay_waffo_grant_period returns 0, so periods that come due are skipped. Until now they
-- only came back on a later maintenance run, if at all within its batch. pay_dispute_withdraw (whole definition from
-- packages/db/functions/pay/ after 0530) now calls pay_waffo_grant_period for every period of a membership order as soon as
-- no dispute holds it any more. Each period keeps its original key, start and end (idempotent per period, never past
-- entitlement_end, never before its start); membership term and dates are unchanged. The result adds backfilled,
-- userId, orderId and status so the caller can send the "please resubscribe" email for a won dispute.
-- Compatibility: old code reads only restored/duplicate, which are unchanged; the extra keys are ignored.
-- Repeatable: CREATE OR REPLACE only. Recovery: re-apply the 0530 definition from packages/db/functions/ (credits already
--   backfilled are ordinary grants that the next maintenance run would have made anyway; nothing to undo).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_dispute_withdraw(p_actor uuid, p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d payment_disputes;u profiles;total integer:=0;g record;member jsonb;o payment_orders;i integer;backfilled integer:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'PAY_DISPUTE_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 PERFORM pay_dispute_lock(d.payment_key,CASE WHEN d.provider_subscription_id IS NOT NULL THEN
  d.merchant_namespace||':'||d.mode||':'||d.provider_subscription_id END);
 SELECT * INTO u FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=d.order_id) FOR UPDATE;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute FOR UPDATE;
 SET CONSTRAINTS pay_dispute_source_sync IMMEDIATE; SET CONSTRAINTS pay_dispute_source_sync DEFERRED;
 -- CHARGEBACK G1: a dispute the admin confirmed as lost is final; its hold can never be released.
 IF d.lost_confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_LOST_CONFIRMED'; END IF;
 IF d.freeze_state='withdrawn' THEN RETURN jsonb_build_object('duplicate',true,'restored',0); END IF;
 IF d.freeze_state<>'frozen' OR u.id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_NOT_FROZEN'; END IF;
 UPDATE payment_disputes SET freeze_state='withdrawn',withdrawn_by=p_actor,withdrawn_at=clock_timestamp() WHERE id=d.id;
 IF NOT pay_dispute_order_frozen(d.order_id) THEN
  PERFORM 1 FROM subscription_credit_grants WHERE user_id=u.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM credit_package_sources WHERE user_id=u.id ORDER BY id FOR UPDATE;
  SELECT coalesce(sum(n),0)::integer INTO total FROM (
   SELECT dispute_frozen_credits n FROM subscription_credit_grants WHERE source_order_id=d.order_id
   UNION ALL SELECT dispute_frozen_credits FROM credit_package_sources WHERE order_id=d.order_id) x;
  UPDATE subscription_credit_grants SET dispute_frozen=false,dispute_frozen_credits=0 WHERE source_order_id=d.order_id;
  UPDATE credit_package_sources SET dispute_frozen=false,dispute_frozen_credits=0 WHERE order_id=d.order_id;
  UPDATE profiles SET credits=credits+total WHERE id=u.id;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,
   idempotency_key,balance_before,balance_after)
  VALUES(u.id,total,'adjustment','Payment dispute hold withdrawn','adjustment','dispute_withdraw','payment_order',d.order_id,
   'dispute:'||d.id||':withdraw',u.credits,u.credits+total);
 END IF;
 -- CHARGEBACK G2: once nothing holds this order, release now every period that came due during the hold, each on its
 -- original dates. pay_waffo_grant_period is idempotent per period, never starts a period before it is due, never goes past
 -- entitlement_end and keeps refusing refunded, terminated or erased cases.
 IF NOT pay_dispute_order_frozen(d.order_id) THEN
  SELECT * INTO o FROM payment_orders WHERE id=d.order_id;
  IF o.item_type='membership_plan' AND o.subscription_id IS NOT NULL THEN
   FOR i IN 1..CASE o.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END LOOP
    backfilled:=backfilled+pay_waffo_grant_period(o.id,i);
   END LOOP;
  END IF;
 END IF;
 PERFORM pay_common_settle_membership_level(u.id);
 member:=pay_common_membership_facts(u.id)->'internal_membership';
 IF member->>'mapping_state'='internal_paid' AND member->>'membership_level' IN ('pro','gold') THEN
  UPDATE profiles SET membership_level=member->>'membership_level' WHERE id=u.id;
 END IF;
 RETURN jsonb_build_object('restored',total,'duplicate',false,'backfilled',backfilled,
  'userId',u.id,'orderId',d.order_id,'status',d.status);
END $function$;

COMMIT;
