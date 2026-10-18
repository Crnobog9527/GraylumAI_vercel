-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Erasure keeps Waffo checkout evidence test-only. 0296 let erasure_payment_envelope accept mode 'live' for every
-- frozen checkout wrapper, but only Stripe orders may run live (pay_method_mode_allowed; Waffo stays test-only).
-- A Waffo-shaped (productId) wrapper marked live is a request the product never emits, so it goes to manual review
-- like any other unknown shape instead of being projected and erased. Stripe live wrappers are unchanged.
-- Patch is anchored on the 0296 body; a missing anchor stops the migration. Repeatable: an already patched body is
-- left alone. No table or data change; no Waffo live order exists (admission refuses it).
-- Rollback: forward-fix with the same anchored DO block, swapping old/new so the added
-- "OR v->>'mode' IS DISTINCT FROM 'test'" line is removed again (restores the 0296 body exactly). No data to restore;
-- nothing else depends on the added predicate.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $patch$
DECLARE fn oid; source text; hits integer;
 old text:=E'   IF v->>\'method\'<>\'card\' OR NOT (provider ?& ARRAY[\'productId\'';
 new text:=E'   IF v->>\'method\'<>\'card\' OR v->>\'mode\' IS DISTINCT FROM \'test\'\n'
  ||E'    OR NOT (provider ?& ARRAY[\'productId\'';
BEGIN
 SELECT CASE WHEN count(*)=1 THEN min(oid) END INTO fn FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='erasure_payment_envelope';
 IF fn IS NULL THEN RAISE EXCEPTION 'ERASURE_WAFFO_TEST_PATCH_TARGET'; END IF;
 source:=pg_get_functiondef(fn);
 IF position(E'coalesce(v->>\'mode\',\'\') NOT IN (\'test\',\'live\')' IN source)=0 THEN
  RAISE EXCEPTION 'ERASURE_WAFFO_TEST_PATCH_BASE';
 END IF;
 hits:=(length(source)-length(replace(source,old,'')))/length(old);
 IF hits=0 AND position(new IN source)>0 THEN RETURN; END IF;
 IF hits<>1 THEN RAISE EXCEPTION 'ERASURE_WAFFO_TEST_PATCH_MISSING (% found)',hits; END IF;
 EXECUTE replace(source,old,new);
END $patch$;

COMMIT;
