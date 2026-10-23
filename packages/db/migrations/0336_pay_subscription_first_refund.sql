-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- PAY-REFUND: annual/founder first-purchase refunds extend the existing subscription intent.
-- Controller assigned 0336 on 2026-10-23; remote application remains with the controller.
-- Database first, same RPC signatures and monthly intent/hash format. Repeatable, no data rewrite.
-- Recovery: forward-fix. Never roll back financial rows or provider refunds; unresolved intents stay held.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Anchored patches retain the later mode, dispute, source-lock and account-erasure protections.
CREATE OR REPLACE FUNCTION pg_temp.pay_subscription_refund_patch(p_sig text,p_old text,p_new text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE src text;
BEGIN
 src:=pg_get_functiondef(p_sig::regprocedure);
 IF position(p_new IN src)>0 THEN RETURN; END IF;
 IF array_length(string_to_array(src,p_old),1)<>2 THEN
  RAISE EXCEPTION 'PAY_SUBSCRIPTION_REFUND_PATCH_MISMATCH %',p_sig;
 END IF;
 EXECUTE replace(src,p_old,p_new);
END $$;

SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$total bigint:=0;paid timestamptz;fee bigint;witness jsonb;card boolean;tax bigint:=0;$old$,
 $new$total bigint:=0;paid timestamptz;fee bigint;witness jsonb;card boolean;tax bigint:=0;
 prior payment_orders;old_sub user_subscriptions;upgraded boolean;annual boolean;grant_count integer:=0;$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$card:=coalesce(o.payment_method IN ('card','card_cn'),false);$old$,
 $new$card:=coalesce(o.payment_method IN ('card','card_cn'),false);
 annual:=coalesce(o.billing_cycle='yearly',false);upgraded:=coalesce(o.method_transition='upgrade',false);
 IF upgraded THEN
  SELECT * INTO old_sub FROM user_subscriptions WHERE id=o.method_prior_subscription FOR UPDATE;
  SELECT * INTO prior FROM payment_orders WHERE id=o.source_order_id FOR UPDATE;
  IF NOT card OR old_sub.id IS NULL OR prior.id IS NULL OR prior.subscription_id IS DISTINCT FROM old_sub.id
   OR prior.user_id IS DISTINCT FROM o.user_id OR old_sub.user_id IS DISTINCT FROM o.user_id
   OR prior.item_type IS DISTINCT FROM 'membership_plan' OR prior.purchase_membership_level IS DISTINCT FROM 'pro'
   OR prior.qualification_state IS DISTINCT FROM 'sold' OR prior.method_review_reason IS NOT NULL
   OR old_sub.membership_plan_id IS DISTINCT FROM prior.item_id
   OR old_sub.contract_snapshot IS DISTINCT FROM prior.purchase_snapshot
   OR old_sub.status IS NULL OR old_sub.status NOT IN ('active','canceled','cancelled')
   OR o.purchase_membership_level IS DISTINCT FROM 'gold' OR prior.status IS DISTINCT FROM 'completed'
   OR prior.payment_status IS DISTINCT FROM 'paid' OR prior.fulfilled_at IS NULL
   OR old_sub.credit_release_terminated_at IS NOT NULL OR old_sub.cancel_at_period_end IS DISTINCT FROM 'true'
   OR old_sub.current_period_end IS DISTINCT FROM prior.entitlement_end
   OR p_terms->'priorPro' IS NULL OR jsonb_typeof(p_terms->'priorPro') IS DISTINCT FROM 'object'
   OR (p_terms->'priorPro')-ARRAY['orderId','subscriptionId','providerSubscriptionId','invoiceId','periodEnd','autoRenew']<>'{}'::jsonb
   OR jsonb_typeof(p_terms->'priorPro'->'autoRenew') IS DISTINCT FROM 'boolean'
   OR p_terms->'priorPro'->'autoRenew' IS DISTINCT FROM to_jsonb(prior.auto_renew)
   OR p_terms->'priorPro'->>'orderId' IS DISTINCT FROM prior.id::text
   OR p_terms->'priorPro'->>'subscriptionId' IS DISTINCT FROM old_sub.id::text
   OR (p_terms->'priorPro'->>'periodEnd')::timestamptz IS DISTINCT FROM prior.entitlement_end
   OR prior.payment_channel IS DISTINCT FROM 'stripe' OR old_sub.payment_channel IS DISTINCT FROM 'stripe'
   OR prior.payment_mode IS DISTINCT FROM o.payment_mode OR old_sub.payment_mode IS DISTINCT FROM o.payment_mode
   OR prior.merchant_namespace IS DISTINCT FROM o.merchant_namespace
   OR old_sub.merchant_namespace IS DISTINCT FROM o.merchant_namespace
   OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=prior.id AND object_type='payment'
    AND external_id=p_terms->'priorPro'->>'invoiceId' AND channel='stripe' AND mode=o.payment_mode
    AND merchant_namespace=o.merchant_namespace)
   OR prior.auto_renew IS NULL OR old_sub.stripe_subscription_id IS NOT NULL
   OR prior.auto_renew AND (prior.payment_method IS NULL OR prior.payment_method NOT IN ('card','card_cn')
    OR jsonb_typeof(p_terms->'priorPro'->'providerSubscriptionId') IS DISTINCT FROM 'string'
    OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=old_sub.id AND object_type='subscription'
     AND external_id=p_terms->'priorPro'->>'providerSubscriptionId' AND channel='stripe' AND mode=o.payment_mode
     AND merchant_namespace=o.merchant_namespace))
   OR prior.auto_renew IS FALSE AND (prior.payment_method IS NULL OR prior.payment_method NOT IN ('wechat_pay','alipay')
    OR p_terms->'priorPro'->'providerSubscriptionId' IS DISTINCT FROM 'null'::jsonb
    OR EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=old_sub.id AND object_type='subscription'))
   OR pay_dispute_order_frozen(prior.id)
  THEN RAISE EXCEPTION 'PAY_REFUND_PRIOR_PRO_UNRESOLVED'; END IF;
 ELSIF p_terms ? 'priorPro' THEN RAISE EXCEPTION 'PAY_REFUND_PRIOR_PRO_UNRESOLVED'; END IF;$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$OR o.item_type IS DISTINCT FROM 'membership_plan' OR o.billing_cycle IS DISTINCT FROM 'monthly'
 OR s.billing_cycle IS DISTINCT FROM 'monthly' OR o.source_order_id IS NOT NULL$old$,
 $new$OR o.item_type IS DISTINCT FROM 'membership_plan' OR o.billing_cycle IS NULL OR o.billing_cycle NOT IN ('monthly','yearly')
 OR s.billing_cycle IS DISTINCT FROM o.billing_cycle
 OR o.purchase_snapshot->>'billing_cycle' IS DISTINCT FROM o.billing_cycle OR annual AND NOT card
 OR o.source_order_id IS NOT NULL AND NOT upgraded
 OR card AND (o.method_transition IS NOT NULL AND NOT upgraded OR o.offer_kind='founder_renewal')$new$);
-- The ordinary path still requires exactly one paid membership. An upgrade permits only its exact Pro chain.
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$OR (SELECT count(*) FROM payment_orders x WHERE x.user_id=o.user_id AND x.item_type='membership_plan'
  AND (NOT card OR x.payment_method IS NULL OR x.payment_method NOT IN ('card','card_cn')
   OR x.qualification_state IS DISTINCT FROM 'released'
   OR x.fulfilled_at IS NOT NULL OR x.payment_status IN ('paid','refunded','partially_refunded')
   OR EXISTS(SELECT 1 FROM payment_provider_refs r WHERE r.order_id=x.id AND r.object_type IN ('payment','invoice'))))<>1
 OR (SELECT count(*) FROM user_subscriptions WHERE user_id=o.user_id)<>1$old$,
 $new$OR (NOT upgraded AND (SELECT count(*) FROM payment_orders x WHERE x.user_id=o.user_id AND x.item_type='membership_plan'
  AND (NOT card OR x.payment_method IS NULL OR x.payment_method NOT IN ('card','card_cn')
   OR x.qualification_state IS DISTINCT FROM 'released'
   OR x.fulfilled_at IS NOT NULL OR x.payment_status IN ('paid','refunded','partially_refunded')
   OR EXISTS(SELECT 1 FROM payment_provider_refs r WHERE r.order_id=x.id AND r.object_type IN ('payment','invoice'))))<>1)
 OR upgraded AND EXISTS(SELECT 1 FROM payment_orders x WHERE x.user_id=o.user_id AND x.item_type='membership_plan'
  AND x.id<>o.id AND x.subscription_id IS DISTINCT FROM old_sub.id
  AND (x.qualification_state IS DISTINCT FROM 'released' OR x.fulfilled_at IS NOT NULL
   OR x.payment_status IN ('paid','refunded','partially_refunded') OR EXISTS(SELECT 1 FROM payment_provider_refs r
    WHERE r.order_id=x.id AND r.object_type IN ('payment','invoice'))))
 OR (SELECT count(*) FROM user_subscriptions WHERE user_id=o.user_id)<>(CASE WHEN upgraded THEN 2 ELSE 1 END)$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$FOR g IN SELECT * FROM subscription_credit_grants WHERE user_id=o.user_id ORDER BY id FOR UPDATE LOOP$old$,
 $new$IF EXISTS(SELECT 1 FROM subscription_credit_grants x WHERE x.user_id=o.user_id
  AND x.source_order_id IS DISTINCT FROM o.id AND (NOT upgraded OR x.subscription_id IS DISTINCT FROM old_sub.id))
 THEN RAISE EXCEPTION 'PAY_REFUND_GRANT_UNRESOLVED'; END IF;
 FOR g IN SELECT * FROM subscription_credit_grants WHERE source_order_id=o.id ORDER BY id FOR UPDATE LOOP
  grant_count:=grant_count+1;$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$OR g.grant_snapshot IS DISTINCT FROM o.purchase_snapshot OR g.billing_cycle IS DISTINCT FROM 'monthly'
  OR g.grant_type IS DISTINCT FROM 'monthly_invoice'$old$,
 $new$OR g.grant_snapshot IS DISTINCT FROM o.purchase_snapshot OR g.billing_cycle IS DISTINCT FROM o.billing_cycle
  OR g.grant_type IS DISTINCT FROM (CASE WHEN annual THEN 'annual_monthly_release' ELSE 'monthly_invoice' END)$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$OR g.period_start IS DISTINCT FROM s.current_period_start OR g.period_end IS DISTINCT FROM s.current_period_end$old$,
 $new$OR (NOT annual AND (g.period_start IS DISTINCT FROM s.current_period_start OR g.period_end IS DISTINCT FROM s.current_period_end))
  OR annual AND (g.total_periods IS DISTINCT FROM 12 OR g.period_index IS NULL OR g.period_index NOT BETWEEN 1 AND 12
   OR g.grant_period_key IS DISTINCT FROM 'payment:'||o.id||':'||lpad(g.period_index::text,2,'0')
   OR g.idempotency_key IS DISTINCT FROM g.grant_period_key
   OR g.period_start IS DISTINCT FROM ((o.entitlement_start AT TIME ZONE 'UTC')+make_interval(months=>g.period_index-1)) AT TIME ZONE 'UTC'
   OR g.period_end IS DISTINCT FROM least(o.entitlement_end,((o.entitlement_start AT TIME ZONE 'UTC')
    +make_interval(months=>g.period_index)) AT TIME ZONE 'UTC') OR g.period_start>clock_timestamp()
   OR g.credits_granted IS DISTINCT FROM (o.purchase_snapshot->>'credits')::integer/12
    +(CASE WHEN g.period_index<=(o.purchase_snapshot->>'credits')::integer%12 THEN 1 ELSE 0 END))$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$OR total IS DISTINCT FROM (o.purchase_snapshot->>'credits')::bigint+(o.purchase_snapshot->>'bonus_credits')::bigint$old$,
 $new$OR NOT annual AND total IS DISTINCT FROM (o.purchase_snapshot->>'credits')::bigint+(o.purchase_snapshot->>'bonus_credits')::bigint
 OR annual AND (coalesce((o.purchase_snapshot->>'bonus_credits')::bigint,-1)<>0
  OR grant_count<>(SELECT count(*) FROM generate_series(1,12) idx WHERE
   ((o.entitlement_start AT TIME ZONE 'UTC')+make_interval(months=>idx-1)) AT TIME ZONE 'UTC'<=clock_timestamp())
  OR grant_count<>(SELECT count(DISTINCT period_index) FROM subscription_credit_grants WHERE source_order_id=o.id))$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.monthly_refund_validate(uuid,uuid,jsonb)',
 $old$RETURN md5(witness::text);$old$,
 $new$IF upgraded THEN witness:=witness||jsonb_build_object('priorPro',
  jsonb_build_object('order',to_jsonb(prior)-ARRAY['metadata','updated_at'],
   'subscription',to_jsonb(old_sub)-ARRAY['metadata','updated_at'])); END IF;
 RETURN md5(witness::text);$new$);

SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_monthly_refund_reject(uuid,uuid,uuid,text)',
 $old$OR o.billing_cycle IS DISTINCT FROM 'monthly'$old$,
 $new$OR o.billing_cycle IS NULL OR o.billing_cycle NOT IN ('monthly','yearly')$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_monthly_refund_start(uuid,uuid,uuid,integer,text,jsonb)',
 $old$cash:=i->'recordedRefund'->>'status';$old$,
 $new$cash:=i->'recordedRefund'->>'status';
 IF t ? 'priorPro' AND p_stage IN ('stop_renewal','refund') AND NOT EXISTS(
  SELECT 1 FROM user_subscriptions WHERE id=(t->'priorPro'->>'subscriptionId')::uuid
   AND user_id=(t->>'userId')::uuid AND cancel_at_period_end='true'
   AND current_period_end=(t->'priorPro'->>'periodEnd')::timestamptz
   AND credit_release_terminated_at IS NULL)
 THEN RAISE EXCEPTION 'PAY_REFUND_PRIOR_PRO_UNRESOLVED'; END IF;$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
 $old$IF sub->>'status' IS DISTINCT FROM 'canceled' THEN RAISE EXCEPTION 'PAY_MONTHLY_CANCEL_UNRESOLVED'; END IF;$old$,
 $new$IF sub->>'status' IS DISTINCT FROM 'canceled'
   OR jsonb_typeof(sub->'cancelAtPeriodEnd') IS DISTINCT FROM 'boolean'
   OR t->>'originalCancelAtPeriodEnd'='false' AND sub->>'cancelAtPeriodEnd' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'PAY_MONTHLY_CANCEL_UNRESOLVED'; END IF;$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
 $old$UPDATE user_subscriptions SET status='canceled',cancel_at_period_end='true',credit_release_terminated_at=clock_timestamp(),$old$,
 $new$UPDATE user_subscriptions SET status='canceled',cancel_at_period_end=sub->>'cancelAtPeriodEnd',credit_release_terminated_at=clock_timestamp(),$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
 $old$i:=i||jsonb_build_object('revision',(i->>'revision')::integer+1,'finishedAt',clock_timestamp());$old$,
 $new$i:=i||jsonb_build_object('revision',(i->>'revision')::integer+1,'finishedAt',clock_timestamp(),
  'renewalEvidence',jsonb_build_object('beforeCancelAtPeriodEnd',(t->>'originalCancelAtPeriodEnd')::boolean,
   'afterCancelAtPeriodEnd',(sub->>'cancelAtPeriodEnd')::boolean));$new$);
SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
 $old$UPDATE payment_orders SET refund_approval=i WHERE id=p_order;
 PERFORM set_config('pay_common.monthly_transition','',true);$old$,
 $new$UPDATE payment_orders SET refund_approval=i WHERE id=p_order;
 -- The claim temporarily lowered the cache. The paid projection restores only the original surviving Pro term.
 -- Neither its period nor its renewal flag is changed, and annual Pro releases keep their original dates.
 IF cash='succeeded' AND t ? 'priorPro' THEN
  UPDATE profiles SET membership_level=CASE
   WHEN pay_common_membership_facts((t->>'userId')::uuid)->'internal_membership'->>'mapping_state'='internal_paid'
    AND pay_common_membership_facts((t->>'userId')::uuid)->'internal_membership'->>'id'=t->'priorPro'->>'subscriptionId'
   THEN 'pro' ELSE 'free' END WHERE id=(t->>'userId')::uuid AND status='active' AND is_deleted='false'
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=(t->>'userId')::uuid);
 END IF;
 PERFORM set_config('pay_common.monthly_transition','',true);$new$);

-- Preserve the existing strict monthly proof, including tax and live/test handling, behind a bounded wrapper.
DO $$ BEGIN
 IF to_regprocedure('public.monthly_refund_erasure_safe_pre_annual(jsonb)') IS NULL THEN
  ALTER FUNCTION public.monthly_refund_erasure_safe(jsonb) RENAME TO monthly_refund_erasure_safe_pre_annual;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.monthly_refund_erasure_safe(i jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE t jsonb;pr jsonb;e jsonb;k text;n numeric;at timestamptz;
BEGIN
 t:=i->'terms';
 IF i ? 'renewalEvidence' THEN
  e:=i->'renewalEvidence';
  IF jsonb_typeof(e) IS DISTINCT FROM 'object'
   OR NOT e ?& ARRAY['beforeCancelAtPeriodEnd','afterCancelAtPeriodEnd']
   OR e-ARRAY['beforeCancelAtPeriodEnd','afterCancelAtPeriodEnd']<>'{}'::jsonb
   OR jsonb_typeof(e->'beforeCancelAtPeriodEnd') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(e->'afterCancelAtPeriodEnd') IS DISTINCT FROM 'boolean'
   OR e->'beforeCancelAtPeriodEnd' IS DISTINCT FROM t->'originalCancelAtPeriodEnd'
   OR i->>'status'='succeeded' AND t->>'originalCancelAtPeriodEnd'='false' AND e->>'afterCancelAtPeriodEnd'<>'false'
   OR i->>'status'='failed' AND e->'afterCancelAtPeriodEnd' IS DISTINCT FROM e->'beforeCancelAtPeriodEnd'
  THEN RETURN false; END IF;
  i:=i-'renewalEvidence';
 END IF;
 IF t ? 'priorPro' THEN
  pr:=t->'priorPro';
  IF jsonb_typeof(pr) IS DISTINCT FROM 'object'
   OR NOT pr ?& ARRAY['orderId','subscriptionId','providerSubscriptionId','invoiceId','periodEnd','autoRenew']
   OR pr-ARRAY['orderId','subscriptionId','providerSubscriptionId','invoiceId','periodEnd','autoRenew']<>'{}'::jsonb
   OR jsonb_typeof(pr->'autoRenew') IS DISTINCT FROM 'boolean'
   OR t->>'plan' IS DISTINCT FROM 'gold' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['orderId','subscriptionId','invoiceId','periodEnd'] LOOP
   IF jsonb_typeof(pr->k) IS DISTINCT FROM 'string' OR length(btrim(pr->>k)) NOT BETWEEN 1 AND 160
   THEN RETURN false; END IF;
  END LOOP;
  IF pr->>'autoRenew'='true' THEN
   IF jsonb_typeof(pr->'providerSubscriptionId') IS DISTINCT FROM 'string'
    OR length(btrim(pr->>'providerSubscriptionId')) NOT BETWEEN 1 AND 160 THEN RETURN false; END IF;
  ELSIF pr->'providerSubscriptionId' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  PERFORM (pr->>'orderId')::uuid,(pr->>'subscriptionId')::uuid;
  IF pr->>'orderId'=t->>'orderId' OR pr->>'subscriptionId'=t->>'subscriptionId'
   OR pr->>'periodEnd' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]' THEN RETURN false; END IF;
  at:=(pr->>'periodEnd')::timestamptz;IF NOT isfinite(at) THEN RETURN false; END IF;
  t:=t-'priorPro';
 END IF;
 IF t->'snapshot'->>'billing_cycle'='yearly' THEN
  n:=(t->'snapshot'->>'credits')::numeric;
  IF jsonb_typeof(t->'snapshot'->'credits') IS DISTINCT FROM 'number' OR n<>trunc(n)
   OR n NOT BETWEEN 1 AND 2147483647
   OR jsonb_typeof(t->'snapshot'->'bonus_credits') IS DISTINCT FROM 'number'
   OR (t->'snapshot'->>'bonus_credits')::numeric IS DISTINCT FROM 0
   OR (t->>'credits')::numeric NOT BETWEEN 1 AND n THEN RETURN false; END IF;
  -- The existing proof validates every remaining field; normalize only the already checked annual release shape.
  t:=jsonb_set(t,'{snapshot}',(t->'snapshot')||jsonb_build_object('billing_cycle','monthly',
   'credits',(t->>'credits')::bigint,'bonus_credits',0));
 END IF;
 RETURN monthly_refund_erasure_safe_pre_annual(jsonb_set(i,'{terms}',t));
EXCEPTION WHEN others THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.monthly_refund_erasure_safe(jsonb),public.monthly_refund_erasure_safe_pre_annual(jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
-- A confirmed spend is an ordinary policy refusal; retain the existing fail-closed unknown-ledger guard.
SELECT pg_temp.pay_subscription_refund_patch('public.pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
 $old$ -- Canonical spend cannot be cancelled by a positive return. Unknown negative rows fail closed.$old$,
 $new$ -- Confirmed account-wide consumption is distinct from incomplete ledger evidence.
 IF EXISTS(SELECT 1 FROM credit_transactions c WHERE c.user_id=o.user_id AND c.created_at>=paid_at
   AND c.ledger_type='spend' AND c.amount<>0)
   THEN RAISE EXCEPTION 'PAY_REFUND_CREDITS_CONSUMED'; END IF;
 -- Canonical spend cannot be cancelled by a positive return. Unknown negative rows fail closed.$new$);
DROP FUNCTION pg_temp.pay_subscription_refund_patch(text,text,text);
COMMIT;
