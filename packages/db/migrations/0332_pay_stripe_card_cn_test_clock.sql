-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP: Owner 2026-10-21 approved card_cn under the same exact staging/test/owned-clock gates.
-- Reuse 0329's verified source time; require card/MP or card_cn/non-MP consistently on root and renewal.
-- First qualification, real event/refund times, cash close, erasure/dispute/amount guards are unchanged.
-- No data/ACL/signature changes. Repeatable; transaction interruption restores old definitions.
-- Recovery: forward-fix these predicates; retain observations and all financial rows.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $patch$
DECLARE source text; row_ record;
BEGIN
 FOR row_ IN SELECT * FROM (VALUES
  ('pay_stripe_test_clock_time(uuid)',
   E'root.payment_method IS DISTINCT FROM ''card''\n  OR root.stripe_managed_payments IS DISTINCT FROM true',
   'NOT coalesce(root.payment_method IN (''card'',''card_cn'') AND root.stripe_managed_payments=(root.payment_method=''card''),false)'),
  ('pay_stripe_test_clock_time(uuid)',
   'o.stripe_managed_payments IS DISTINCT FROM true',
   'o.stripe_managed_payments IS DISTINCT FROM root.stripe_managed_payments'),
  ('pay_stripe_test_clock_observe(uuid,text,text,timestamp with time zone,jsonb)',
   E'o.payment_method IS DISTINCT FROM ''card''\n  OR o.stripe_managed_payments IS DISTINCT FROM true',
   'NOT coalesce(o.payment_method IN (''card'',''card_cn'') AND o.stripe_managed_payments=(o.payment_method=''card''),false)')
 ) AS patches(signature,old_,new_) LOOP
  source:=pg_get_functiondef(('public.'||row_.signature)::regprocedure);
  IF position(row_.old_ IN source)>0 THEN
   IF array_length(string_to_array(source,row_.old_),1)<>2 THEN
    RAISE EXCEPTION 'PAY_STRIPE_CARD_CN_CLOCK_PATCH_MISMATCH: %',row_.signature; END IF;
   EXECUTE replace(source,row_.old_,row_.new_);
  ELSIF position(row_.new_ IN source)=0 THEN
   RAISE EXCEPTION 'PAY_STRIPE_CARD_CN_CLOCK_PATCH_MISMATCH: %',row_.signature;
  END IF;
 END LOOP;
END $patch$;
COMMIT;
