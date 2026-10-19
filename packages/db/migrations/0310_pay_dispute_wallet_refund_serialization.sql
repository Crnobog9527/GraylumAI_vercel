-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-DISPUTE-GUARD D2. Serialize wallet-pack refunds with dispute creation.
-- Rollback: stop dispute/refund webhook dispatch, restore the predecessor
-- atomic_reconcile_stripe_refund and pay_stripe_mp_record_external_refund bodies,
-- then forward-fix. Keep all refund and dispute financial records; never delete
-- ledger rows or restore balances from a backup.
BEGIN;
SET LOCAL lock_timeout='5s';

-- The existing legacy refund RPC is the sole path for ordinary wallet-pack refunds.
-- Add the dispute canonical lock before its profile/order locks, then convert a
-- successful wallet-pack refund to the dispute-aware recorder if the dispute won
-- the lock. If the refund wins first, its original idempotent reconciliation runs
-- under that same lock and dispute receipt waits until it commits.
DO $patch$ DECLARE sig text;src text;anchor text;replacement text;BEGIN
 sig:='public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)';
 src:=pg_get_functiondef(sig::regprocedure);
 IF position('-- PAY-D2 dispute-lock' IN src)>0 THEN RETURN; END IF;
 anchor:='DECLARE o payment_orders;';
 IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_WALLET_REFUND_DECL_PATCH'; END IF;
 src:=replace(src,anchor,'DECLARE o payment_orders; external_result jsonb;');
 anchor:='PERFORM 1 FROM profiles WHERE id=(SELECT x.user_id FROM payment_orders x WHERE x.id=p_order_id) FOR UPDATE;';
 IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_WALLET_REFUND_LOCK_PATCH'; END IF;
 src:=replace(src,anchor,E'SELECT * INTO o FROM payment_orders WHERE id=p_order_id;\n'
  ||E' PERFORM pay_dispute_lock(coalesce(o.dispute_payment_key,CASE WHEN p_payment_intent_id ~ ''^pi_[A-Za-z0-9_]{1,160}$''\n'
  ||E'  THEN o.merchant_namespace||'':''||o.payment_mode||'':''||p_payment_intent_id END,'
  ||E' (SELECT o.merchant_namespace||'':''||o.payment_mode||'':''||r.external_id FROM payment_provider_refs r'
  ||E'  WHERE r.order_id=o.id AND r.channel=''stripe'' AND r.merchant_namespace=o.merchant_namespace'
  ||E'   AND r.mode=o.payment_mode AND r.object_type=''payment'' AND r.external_id ~ ''^pi_[A-Za-z0-9_]{1,160}$'''
  ||E'  ORDER BY r.external_id LIMIT 1)),o.dispute_subscription_key);\n'
  ||anchor||' -- PAY-D2 dispute-lock');
 anchor:=' RETURN QUERY SELECT * FROM atomic_reconcile_stripe_refund_before_pr4b(p_order_id,p_idempotency_key,'||E'\n'
  ||' p_refund_event_type,p_refund_id,p_refund_status,p_refund_amount,p_refund_currency,p_charge_id,p_payment_intent_id,'||E'\n'
  ||' p_invoice_id,p_subscription_id,p_refund_reason,p_refund_created_at,p_is_full_refund,p_is_failed);';
 replacement:=E' IF o.item_type=''credit_package'' AND o.payment_method IN (''wechat_pay'',''alipay'')'
  ||E' AND NOT p_is_failed AND p_refund_status=''succeeded'''
  ||E' AND EXISTS(SELECT 1 FROM payment_disputes d WHERE d.order_id=o.id'
  ||E'  AND d.freeze_state IN (''pending'',''frozen'',''review'',''superseded'')) THEN'
  ||E'  IF coalesce(p_refund_id,'''') !~ ''^re_[A-Za-z0-9_]{1,160}$'''
  ||E'   OR coalesce(p_refund_amount,0)<=0 OR coalesce(p_refund_currency,'''')='''' THEN'
  ||E'   RAISE EXCEPTION ''PAY_DISPUTE_WALLET_REFUND_EVIDENCE''; END IF;'
  ||E'  external_result:=pay_stripe_mp_record_external_refund(o.id,o.merchant_namespace,'
  ||E'   coalesce(p_payment_intent_id,substring(o.dispute_payment_key FROM length(o.merchant_namespace||'':''||o.payment_mode||'':'')+1),'
  ||E'    (SELECT r.external_id FROM payment_provider_refs r WHERE r.order_id=o.id AND r.channel=''stripe'''
  ||E'     AND r.merchant_namespace=o.merchant_namespace AND r.mode=o.payment_mode AND r.object_type=''payment'''
  ||E'     AND r.external_id ~ ''^pi_[A-Za-z0-9_]{1,160}$'' ORDER BY r.external_id LIMIT 1)),'
  ||E'   p_refund_id,p_refund_amount,p_refund_currency,p_refund_created_at);'
  ||E'  RETURN QUERY SELECT o.id,o.user_id,CASE WHEN p_is_full_refund THEN ''refunded'' ELSE o.status END,'
  ||E'   0,0,NULL::uuid,coalesce((external_result->>''duplicate'')::boolean,false); RETURN;'
  ||E' END IF;'
  ||anchor;
 IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_WALLET_REFUND_ROUTE_PATCH'; END IF;
 EXECUTE replace(src,anchor,replacement);
END $patch$;

-- The dispute-aware recorder already owns source holds for pending/frozen/review
-- states too; keep its wallet-pack scope aligned with the locked router.
DO $patch$ DECLARE sig text;src text;anchor text;replacement text;BEGIN
 sig:='public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)';
 src:=pg_get_functiondef(sig::regprocedure);
 IF position('freeze_state IN (''pending'',''frozen'',''review'',''superseded'')' IN src)>0 THEN RETURN; END IF;
 anchor:=E'pay_dispute_order_frozen(o.id)\n  OR EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=o.id AND freeze_state=''superseded'')';
 replacement:=E'EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=o.id'
  ||E'  AND freeze_state IN (''pending'',''frozen'',''review'',''superseded''))';
 IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_WALLET_REFUND_SCOPE_PATCH'; END IF;
 EXECUTE replace(src,anchor,replacement);
END $patch$;

COMMIT;
