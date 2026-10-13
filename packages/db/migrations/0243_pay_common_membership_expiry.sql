-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-COMMON (0243): an ended wallet / Waffo / Stripe internal membership no longer blocks buying again.
-- Entitlements already follow pay_common_membership_facts (paid order end + renewal grace), but nothing
-- moved profiles.membership_level back after a wallet or Waffo term ended, and the ordinary-purchase
-- admission refused any non-free cached level or any 'active' subscription row. 0238 covers only a final
-- Stripe card cancellation.
-- 1. pay_common_settle_membership_level: under the profile lock, lowers the cached level to the facts
--    projection (internal_paid -> its level, internal_inactive -> free). It never raises a level, and
--    skips admin overrides, legacy Stripe conflicts, closed/erasing accounts and held monthly refunds.
-- 2. pay_common_settle_membership_levels: bounded batch run by the existing daily credit-release cron.
-- 3. pay_waffo_admit_purchase (latest body: 0222; 0237/0238 do not change it) settles first, and an
--    internal subscription that stopped renewing and whose period ended no longer blocks admission.
--    A still-renewing card subscription keeps blocking: the provider may still charge it.
-- No table or column changes; repeatable. Rollback: forward-fix (re-create 0222's admission body).
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
 -- Candidates: cached paid level with a paid-method order but no current order at that level.
 FOR u IN SELECT p.id FROM profiles p WHERE p.membership_level IN ('pro','gold') AND p.status='active'
   AND p.is_deleted='false' AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p.id
     AND o.item_type='membership_plan' AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p.id AND o.item_type='membership_plan'
     AND o.payment_method IS NOT NULL AND o.fulfilled_at IS NOT NULL AND o.purchase_membership_level=p.membership_level
     AND o.entitlement_start<=now() AND o.entitlement_end>now())
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

COMMIT;
