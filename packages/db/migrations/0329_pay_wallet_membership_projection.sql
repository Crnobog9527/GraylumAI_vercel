-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP: distinguish one-time wallets from stopped card subscriptions, and display verified async failures.
-- Reuse existing SECURITY DEFINER ownership/row locks and ACLs. No table/column/grant changes or data rewrites.
-- Deploy SQL first: old callers still use closed_unpaid and ignore the additional payment_method JSON field.
-- Recovery: revert application code; forward-fix these predicates if needed. Paid terms and grants are never removed.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE source text;
  method_old constant text := $old$'payment_channel',o.payment_channel,'status','active'$old$;
  method_new constant text := $new$'payment_channel',o.payment_channel,'payment_method',o.payment_method,'status','active'$new$;
  close_old constant text := $old$IF p_state='closed_unpaid' THEN$old$;
  close_new constant text := $new$IF p_state IN ('closed_unpaid','failed_unpaid') THEN$new$;
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
END $patch$;
COMMIT;
