-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- R7 PR-B2 (PAY-STRIPE-MP, REL-1 D7/D9): refunds of Stripe card and wallet orders follow the order's own mode,
-- like their checkout and fulfilment since 0296. Until now every refund path refused anything but 'test', so a
-- live (production) payment could not be refunded, recorded as externally refunded, or reviewed.
--  * External refund webhook (pay_stripe_mp_record_external_refund, 0247).
--  * Credit-pack refund quote (pay_common_package_refund_quote, 0252); its result already uses the order's mode.
--  * Monthly / subscription refund: validation (monthly_refund_validate, 0253), result (0253), provider conflict and
--    fresh observation (0194), and the erasure safety check (monthly_refund_erasure_safe_0195). The frozen terms carry
--    the mode; validation requires it to equal the order's and subscription's mode, and every later step compares the
--    provider's answer and its references with the terms' mode, never a literal.
-- Waffo stays test-only (pay_method_mode_allowed, 0296). Staging uses the Stripe sandbox, so its behaviour is
-- unchanged. Anchored on the latest bodies; a missing anchor stops the migration. Repeatable. No table or data change.
-- Depends on 0296. Rollback: forward-fix (re-apply the previous bodies); no live rows exist on staging.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $patch$
DECLARE p record; fn oid; source text; hits integer;
BEGIN
 IF to_regprocedure('public.pay_method_mode_allowed(text,text)') IS NULL THEN
  RAISE EXCEPTION 'PAY_STRIPE_LIVE_REFUND_REQUIRES_0296'; END IF;
 FOR p IN SELECT * FROM (VALUES
  (1,'pay_stripe_mp_record_external_refund',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (2,'pay_stripe_mp_record_external_refund',E'AND merchant_namespace=p_merchant AND mode=\'test\' AND external_id=p_payment',
     E'AND merchant_namespace=p_merchant AND mode=o.payment_mode AND external_id=p_payment',1),
  (3,'pay_stripe_mp_record_external_refund',E'VALUES(\'stripe\',p_merchant,\'test\',\'refund\',p_refund,o.id)',
     E'VALUES(\'stripe\',p_merchant,o.payment_mode,\'refund\',p_refund,o.id)',1),
  (4,'pay_stripe_mp_record_external_refund',E'merchant_namespace=p_merchant AND mode=\'test\'\n  AND object_type=\'refund\'',
     E'merchant_namespace=p_merchant AND mode=o.payment_mode\n  AND object_type=\'refund\'',1),
  (5,'pay_common_package_refund_quote',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (6,'pay_common_package_refund_quote',E'p_cash->>\'mode\' IS DISTINCT FROM \'test\'',
     E'p_cash->>\'mode\' IS DISTINCT FROM o.payment_mode',1),
  (7,'monthly_refund_validate',E'o.payment_mode IS DISTINCT FROM \'test\'',
     E'NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)',1),
  (8,'monthly_refund_validate',E's.payment_mode IS DISTINCT FROM \'test\'',
     E's.payment_mode IS DISTINCT FROM o.payment_mode',1),
  (9,'monthly_refund_validate',E'p_terms->>\'mode\' IS DISTINCT FROM \'test\'',
     E'p_terms->>\'mode\' IS DISTINCT FROM o.payment_mode',1),
  (10,'monthly_refund_validate',E'AND channel=\'stripe\' AND mode=\'test\' AND merchant_namespace=o.merchant_namespace',
     E'AND channel=\'stripe\' AND mode=o.payment_mode AND merchant_namespace=o.merchant_namespace',2),
  (11,'pay_common_monthly_refund_result',E'p_refund->>\'mode\' IS DISTINCT FROM \'test\'',
     E'p_refund->>\'mode\' IS DISTINCT FROM t->>\'mode\'',1),
  (12,'pay_common_monthly_refund_result',E'VALUES(\'stripe\',t->>\'merchant\',\'test\',\'refund\'',
     E'VALUES(\'stripe\',t->>\'merchant\',t->>\'mode\',\'refund\'',1),
  (13,'pay_common_monthly_refund_result',E' AND mode=\'test\' AND object_type=\'refund\'',
     E' AND mode=t->>\'mode\' AND object_type=\'refund\'',1),
  (14,'pay_common_monthly_refund_conflict',E'p_cash->>\'mode\' IS DISTINCT FROM \'test\'',
     E'p_cash->>\'mode\' IS DISTINCT FROM t->>\'mode\'',1),
  (15,'monthly_refund_observation',E'e->>\'mode\' IS DISTINCT FROM \'test\'',
     E'e->>\'mode\' IS DISTINCT FROM i->\'terms\'->>\'mode\'',1),
  (16,'monthly_refund_erasure_safe_0195',E't->>\'mode\'<>\'test\'',
     E'coalesce(t->>\'mode\',\'\') NOT IN (\'test\',\'live\')',1)
 ) AS t(n,name,old,new,expected) ORDER BY n LOOP
  SELECT CASE WHEN count(*)=1 THEN min(oid) END INTO fn FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname=p.name;
  IF fn IS NULL THEN RAISE EXCEPTION 'PAY_STRIPE_LIVE_REFUND_PATCH_TARGET %',p.name; END IF;
  source:=pg_get_functiondef(fn);
  hits:=(length(source)-length(replace(source,p.old,'')))/length(p.old);
  IF hits=0 AND position(p.new IN source)>0 THEN CONTINUE; END IF;
  IF hits<>p.expected THEN RAISE EXCEPTION 'PAY_STRIPE_LIVE_REFUND_PATCH_MISSING % (% found)',p.n,hits; END IF;
  EXECUTE replace(source,p.old,p.new);
 END LOOP;
END $patch$;

COMMIT;
