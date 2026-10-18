-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- R7 PR-B1 (PAY-STRIPE-MP, REL-1 D7/D9): Stripe card and Stripe wallet orders follow the Stripe account's own mode.
-- Until now every new-method function refused anything but payment_mode='test', so the production (live) Stripe
-- account could not admit, fulfil, renew or entitle a single order. Now:
--  * pay_method_mode_allowed(channel, mode): test for any channel, live for Stripe only. Waffo stays test-only.
--  * Admission accepts p_mode 'live'; a transition's prior paid order must be in the same mode.
--  * Claim, bind, fulfil, grants, yearly release, abort/close, tax, renewal, renewal failure, subscription sync,
--    upgrade observation and membership facts use the order's / subscription's own mode instead of a 'test' literal,
--    so provider references and new rows are written in that mode and never cross modes.
--  * pay_waffo_create_transition takes p_mode (default 'test', so code deployed before this keeps working).
--  * erasure_payment_envelope accepts a frozen checkout request in mode 'live'.
-- Which mode a deployment uses is decided by its Stripe key (the app checks event/object livemode against it);
-- staging uses the sandbox key, so staging behaviour is unchanged. Opening production checkout is a separate
-- default-off code gate (R7 PR-A). Refunds are R7 PR-B2.
-- Patches are anchored on the latest bodies (0211, 0214+0238, 0222+0243, 0237, 0238+0243, 0251, 0264); a missing
-- anchor stops the migration. Repeatable: an already patched body is left alone. No table or data change.
-- Rollback: forward-fix (re-apply the previous bodies with the 'test' literals); no live rows exist on staging.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.pay_method_mode_allowed(p_channel text,p_mode text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(p_mode='test' OR (p_channel='stripe' AND p_mode='live'),false);
$$;
REVOKE ALL ON FUNCTION public.pay_method_mode_allowed(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_method_mode_allowed(text,text) TO service_role;

DO $patch$
DECLARE p record; fn oid; source text; patched text; hits integer;
BEGIN
 FOR p IN SELECT * FROM (VALUES
  -- Admission: live for Stripe (admission always selects the stripe channel, 0222); prior order in the same mode.
  (1,'pay_waffo_admit_purchase',E'  IF p_mode IS DISTINCT FROM \'test\' THEN\n    RAISE EXCEPTION \'PAY_WAFFO_LIVE_DISABLED\'',
     E'  IF NOT pay_method_mode_allowed(\'stripe\',p_mode) THEN\n    RAISE EXCEPTION \'PAY_WAFFO_LIVE_DISABLED\'',1),
  (2,'pay_waffo_admit_purchase',E'      AND payment_mode=\'test\' AND payment_status=\'paid\' AND status=\'completed\'',
     E'      AND payment_mode=p_mode AND payment_status=\'paid\' AND status=\'completed\'',1),
  (3,'pay_waffo_claim_checkout',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (4,'pay_waffo_claim_checkout',E'p_request->>\'mode\' IS DISTINCT FROM \'test\'',
     E'p_request->>\'mode\' IS DISTINCT FROM o.payment_mode',1),
  (5,'pay_waffo_bind_checkout',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (6,'pay_waffo_bind_checkout',E'VALUES(o.payment_channel,p_merchant,\'test\',\'checkout\'',
     E'VALUES(o.payment_channel,p_merchant,o.payment_mode,\'checkout\'',1),
  (7,'pay_waffo_bind_checkout',E'   AND mode=\'test\' AND object_type=\'checkout\'',
     E'   AND mode=o.payment_mode AND object_type=\'checkout\'',1),
  (8,'pay_waffo_grant_period',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (9,'pay_waffo_fulfill_payment',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (10,'pay_waffo_fulfill_payment',E'pay_waffo_observe_qualification(o.id,p_merchant,\'test\',',
     E'pay_waffo_observe_qualification(o.id,p_merchant,o.payment_mode,',1),
  (11,'pay_waffo_fulfill_payment',E'p_start,p_end,o.payment_channel,p_merchant,\'test\',o.purchase_snapshot',
     E'p_start,p_end,o.payment_channel,p_merchant,o.payment_mode,o.purchase_snapshot',1),
  (12,'pay_waffo_fulfill_payment',E'VALUES(o.payment_channel,p_merchant,\'test\',\'subscription\'',
     E'VALUES(o.payment_channel,p_merchant,o.payment_mode,\'subscription\'',1),
  (13,'pay_waffo_fulfill_payment',E'     AND mode=\'test\' AND object_type=\'subscription\'',
     E'     AND mode=o.payment_mode AND object_type=\'subscription\'',1),
  (14,'pay_waffo_release_due',E'o.payment_mode=\'test\' AND o.billing_cycle=\'yearly\'',
     E'pay_method_mode_allowed(o.payment_channel,o.payment_mode) AND o.billing_cycle=\'yearly\'',1),
  (15,'pay_waffo_abort_before_dispatch',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (16,'pay_waffo_close_uncreated',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (17,'pay_stripe_mp_record_tax',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (18,'pay_stripe_mp_record_tax',E'AND merchant_namespace=p_merchant AND mode=\'test\' AND external_id=p_payment',
     E'AND merchant_namespace=p_merchant AND mode=o.payment_mode AND external_id=p_payment',1),
  (19,'pay_stripe_mp_renew_subscription',E's.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(s.payment_channel,s.payment_mode)',1),
  (20,'pay_stripe_mp_renew_subscription',E'r.merchant_namespace=p_merchant AND r.mode=\'test\' AND r.object_type=\'payment\'',
     E'r.merchant_namespace=p_merchant AND r.mode=s.payment_mode AND r.object_type=\'payment\'',1),
  (21,'pay_stripe_mp_renew_subscription',E'\'paid\',\'stripe\',p_merchant,\'test\',gen_random_uuid()',
     E'\'paid\',\'stripe\',p_merchant,s.payment_mode,gen_random_uuid()',1),
  (22,'pay_stripe_mp_renew_subscription',E'VALUES(\'stripe\',p_merchant,\'test\',\'payment\',p_invoice,o.id)',
     E'VALUES(\'stripe\',p_merchant,s.payment_mode,\'payment\',p_invoice,o.id)',1),
  (23,'pay_stripe_mp_record_renewal_failure',E's.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(s.payment_channel,s.payment_mode)',1),
  (24,'pay_stripe_mp_sync_subscription',E's.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(s.payment_channel,s.payment_mode)',1),
  (25,'pay_stripe_mp_observe_subscription',E's.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(s.payment_channel,s.payment_mode)',1),
  (26,'pay_stripe_mp_observe_subscription',E'AND merchant_namespace=p_merchant AND mode=\'test\')',
     E'AND merchant_namespace=p_merchant AND mode=s.payment_mode)',1),
  -- Entitlements: a paid live Stripe order grants membership like a test one; Waffo stays test-only.
  (27,'pay_common_membership_facts',E'AND o.payment_channel IN (\'stripe\',\'waffo\') AND o.payment_mode=\'test\'',
     E'AND o.payment_channel IN (\'stripe\',\'waffo\') AND pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (28,'erasure_payment_envelope',E'OR v->>\'mode\' IS DISTINCT FROM \'test\' OR',
     E'OR coalesce(v->>\'mode\',\'\') NOT IN (\'test\',\'live\') OR',1),
  (29,'erasure_payment_envelope','"mode":{"$enum":["test"]}','"mode":{"$enum":["test","live"]}',1)
 ) AS t(n,name,old,new,expected) ORDER BY n LOOP
  SELECT CASE WHEN count(*)=1 THEN min(oid) END INTO fn FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname=p.name;
  IF fn IS NULL THEN RAISE EXCEPTION 'PAY_STRIPE_LIVE_PATCH_TARGET %',p.name; END IF;
  source:=pg_get_functiondef(fn);
  hits:=(length(source)-length(replace(source,p.old,'')))/length(p.old);
  IF hits=0 AND position(p.new IN source)>0 THEN CONTINUE; END IF;
  IF hits<>p.expected THEN RAISE EXCEPTION 'PAY_STRIPE_LIVE_PATCH_MISSING % (% found)',p.n,hits; END IF;
  patched:=replace(source,p.old,p.new);
  EXECUTE patched;
 END LOOP;
END $patch$;

-- Upgrade / founder renewal admission in the Stripe account's mode. The default keeps the old call shape working.
DROP FUNCTION IF EXISTS public.pay_waffo_create_transition(uuid,uuid,text,text,text,text,bigint,text,jsonb,text,uuid);
CREATE OR REPLACE FUNCTION public.pay_waffo_create_transition(
 p_user uuid,p_item uuid,p_cycle text,p_method text,p_offer text,p_merchant text,p_version bigint,p_terms text,
 p_digests jsonb,p_transition text,p_prior uuid,p_mode text DEFAULT 'test'
) RETURNS public.payment_orders LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.pay_waffo_admit_purchase(p_user,'membership_plan',p_item,p_cycle,p_method,p_offer,p_merchant,p_mode,p_version,
   p_terms,p_digests,p_transition,p_prior);
$$;
REVOKE ALL ON FUNCTION public.pay_waffo_create_transition(uuid,uuid,text,text,text,text,bigint,text,jsonb,text,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pay_waffo_create_transition(uuid,uuid,text,text,text,text,bigint,text,jsonb,text,uuid,text)
 TO service_role;

COMMIT;
