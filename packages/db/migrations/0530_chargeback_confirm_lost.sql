-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CHARGEBACK G1: an admin confirms a lost dispute (Owner 2026-11-14, MASTER_PLAN 2.1). Number 0530 assigned by the controller.
-- Today a lost dispute stays 'frozen' forever with no final state. The freeze already took the order's unused credits out
-- of the balance and already blocks its membership, future monthly grants and founder badge. Confirming the loss keeps all
-- of that exactly as it is (freeze_state stays 'frozen', so every existing guard keeps applying) and only makes it final:
--  * new columns lost_confirmed_by / lost_confirmed_at;
--  * new pay_dispute_confirm_lost(actor,dispute): active admin only, same lock order as pay_dispute_withdraw, only for a
--    frozen dispute; a Stripe dispute must already be closed as 'lost'; a Waffo dispute (no outcome feed, Owner checks
--    the Waffo dashboard) is closed as 'lost' here. No new deduction: the held credits become the final clawback and
--    credits already used are never chased (records Z, AC). Repeat calls return duplicate=true and change nothing;
--  * pay_dispute_withdraw (whole definition from packages/db/functions/pay/) refuses a confirmed loss;
--  * pay_founder_status (whole definition from packages/db/functions/pay/) reports state 'ended', endedReason
--    'dispute_lost' from the confirmation time. The founder_ended email stays suppressed for a frozen order.
-- Compatibility: columns are nullable and only new code writes them; old code never calls the new function, and the two
--   replaced functions behave exactly as before while no dispute is confirmed. Code and migration may ship in either order
--   (the admin button only errors until the migration is applied).
-- Repeatable: ADD COLUMN IF NOT EXISTS, constraint dropped and re-added, CREATE OR REPLACE only.
-- Recovery: keep every row; re-apply the two previous definitions from packages/db/functions/ at the staging commit before
--   this migration and stop calling the new function. A mistaken confirmation is undone only by a reviewed forward fix that
--   clears both columns for that one dispute (no balance change is involved).
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.payment_disputes ADD COLUMN IF NOT EXISTS lost_confirmed_by uuid,
 ADD COLUMN IF NOT EXISTS lost_confirmed_at timestamptz;
ALTER TABLE public.payment_disputes DROP CONSTRAINT IF EXISTS payment_disputes_lost_confirmed;
ALTER TABLE public.payment_disputes ADD CONSTRAINT payment_disputes_lost_confirmed CHECK(
 (lost_confirmed_at IS NULL AND lost_confirmed_by IS NULL)
 OR (lost_confirmed_at IS NOT NULL AND lost_confirmed_by IS NOT NULL));

CREATE OR REPLACE FUNCTION public.pay_dispute_confirm_lost(p_actor uuid, p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d payment_disputes;u profiles;held integer;at_ timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'PAY_DISPUTE_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 IF d.id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_NOT_FOUND'; END IF;
 -- Same lock order as pay_dispute_withdraw: subscription, payment, profile, dispute.
 PERFORM pay_dispute_lock(d.payment_key,CASE WHEN d.provider_subscription_id IS NOT NULL THEN
  d.merchant_namespace||':'||d.mode||':'||d.provider_subscription_id END);
 SELECT * INTO u FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=d.order_id) FOR UPDATE;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute FOR UPDATE;
 IF d.lost_confirmed_at IS NOT NULL THEN
  RETURN jsonb_build_object('duplicate',true,'confirmedAt',d.lost_confirmed_at); END IF;
 IF d.freeze_state<>'frozen' OR u.id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_NOT_FROZEN'; END IF;
 IF d.provider='stripe' AND (d.status<>'lost' OR d.closed_at IS NULL) THEN RAISE EXCEPTION 'PAY_DISPUTE_NOT_LOST'; END IF;
 UPDATE payment_disputes SET lost_confirmed_by=p_actor,lost_confirmed_at=at_,
  status='lost',outcome=coalesce(outcome,'lost'),closed_at=coalesce(closed_at,at_) WHERE id=d.id;
 SELECT coalesce(sum(n),0)::integer INTO held FROM (
  SELECT dispute_frozen_credits n FROM subscription_credit_grants WHERE source_order_id=d.order_id
  UNION ALL SELECT dispute_frozen_credits FROM credit_package_sources WHERE order_id=d.order_id) x;
 -- Evidence retention runs from the close date; a no-op where the evidence table does not exist.
 PERFORM pay_dispute_evidence(d.order_id,coalesce(d.closed_at,at_));
 PERFORM pay_common_settle_membership_level(u.id);
 RETURN jsonb_build_object('duplicate',false,'confirmedAt',at_,'heldCredits',held);
END $function$;
REVOKE ALL ON FUNCTION public.pay_dispute_confirm_lost(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pay_dispute_confirm_lost(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pay_dispute_withdraw(p_actor uuid, p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d payment_disputes;u profiles;total integer:=0;g record;member jsonb;
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
 PERFORM pay_common_settle_membership_level(u.id);
 member:=pay_common_membership_facts(u.id)->'internal_membership';
 IF member->>'mapping_state'='internal_paid' AND member->>'membership_level' IN ('pro','gold') THEN
  UPDATE profiles SET membership_level=member->>'membership_level' WHERE id=u.id;
 END IF;
 RETURN jsonb_build_object('restored',total,'duplicate',false);
END $function$;

CREATE OR REPLACE FUNCTION public.pay_founder_status(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE o payment_orders; first_order payment_orders; prev payment_orders; s user_subscriptions;
 deadline timestamptz; ended_at timestamptz; ended_reason text; state text;
BEGIN
 IF p_user IS NULL THEN RAISE EXCEPTION 'PAY_FOUNDER_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- Sold founder orders of every channel (MP card, card_cn, wallet), oldest period first.
 FOR o IN SELECT * FROM payment_orders WHERE user_id=p_user AND item_type='membership_plan'
   AND offer_kind IN ('founder','founder_renewal') AND qualification_state='sold' AND fulfilled_at IS NOT NULL
   AND entitlement_start IS NOT NULL AND entitlement_end IS NOT NULL
   ORDER BY entitlement_start,id LOOP
  IF first_order.id IS NULL THEN first_order:=o; END IF;
  IF ended_at IS NULL AND (o.status='refunded' OR o.payment_status IN ('refunded','partially_refunded')) THEN
   ended_reason:='refunded';
   ended_at:=coalesce((o.metadata->'stripeExternalRefund'->>'refundedAt')::timestamptz,o.updated_at,o.entitlement_start);
  END IF;
  -- CHARGEBACK G1: a dispute the admin confirmed as lost ends the founder identity at confirmation (seat not returned).
  IF ended_at IS NULL THEN
   SELECT min(d.lost_confirmed_at) INTO ended_at FROM payment_disputes d WHERE d.order_id=o.id AND d.lost_confirmed_at IS NOT NULL;
   IF ended_at IS NOT NULL THEN ended_reason:='dispute_lost'; END IF;
  END IF;
  -- A card renewal charged after the 7-day window does not restore an identity that already ended.
  -- Wallet renewals are refused by admission after the deadline (0211), so they never form a gap here.
  IF ended_at IS NULL AND prev.id IS NOT NULL AND o.payment_method IN ('card','card_cn')
   AND coalesce(o.qualified_paid_at,o.entitlement_start)>prev.entitlement_end+interval '7 days' THEN
   ended_reason:='lapsed'; ended_at:=prev.entitlement_end+interval '7 days';
  END IF;
  prev:=o;
 END LOOP;
 IF first_order.id IS NULL THEN
  RETURN jsonb_build_object('state','none','orderId',NULL,'foundedAt',NULL,'periodEnd',NULL,'deadline',NULL,
   'endedAt',NULL,'endedReason',NULL);
 END IF;
 IF ended_at IS NULL THEN
  IF now()<prev.entitlement_end THEN state:='active';
  ELSE
   deadline:=pay_waffo_founder_deadline(prev.id);
   -- A renewing card subscription whose renewal outcome has not arrived yet keeps the same 7-day window.
   IF deadline IS NULL AND prev.payment_method IN ('card','card_cn') THEN
    SELECT * INTO s FROM user_subscriptions WHERE id=prev.subscription_id;
    IF s.status='active' AND s.founder_failed_at IS NULL AND s.method_cancel_requested_at IS NULL
     AND s.cancel_at_period_end IS DISTINCT FROM 'true' THEN deadline:=prev.entitlement_end+interval '7 days'; END IF;
   END IF;
   IF deadline IS NOT NULL AND now()<deadline THEN state:='grace';
   ELSE state:='ended'; ended_reason:='expired'; ended_at:=coalesce(deadline,prev.entitlement_end); END IF;
  END IF;
  IF state IN ('active','grace') AND EXISTS(SELECT 1 FROM payment_orders f WHERE f.user_id=p_user
    AND f.offer_kind IN ('founder','founder_renewal') AND f.qualification_state='sold' AND f.fulfilled_at IS NOT NULL
    AND f.entitlement_end>now()-interval '7 days' AND pay_founder_order_frozen(f.id)) THEN state:='frozen'; END IF;
 ELSE state:='ended';
 END IF;
 RETURN jsonb_build_object('state',state,'orderId',prev.id,
  'foundedAt',coalesce(first_order.qualified_paid_at,first_order.fulfilled_at),'periodEnd',prev.entitlement_end,
  'deadline',deadline,'endedAt',ended_at,'endedReason',ended_reason);
END $function$;

COMMIT;
