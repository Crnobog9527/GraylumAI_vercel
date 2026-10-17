-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- R7 PR-B3 (PAY-STRIPE-MP, REL-1 D9): our approved refund of a wallet (WeChat Pay / Alipay) one-time membership order.
-- Wallet memberships are paid once through Checkout: no Stripe subscription or invoice history, so neither the monthly
-- subscription refund (0193/0253) nor the pack-only refund (0185/0252) could refund them. They now reuse the pack refund
-- path (quote -> decide -> claim -> Stripe refund -> result), same rules (MASTER_PLAN item 51 / record AA): within
-- 7 days, no credit used on the account since the payment, the 6% fee only where the law permits it.
--  * Quote/reject accept a wallet one-time membership order (item 'membership_plan', not auto-renewing) whose
--    subscription is still active and releasing credits. The credits taken back are every credit this order granted so
--    far (pay_waffo_grant_period 'payment:<order>:NN' rows; a yearly order's released months). treatment
--    'wallet_membership'; pack quotes are unchanged (same fields and hash).
--  * While the refund is claimed or in flight, pay_waffo_grant_period releases nothing for that order.
--  * A successful refund ends the membership: the order's grants are reversed, the subscription is canceled with credit
--    release terminated, and the cached level follows pay_common_membership_facts. A failed refund restores the
--    credits (as for packs) and releases resume.
-- Mode follows the order (0296/0297). Anchored on the latest bodies; a missing anchor stops the migration. Repeatable.
-- No table or data change. Depends on 0297. Rollback: forward-fix (re-apply the previous bodies).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $patch$
DECLARE p record; fn oid; source text; hits integer;
BEGIN
 FOR p IN SELECT * FROM (VALUES
  (1,'pay_common_package_refund_quote',
   E'IF o.item_type IS DISTINCT FROM \'credit_package\' THEN RAISE EXCEPTION \'PAY_REFUND_TYPE_NOT_IMPLEMENTED\'; END IF;',
   E'IF o.item_type IS DISTINCT FROM \'credit_package\' AND NOT (o.item_type=\'membership_plan\''
   ||E' AND o.payment_method IN (\'wechat_pay\',\'alipay\')\n   AND o.auto_renew IS NOT TRUE)'
   ||E' THEN RAISE EXCEPTION \'PAY_REFUND_TYPE_NOT_IMPLEMENTED\'; END IF;',1),
  (2,'pay_common_package_refund_quote',
   E' total:=(o.purchase_snapshot->>\'credits\')::integer+(o.purchase_snapshot->>\'bonus_credits\')::integer;\n IF total IS NULL OR total<=0\n',
   E' -- R7 B3 (0302): a wallet one-time membership takes back every credit it granted so far (a yearly order: the months\n'
   ||E' -- released); its subscription must still be active and releasing.\n'
   ||E' total:=CASE WHEN o.item_type=\'membership_plan\' THEN (SELECT coalesce(sum(c.amount),0) FROM credit_transactions c\n'
   ||E'   WHERE c.user_id=o.user_id AND c.source_order_id=o.id AND c.amount>0\n'
   ||E'     AND c.idempotency_key LIKE \'payment:\'||o.id::text||\':%\')::integer\n'
   ||E'   ELSE (o.purchase_snapshot->>\'credits\')::integer+(o.purchase_snapshot->>\'bonus_credits\')::integer END;\n'
   ||E' IF o.item_type=\'membership_plan\' AND NOT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.id=o.subscription_id\n'
   ||E'   AND s.user_id=o.user_id AND s.status=\'active\' AND s.credit_release_terminated_at IS NULL)\n'
   ||E'   THEN RAISE EXCEPTION \'PAY_REFUND_ORDER_UNAVAILABLE\'; END IF;\n'
   ||E' IF total IS NULL OR total<=0\n',1),
  (3,'pay_common_package_refund_quote',
   E'   OR (o.payment_method IS NOT NULL AND (SELECT count(*) FROM credit_transactions c WHERE c.user_id=o.user_id\n',
   E'   OR (o.item_type=\'credit_package\' AND o.payment_method IS NOT NULL\n'
   ||E'     AND (SELECT count(*) FROM credit_transactions c WHERE c.user_id=o.user_id\n',1),
  (4,'pay_common_package_refund_quote',
   E'\'reason\',\'ordinary\',\'treatment\',\'credit_package\',\'currency\',o.currency,',
   E'\'reason\',\'ordinary\',\'treatment\',CASE WHEN o.item_type=\'membership_plan\' THEN \'wallet_membership\''
   ||E' ELSE \'credit_package\' END,\'currency\',o.currency,',1),
  (5,'pay_common_package_refund_reject',
   E'IF NOT FOUND OR o.item_type IS DISTINCT FROM \'credit_package\' THEN RAISE EXCEPTION \'PAY_REFUND_ORDER_UNKNOWN\'; END IF;',
   E'IF NOT FOUND OR o.item_type IS DISTINCT FROM \'credit_package\' AND NOT (o.item_type=\'membership_plan\''
   ||E' AND o.payment_method IN (\'wechat_pay\',\'alipay\')\n   AND o.auto_renew IS NOT TRUE)'
   ||E' THEN RAISE EXCEPTION \'PAY_REFUND_ORDER_UNKNOWN\'; END IF;',1),
  (6,'pay_waffo_grant_period',
   E'   OR o.status IS DISTINCT FROM \'completed\' OR o.fulfilled_at IS NULL\n',
   E'   OR o.status IS DISTINCT FROM \'completed\' OR o.fulfilled_at IS NULL\n'
   ||E'   -- R7 B3 (0302): nothing is released while our refund of this order is claimed or in flight.\n'
   ||E'   OR coalesce(o.refund_approval->>\'status\',\'\') IN (\'dispatching\',\'pending\',\'review_required\',\'succeeded\')\n',1),
  (7,'pay_common_package_refund_result',
   E'   updated_at=clock_timestamp() WHERE id=o.id;\n RETURN i;\n',
   E'   updated_at=clock_timestamp() WHERE id=o.id;\n'
   ||E' -- R7 B3 (0302): a refunded wallet membership ends now; the cached level follows the facts (order no longer paid).\n'
   ||E' IF next_status=\'succeeded\' AND o.item_type=\'membership_plan\' THEN\n'
   -- The taken-back grants are reversed (as the monthly and external refunds do): a granted row of a terminated
   -- subscription would otherwise keep quarantining later credits in atomic_pre_deduct.
   ||E'  UPDATE subscription_credit_grants SET status=\'reversed\' WHERE source_order_id=o.id AND status=\'granted\';\n'
   ||E'  UPDATE user_subscriptions SET status=\'canceled\',cancel_at_period_end=\'true\',\n'
   ||E'   credit_release_terminated_at=coalesce(credit_release_terminated_at,clock_timestamp()),\n'
   ||E'   credit_release_terminated_reason=coalesce(credit_release_terminated_reason,\'approved_wallet_refund\')\n'
   ||E'   WHERE id=o.subscription_id AND user_id=o.user_id;\n'
   ||E'  PERFORM pay_common_settle_membership_level(o.user_id);\n'
   ||E' END IF;\n RETURN i;\n',1)
 ) AS t(n,name,old,new,expected) ORDER BY n LOOP
  SELECT CASE WHEN count(*)=1 THEN min(oid) END INTO fn FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname=p.name;
  IF fn IS NULL THEN RAISE EXCEPTION 'PAY_WALLET_REFUND_PATCH_TARGET %',p.name; END IF;
  source:=pg_get_functiondef(fn);
  -- Already patched (one new text keeps its anchor line, so test the new text first).
  IF position(p.new IN source)>0 THEN CONTINUE; END IF;
  hits:=(length(source)-length(replace(source,p.old,'')))/length(p.old);
  IF hits<>p.expected THEN RAISE EXCEPTION 'PAY_WALLET_REFUND_PATCH_MISSING % (% found)',p.n,hits; END IF;
  EXECUTE replace(source,p.old,p.new);
 END LOOP;
END $patch$;

COMMIT;
