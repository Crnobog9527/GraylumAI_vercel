-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ARCH-FIX E1 (Owner 2026-10-25, "架构审计上线前按 A 做"; audit item 5): one rule for "credits of a terminated
-- subscription are quarantined".
--
-- Before: the rule was copied into six function bodies with different matching.
--   * credit_source_rows / credit_source_apply (0275) and atomic_pre_deduct (0061) matched the grant's subscription
--     row (subscription_id, or stripe_subscription_id for legacy grants without one).
--   * bill2_payg_claim (0180), fusion_review_available (0294) and report_fee_hold (0295) matched only by
--     stripe_subscription_id. A grant whose stripe_subscription_id is NULL (Waffo, wallet and some Stripe MP grants;
--     staging 10-25: 27 of 34 grants) never matched, so its remainder was not subtracted from the spendable balance
--     after termination. Only the separate wallet/Waffo clawbacks kept that from being spendable so far.
-- After: credit_grant_quarantined(grant) decides it once, by the same subscription match as atomic_pre_deduct,
--   bill2_payg_compensate and bill2_legacy_* (subscription_id first; stripe_subscription_id only when the grant has no
--   subscription_id), plus the monthly first-purchase refund hold that credit_source_rows already applied. Every one
--   of the six places calls it. Stripe grants with both ids keep their result; grants without a stripe id are now
--   quarantined on all paths. The hold clause only reaches grants still 'granted' (a hold reverses the grant), so it
--   adds no new refusal on the spend paths.
-- Only these bodies change (in-place patches of the current definitions; each anchor must match exactly once).
-- No data changes. Recovery: re-run the six predecessor bodies (pg_get_functiondef captured before applying) and drop
-- credit_grant_quarantined; reapplying this file afterwards restores it.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.credit_grant_quarantined(g subscription_credit_grants) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=g.user_id
   AND (s.id=g.subscription_id OR (g.subscription_id IS NULL AND s.stripe_subscription_id=g.stripe_subscription_id))
   AND s.credit_release_terminated_at IS NOT NULL)
  OR (g.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.subscription_id=g.subscription_id
   AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold' IN ('held','terminated')))
$$;
REVOKE ALL ON FUNCTION public.credit_grant_quarantined(subscription_credit_grants) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_grant_quarantined(subscription_credit_grants) TO service_role;

-- Patch helper: literal text with single spaces where the source has any whitespace; must match exactly once.
CREATE FUNCTION pg_temp.e1_patch(fn regprocedure, lit text, rep text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE src text:=pg_get_functiondef(fn);pat text;
BEGIN
 IF position('ARCH-FIX E1' IN src)>0 THEN RETURN; END IF;
 pat:=replace(regexp_replace(lit,'([.()*+?\[\]{}|^$\\])','\\\1','g'),' ','\s+');
 IF (SELECT count(*) FROM regexp_matches(src,pat,'g'))<>1 THEN
  RAISE EXCEPTION 'ARCH_FIX_E1_ANCHOR_MISSING: %',fn;END IF;
 EXECUTE regexp_replace(src,pat,replace(rep,'\','\\'));
END $$;

-- bill2_payg_claim has a numeric variable named g, so the grant alias becomes qg here.
SELECT pg_temp.e1_patch('public.bill2_payg_claim(uuid,uuid,integer,jsonb)',
 $l$SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine FROM subscription_credit_grants g WHERE g.user_id=a AND g.status='granted' AND g.accounting_state='trusted' AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);$l$,
 $r$SELECT coalesce(sum(greatest(qg.credits_granted-qg.consumed_amount,0)),0) INTO quarantine
 FROM subscription_credit_grants qg WHERE qg.user_id=a AND qg.status='granted' AND qg.accounting_state='trusted'
 AND credit_grant_quarantined(qg); -- ARCH-FIX E1$r$);

SELECT pg_temp.e1_patch('public.fusion_review_available(uuid,integer)',
 $l$AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);$l$,
 $r$AND credit_grant_quarantined(g); -- ARCH-FIX E1$r$);

SELECT pg_temp.e1_patch('public.report_fee_hold(runtime_executions,jsonb)',
 $l$AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=e.actor_id AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);$l$,
 $r$AND credit_grant_quarantined(g); -- ARCH-FIX E1$r$);

SELECT pg_temp.e1_patch('public.credit_source_rows(uuid)',
 $l$EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=g.user_id AND (s.id=g.subscription_id OR s.stripe_subscription_id=g.stripe_subscription_id) AND s.credit_release_terminated_at IS NOT NULL) OR (g.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.subscription_id=g.subscription_id AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold' IN ('held','terminated'))) AS blocked,$l$,
 $r$credit_grant_quarantined(g) AS blocked, -- ARCH-FIX E1$r$);

SELECT pg_temp.e1_patch('public.credit_source_apply(uuid,uuid,integer,text)',
 $l$AND NOT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=g.user_id AND (s.id=g.subscription_id OR s.stripe_subscription_id=g.stripe_subscription_id) AND s.credit_release_terminated_at IS NOT NULL) AND NOT (g.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.subscription_id=g.subscription_id AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold' IN ('held','terminated')));$l$,
 $r$AND NOT credit_grant_quarantined(g); -- ARCH-FIX E1$r$);

SELECT pg_temp.e1_patch('public.atomic_pre_deduct(uuid,integer,text,uuid)',
 $l$AND EXISTS ( SELECT 1 FROM user_subscriptions AS terminated_us WHERE (terminated_us.id = g.subscription_id OR (g.subscription_id IS NULL AND terminated_us.stripe_subscription_id = g.stripe_subscription_id)) AND terminated_us.user_id = p_user_id AND terminated_us.credit_release_terminated_at IS NOT NULL )$l$,
 $r$AND public.credit_grant_quarantined(g) -- ARCH-FIX E1$r$);

DROP FUNCTION pg_temp.e1_patch(regprocedure,text,text);
COMMIT;
