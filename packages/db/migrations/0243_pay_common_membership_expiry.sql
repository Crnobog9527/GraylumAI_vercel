-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-COMMON (0243): an ended wallet / Waffo / Stripe internal membership no longer blocks buying again.
-- Entitlements already follow pay_common_membership_facts (paid order end + renewal grace), but nothing
-- moved profiles.membership_level back after a wallet or Waffo term ended, and the ordinary-purchase
-- admission refused any non-free cached level or any 'active' subscription row.
-- 1. pay_common_settle_membership_level: under the profile lock, lowers the cached level to the facts
--    projection (internal_paid -> its level, internal_inactive -> free). It never raises a level, and
--    skips admin overrides, legacy Stripe conflicts, closed/erasing accounts and held monthly refunds.
-- 2. pay_common_settle_membership_levels: bounded batch run by the existing daily credit-release cron.
-- 3. pay_waffo_admit_purchase (latest body: 0222; 0237/0238 do not change it) settles first, and an
--    internal subscription that stopped renewing and whose period ended no longer blocks admission.
--    A still-renewing card subscription keeps blocking: the provider may still charge it.
-- 4. pay_stripe_mp_sync_subscription (0238) settles through the same function on a final cancellation.
-- Depends on 0237/0238 (#909/#922) being applied first. No table or column changes; repeatable.
-- Rollback: forward-fix (re-create 0222's admission body and 0238's sync body).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_common_settle_membership_level(p_user uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor profiles; member jsonb; target text; target_rank integer;
BEGIN
 SELECT * INTO actor FROM profiles WHERE id=p_user FOR UPDATE;
 IF actor.id IS NULL OR actor.membership_level NOT IN ('pro','gold') OR actor.status IS DISTINCT FROM 'active'
  OR actor.is_deleted::text IS DISTINCT FROM 'false'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user)
  -- A held monthly first-purchase refund owns the level change (0195 guard).
  OR EXISTS(SELECT 1 FROM payment_orders WHERE user_id=p_user AND refund_approval->>'kind'='monthly_first_purchase'
    AND refund_approval->>'hold'='held') THEN RETURN false; END IF;
 -- Same projection as entitlements: grace, founder, refunds and admin overrides are decided there.
 member:=pay_common_membership_facts(p_user)->'internal_membership';
 target:=CASE member->>'mapping_state' WHEN 'internal_paid' THEN member->>'membership_level'
   WHEN 'internal_inactive' THEN 'free' END;
 target_rank:=CASE target WHEN 'free' THEN 0 WHEN 'pro' THEN 1 WHEN 'gold' THEN 2 END;
 -- Only ever lowers: never grants a level the cache did not already hold.
 IF target_rank IS NULL OR target_rank>=(CASE actor.membership_level WHEN 'pro' THEN 1 ELSE 2 END) THEN RETURN false; END IF;
 UPDATE profiles SET membership_level=target WHERE id=p_user;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.pay_common_settle_membership_levels(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u uuid; n integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'PAY_COMMON_LIMIT_INVALID'; END IF;
 -- Candidates are filtered before LIMIT with the setter's own skip conditions, so profiles it would leave
 -- unchanged (held refund, erasure, legacy Stripe, admin override, renewal grace, a higher current term)
 -- never take a slot and starve later ended memberships.
 FOR u IN SELECT p.id FROM profiles p WHERE p.membership_level IN ('pro','gold') AND p.status='active'
   AND p.is_deleted='false' AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p.id
     AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p.id AND o.item_type='membership_plan'
     AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL AND o.entitlement_start<=now()
     AND o.entitlement_end>now()-interval '24 hours'
     AND (o.purchase_membership_level=p.membership_level OR o.purchase_membership_level='gold'))
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests r WHERE r.profile_id=p.id)
   AND NOT EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p.id
     AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold'='held')
   AND NOT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p.id
     AND s.stripe_subscription_id IS NOT NULL AND s.status IN ('active','trialing','past_due','incomplete','unpaid'))
   -- Same effective-override predicate as pay_common_membership_facts: only an override set after the last paid term.
   AND NOT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p.id AND s.status='admin_override'
     AND s.metadata ? 'adminOverride' AND s.updated_at>=(SELECT max(o.fulfilled_at) FROM payment_orders o
       WHERE o.user_id=p.id AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL))
   ORDER BY p.id LIMIT p_limit LOOP
  IF pay_common_settle_membership_level(u) THEN n:=n+1; END IF;
 END LOOP;
 RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.pay_common_settle_membership_level(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pay_common_settle_membership_levels(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_settle_membership_level(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_common_settle_membership_levels(integer) TO service_role;

-- Anchors must match 0222's body exactly; a missing anchor stops the migration instead of skipping.
DO $admission$
DECLARE source text;
  old_closed constant text:='    RAISE EXCEPTION ''PAY_WAFFO_ACCOUNT_CLOSED'' USING ERRCODE=''42501'';'||chr(10)||'  END IF;';
  new_closed constant text:=old_closed||chr(10)
    ||'  -- PAY_COMMON_MEMBERSHIP_EXPIRY (0243): an ended paid term no longer keeps the cached level.'||chr(10)
    ||'  -- Admission is granted to service_role only; the facts it settles from are service-readable.'||chr(10)
    ||'  IF current_setting(''role'',true)=''service_role'' THEN'||chr(10)
    ||'    IF public.pay_common_settle_membership_level(p_user) THEN SELECT * INTO actor FROM profiles WHERE id=p_user; END IF;'||chr(10)
    ||'  END IF;';
  old_rows constant text:='OR s.current_period_end>now()))) THEN';
  new_rows constant text:='OR s.current_period_end>now())'||chr(10)
    ||'      AND NOT (s.stripe_subscription_id IS NULL AND s.payment_channel IS NOT NULL'
    ||' AND s.cancel_at_period_end=''true'' AND s.current_period_end<=now()))) THEN';
BEGIN
  source:=pg_get_functiondef(('public.pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,'
    ||'jsonb,text,uuid)')::regprocedure);
  IF position(new_closed IN source)=0 THEN
    IF position(old_closed IN source)=0 THEN RAISE EXCEPTION 'PAY_COMMON_EXPIRY_SETTLE_PATCH_MISSING'; END IF;
    source:=replace(source,old_closed,new_closed);
  END IF;
  IF position(new_rows IN source)=0 THEN
    IF position(old_rows IN source)=0 THEN RAISE EXCEPTION 'PAY_COMMON_EXPIRY_ROWS_PATCH_MISSING'; END IF;
    source:=replace(source,old_rows,new_rows);
  END IF;
  EXECUTE source;
END $admission$;

-- 0238's final Stripe card cancellation computed its own remaining level; it now settles from the same
-- facts projection (refunding / review orders, admin overrides and legacy conflicts decided there).
DO $stripe_cancel$
DECLARE source text;
  old_cancel constant text:=$old$ IF s.status='canceled' THEN
  SELECT coalesce(max(lvl),0) INTO remaining FROM (
   SELECT CASE o.purchase_membership_level WHEN 'gold' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END lvl FROM payment_orders o
    WHERE o.user_id=s.user_id AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL
     AND o.payment_status='paid' AND o.status='completed' AND o.entitlement_start<=now() AND o.entitlement_end>now()
   UNION ALL
   SELECT CASE p.level WHEN 'gold' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END FROM user_subscriptions x
    JOIN membership_plans p ON p.id=x.membership_plan_id
    WHERE x.user_id=s.user_id AND x.id<>s.id AND (x.stripe_subscription_id IS NOT NULL OR x.status='admin_override')
     AND x.status IN ('active','trialing','past_due','unpaid','admin_override')
     AND (x.current_period_end IS NULL OR x.current_period_end>now())) held;
  UPDATE profiles SET membership_level=CASE remaining WHEN 2 THEN 'gold' WHEN 1 THEN 'pro' ELSE 'free' END
   WHERE id=s.user_id AND CASE membership_level WHEN 'gold' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END>remaining;
 END IF;$old$;
  new_cancel constant text:=' -- PAY_COMMON_MEMBERSHIP_EXPIRY (0243): the cached level follows pay_common_membership_facts.'||chr(10)
    ||' IF s.status=''canceled'' AND current_setting(''role'',true)=''service_role'' THEN'||chr(10)
    ||'  PERFORM public.pay_common_settle_membership_level(s.user_id);'||chr(10)||' END IF;';
BEGIN
  source:=pg_get_functiondef('public.pay_stripe_mp_sync_subscription(uuid,text,boolean,boolean)'::regprocedure);
  IF position(new_cancel IN source)=0 THEN
    IF position(old_cancel IN source)=0 THEN RAISE EXCEPTION 'PAY_COMMON_EXPIRY_STRIPE_CANCEL_PATCH_MISSING'; END IF;
    EXECUTE replace(source,old_cancel,new_cancel);
  END IF;
END $stripe_cancel$;

COMMIT;
