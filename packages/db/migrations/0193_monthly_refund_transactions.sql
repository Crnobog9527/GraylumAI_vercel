-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Ordinary monthly first-purchase refunds. Order approval is the only intent authority.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.monthly_refund_assert_admin(p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'PAY_REFUND_ADMIN_REQUIRED'; END IF;
END $$;

-- Called under profile -> order -> subscription -> grants locks. Provider facts are
-- server-read, not client input; this function independently checks all local facts.
CREATE OR REPLACE FUNCTION public.monthly_refund_validate(p_actor uuid,p_order uuid,p_terms jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;s user_subscriptions;t tickets;g subscription_credit_grants;
 total bigint:=0;paid timestamptz;fee bigint;witness jsonb;
BEGIN
 PERFORM monthly_refund_assert_admin(p_actor);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 SELECT * INTO s FROM user_subscriptions WHERE id=o.subscription_id FOR UPDATE;
 SELECT * INTO t FROM tickets WHERE id=(p_terms->>'ticketId')::uuid FOR SHARE;
 IF o.id IS NULL OR s.id IS NULL OR t.id IS NULL OR p_terms IS NULL
 OR p_terms->>'kind' IS DISTINCT FROM 'monthly_first_purchase'
 OR p_terms->>'orderId' IS DISTINCT FROM o.id::text OR p_terms->>'userId' IS DISTINCT FROM o.user_id::text
 OR p_terms->>'subscriptionId' IS DISTINCT FROM s.id::text OR s.user_id IS DISTINCT FROM o.user_id
 OR t.user_id IS DISTINCT FROM o.user_id OR t.category IS DISTINCT FROM 'billing' OR t.is_deleted IS DISTINCT FROM 'false'
 OR o.item_type IS DISTINCT FROM 'membership_plan' OR o.billing_cycle IS DISTINCT FROM 'monthly'
 OR s.billing_cycle IS DISTINCT FROM 'monthly' OR o.source_order_id IS NOT NULL
 OR o.status IS DISTINCT FROM 'completed' OR o.payment_status IS DISTINCT FROM 'paid' OR o.fulfilled_at IS NULL
 OR s.status IS DISTINCT FROM 'active' OR s.credit_release_terminated_at IS NOT NULL
 OR s.current_period_end IS DISTINCT FROM (p_terms->>'periodEnd')::timestamptz OR s.current_period_end<=clock_timestamp()
 OR s.cancel_at_period_end IS DISTINCT FROM p_terms->>'originalCancelAtPeriodEnd'
 OR o.purchase_snapshot IS NULL OR o.purchase_snapshot IS DISTINCT FROM p_terms->'snapshot'
 OR s.contract_snapshot IS DISTINCT FROM o.purchase_snapshot OR s.membership_plan_id IS DISTINCT FROM o.item_id
 OR o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_mode IS DISTINCT FROM 'test'
 OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.payment_mode IS DISTINCT FROM 'test'
 OR o.merchant_namespace IS NULL OR o.merchant_namespace IS DISTINCT FROM s.merchant_namespace
 OR o.merchant_namespace IS DISTINCT FROM p_terms->>'merchant' OR p_terms->>'mode' IS DISTINCT FROM 'test'
 OR s.stripe_subscription_id IS DISTINCT FROM p_terms->>'providerSubscriptionId'
 OR p_terms->>'plan' IS NULL OR p_terms->>'plan' NOT IN ('pro','gold')
 OR o.purchase_membership_level IS DISTINCT FROM p_terms->>'plan'
 OR NOT EXISTS(SELECT 1 FROM membership_plans WHERE id=s.membership_plan_id AND level=p_terms->>'plan')
 OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=o.user_id AND status='active' AND is_deleted='false')
 OR o.refund_approval IS NOT NULL AND (o.refund_approval->>'kind' IS DISTINCT FROM 'monthly_first_purchase'
   OR o.refund_approval->>'status' IS DISTINCT FROM 'approved')
 THEN RAISE EXCEPTION 'PAY_MONTHLY_SCOPE_OR_STATE'; END IF;
 paid:=(p_terms->>'paidAt')::timestamptz;
 IF paid IS NULL OR paid>t.created_at OR t.created_at>clock_timestamp()
 OR t.created_at-paid>interval '168 hours' OR t.created_at IS DISTINCT FROM (p_terms->>'submittedAt')::timestamptz
 THEN RAISE EXCEPTION 'PAY_REFUND_WINDOW'; END IF;
 IF o.amount_total IS NULL OR o.amount_total<=0 OR o.currency IS DISTINCT FROM p_terms->>'currency'
 OR o.amount_total IS DISTINCT FROM (p_terms->>'paidMinor')::bigint
 OR o.amount_total IS DISTINCT FROM (p_terms->>'basisMinor')::bigint
 OR p_terms->>'feePermitted' IS NULL OR p_terms->>'feePermitted' NOT IN ('confirmed','not_permitted')
 OR nullif(btrim(p_terms->>'feeEvidence'),'') IS NULL OR length(p_terms->>'feeEvidence')>160
 OR nullif(p_terms->>'chargeId','') IS NULL OR nullif(p_terms->>'paymentIntentId','') IS NULL
 THEN RAISE EXCEPTION 'PAY_MONTHLY_CASH'; END IF;
 fee:=CASE WHEN p_terms->>'feePermitted'='confirmed' THEN o.amount_total::bigint*6/100 ELSE 0 END;
 IF fee IS DISTINCT FROM (p_terms->>'feeMinor')::bigint
 OR o.amount_total-fee IS DISTINCT FROM (p_terms->>'netMinor')::bigint
 THEN RAISE EXCEPTION 'PAY_MONTHLY_AMOUNT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='invoice'
 AND external_id=p_terms->>'invoiceId' AND channel='stripe' AND mode='test' AND merchant_namespace=o.merchant_namespace)
 OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=s.id AND object_type='subscription'
 AND external_id=s.stripe_subscription_id AND channel='stripe' AND mode='test' AND merchant_namespace=o.merchant_namespace)
 OR EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='refund')
 OR (SELECT count(*) FROM payment_orders WHERE user_id=o.user_id AND item_type='membership_plan')<>1
 OR (SELECT count(*) FROM user_subscriptions WHERE user_id=o.user_id)<>1
 THEN RAISE EXCEPTION 'PAY_MONTHLY_HISTORY'; END IF;
 IF EXISTS(SELECT 1 FROM billing_history h WHERE h.user_id=o.user_id AND h.operation_type='pre_deduct'
 AND NOT EXISTS(SELECT 1 FROM billing_history d WHERE d.user_id=h.user_id
 AND d.operation_type IN ('settle','refund','abort_settle') AND d.metadata->>'preDeductId'=h.id::text))
 THEN RAISE EXCEPTION 'PAY_REFUND_SETTLEMENT_UNRESOLVED'; END IF;
 IF EXISTS(SELECT 1 FROM credit_transactions c WHERE c.user_id=o.user_id AND c.created_at>=paid
 AND (c.counts_as_spend=true AND c.amount<>0 OR c.ledger_type='spend' AND c.amount<>0 OR c.amount<0 AND
 (c.ledger_type IS NULL OR c.ledger_type NOT IN ('refund_clawback','adjustment','expiration','spend')
 OR c.ledger_type='adjustment' AND coalesce(c.source_type,'')<>'admin'
 AND coalesce(c.reason_code,'')<>'bill2_reserve' AND coalesce(c.idempotency_key,'') NOT LIKE 'admin_adjustment:%'
 AND coalesce(c.idempotency_key,'') NOT LIKE 'admin_credit_deduction:%')))
 THEN RAISE EXCEPTION 'PAY_REFUND_CONSUMPTION_OR_UNKNOWN'; END IF;
 FOR g IN SELECT * FROM subscription_credit_grants WHERE user_id=o.user_id ORDER BY id FOR UPDATE LOOP
  IF g.source_order_id IS DISTINCT FROM o.id OR g.subscription_id IS DISTINCT FROM s.id
  OR g.status IS DISTINCT FROM 'granted' OR g.accounting_state IS DISTINCT FROM 'trusted' OR g.consumed_amount<>0
  OR g.grant_snapshot IS DISTINCT FROM o.purchase_snapshot OR g.billing_cycle IS DISTINCT FROM 'monthly'
  OR g.grant_type IS DISTINCT FROM 'monthly_invoice' OR g.stripe_invoice_id IS DISTINCT FROM p_terms->>'invoiceId'
  OR g.stripe_subscription_id IS DISTINCT FROM s.stripe_subscription_id
  OR g.period_start IS DISTINCT FROM s.current_period_start OR g.period_end IS DISTINCT FROM s.current_period_end
  OR g.credits_granted<=0 OR NOT EXISTS(SELECT 1 FROM credit_transactions c WHERE c.id=g.credit_transaction_id
   AND c.user_id=o.user_id AND c.source_order_id=o.id AND c.ledger_type='grant' AND c.amount=g.credits_granted)
  THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
  total:=total+g.credits_granted;
 END LOOP;
 IF total<=0 OR total IS DISTINCT FROM (p_terms->>'credits')::bigint
 OR total IS DISTINCT FROM (o.purchase_snapshot->>'credits')::bigint+(o.purchase_snapshot->>'bonus_credits')::bigint
 OR (SELECT credits FROM profiles WHERE id=o.user_id)<total THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
 -- Bind approval to every local financial row, without retaining personal content.
 witness:=jsonb_build_object('order',to_jsonb(o)-ARRAY['refund_approval','updated_at','metadata','checkout_request'],
  'subscription',to_jsonb(s)-ARRAY['metadata','updated_at'],'ticket',jsonb_build_object('id',t.id,'at',t.created_at),
  'ledger',(SELECT jsonb_agg(jsonb_build_array(id,amount,ledger_type,counts_as_spend,source_type,reason_code,
   source_order_id,idempotency_key,created_at) ORDER BY id) FROM credit_transactions WHERE user_id=o.user_id),
  'grants',(SELECT jsonb_agg(to_jsonb(x)-ARRAY['metadata','updated_at'] ORDER BY id) FROM subscription_credit_grants x WHERE user_id=o.user_id),
  'holds',(SELECT jsonb_agg(jsonb_build_array(id,operation_type,metadata->>'preDeductId') ORDER BY id)
   FROM billing_history WHERE user_id=o.user_id));
 RETURN md5(witness::text);
END $$;

CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_approve(
 p_actor uuid,p_order uuid,p_terms jsonb,p_version text,p_local_version text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fingerprint text;i jsonb;
BEGIN
 fingerprint:=monthly_refund_validate(p_actor,p_order,p_terms);
 IF p_version IS NULL OR p_version !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PAY_REFUND_VERSION'; END IF;
 IF p_local_version IS NULL THEN RETURN jsonb_build_object('localVersion',fingerprint); END IF;
 IF p_local_version IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'PAY_REFUND_STALE_PREVIEW'; END IF;
 SELECT refund_approval INTO i FROM payment_orders WHERE id=p_order;
 IF i IS NOT NULL THEN
  IF i->'terms'=p_terms AND i->>'versionHash'=p_version AND i->>'localVersion'=fingerprint THEN RETURN i; END IF;
  RAISE EXCEPTION 'PAY_REFUND_ALREADY_APPROVED';
 END IF;
 i:=jsonb_build_object('kind','monthly_first_purchase','id',gen_random_uuid(),'status','approved',
 'terms',p_terms,'versionHash',p_version,'localVersion',fingerprint,'approvedBy',p_actor,'approvedAt',clock_timestamp(),
 'claimedAt',NULL,'started',jsonb_build_object('stop_renewal',NULL,'refund',NULL,'cancel',NULL,'restore_renewal',NULL),
 'recordedRefund',NULL,'hold','none','revision',0);
 UPDATE payment_orders SET refund_approval=i WHERE id=p_order;
 RETURN i;
END $$;

CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_claim(
 p_actor uuid,p_order uuid,p_intent uuid,p_terms jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;v text;balance integer;o payment_orders;
BEGIN
 v:=monthly_refund_validate(p_actor,p_order,p_terms);
 SELECT * INTO o FROM payment_orders WHERE id=p_order;
 i:=o.refund_approval;
 IF i IS NULL OR i->>'id' IS DISTINCT FROM p_intent::text OR i->'terms' IS DISTINCT FROM p_terms
 OR i->>'localVersion' IS DISTINCT FROM v THEN RAISE EXCEPTION 'PAY_REFUND_STALE_APPROVAL'; END IF;
 SELECT credits INTO balance FROM profiles WHERE id=o.user_id;
 -- Single source reservation. No terminal subscription signal is written before cash success.
 PERFORM set_config('pay_common.monthly_transition',p_intent::text,true);
 UPDATE profiles SET credits=credits-(p_terms->>'credits')::integer,membership_level='free' WHERE id=o.user_id;
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,source_order_id,
 idempotency_key,balance_before,balance_after)
 VALUES(o.user_id,-(p_terms->>'credits')::integer,'deduction','refund_clawback','refund_clawback','stripe_refund',o.id,
 'pay-common:monthly-refund:'||p_intent||':hold',balance,balance-(p_terms->>'credits')::integer);
 UPDATE subscription_credit_grants SET status='reversed' WHERE source_order_id=o.id;
 UPDATE user_subscriptions SET status='paused' WHERE id=o.subscription_id;
 i:=i||jsonb_build_object('status','review_required','claimedAt',clock_timestamp(),'hold','held','revision',1,
 'idempotencyKey','pay-common:monthly-refund:'||p_intent||':refund');
 UPDATE payment_orders SET refund_approval=i WHERE id=o.id;
 PERFORM set_config('pay_common.monthly_transition','',true);
 RETURN i;
END $$;

-- Prevent ordinary lifecycle/invoice/plan writers from reopening the held source.
-- Existing erasure projections only change metadata/content fields and remain possible.
CREATE OR REPLACE FUNCTION public.monthly_refund_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;sid uuid;prior jsonb;incoming jsonb;
BEGIN
 prior:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 incoming:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 sid:=CASE WHEN TG_TABLE_NAME='user_subscriptions' THEN coalesce(incoming,prior)->>'id'
 ELSE coalesce(incoming,prior)->>'subscription_id' END;
 SELECT refund_approval INTO i FROM payment_orders WHERE subscription_id=sid
 AND refund_approval->>'kind'='monthly_first_purchase' AND refund_approval->>'hold' IN ('held','terminated') LIMIT 1;
 IF i IS NOT NULL AND current_setting('pay_common.monthly_transition',true) IS DISTINCT FROM i->>'id'
 AND (TG_OP<>'UPDATE' OR
 (prior-ARRAY['metadata','metadata_scrubbed_at','updated_at']) IS DISTINCT FROM
 (incoming-ARRAY['metadata','metadata_scrubbed_at','updated_at'])) THEN RAISE EXCEPTION 'PAY_MONTHLY_SOURCE_HELD'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS monthly_refund_source_guard ON public.user_subscriptions;
CREATE TRIGGER monthly_refund_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.user_subscriptions
 FOR EACH ROW EXECUTE FUNCTION public.monthly_refund_source_guard();
DROP TRIGGER IF EXISTS monthly_refund_source_guard ON public.subscription_credit_grants;
CREATE TRIGGER monthly_refund_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_credit_grants
 FOR EACH ROW EXECUTE FUNCTION public.monthly_refund_source_guard();

DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['monthly_refund_assert_admin(uuid)','monthly_refund_validate(uuid,uuid,jsonb)',
 'monthly_refund_source_guard()'] LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC,anon,authenticated,service_role'; END LOOP;
 FOREACH f IN ARRAY ARRAY['pay_common_monthly_refund_approve(uuid,uuid,jsonb,text,text)',
 'pay_common_monthly_refund_claim(uuid,uuid,uuid,jsonb)'] LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC,anon,authenticated';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||f||' TO service_role'; END LOOP;
END $$;
COMMIT;
