-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-FAILOVER: Owner approved #1234 / MASTER_PLAN 2.1 (2026-10-21).
-- Stripe remains the default. Only new purchases follow the versioned route; existing cash,
-- subscriptions, checkout identities and founder reservations retain their original provider.
-- Waffo emergency sales are one-time payments, including cards. No provider config/data seed.
-- Apply SQL before app. Recovery: switch new purchases to Stripe through the audited RPC,
-- retain financial rows and this additive column, then forward-fix. Never replay old constraints
-- over paid Waffo payment orders. The migration is repeatable and rewrites no historical orders.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS provider_payment_method text;
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS pay_failover_actual_method;
ALTER TABLE public.payment_orders ADD CONSTRAINT pay_failover_actual_method
 CHECK(provider_payment_method IS NULL OR (payment_channel='waffo' AND mode='payment'
   AND auto_renew=false AND provider_payment_method IN ('card','alipay')));
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS pay_waffo_method_contract;
ALTER TABLE public.payment_orders ADD CONSTRAINT pay_waffo_method_contract CHECK(coalesce(payment_method IS NULL OR (
 payment_channel IS NOT NULL AND routing_version IS NOT NULL AND routing_version>0
 AND terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL AND auto_renew IS NOT NULL
 AND offer_kind IS NOT NULL AND qualification_state IS NOT NULL
 AND ((payment_method='card' AND payment_channel='waffo' AND mode='subscription' AND auto_renew
     AND payment_mode='test' AND stripe_managed_payments IS NULL)
   OR (payment_method IN ('card','card_cn','alipay') AND payment_channel='waffo'
     AND mode='payment' AND NOT auto_renew AND stripe_managed_payments IS NULL)
   OR (payment_method IN ('card','card_cn') AND payment_channel='stripe' AND item_type='membership_plan'
     AND mode='subscription' AND auto_renew AND stripe_managed_payments IS NOT DISTINCT FROM (payment_method='card'))
   OR (payment_method='card' AND payment_channel='stripe' AND item_type='credit_package'
     AND mode='payment' AND NOT auto_renew AND stripe_managed_payments IS TRUE)
   OR (payment_method IN ('wechat_pay','alipay') AND payment_channel='stripe' AND mode='payment'
     AND NOT auto_renew AND stripe_managed_payments IS NULL))
 AND (item_type<>'membership_plan' OR entitlement_term IS NOT NULL)
 AND ((entitlement_start IS NULL AND entitlement_end IS NULL) OR
   (entitlement_start IS NOT NULL AND entitlement_end IS NOT NULL AND entitlement_end>entitlement_start))),false));

CREATE OR REPLACE FUNCTION public.pay_method_mode_allowed(p_channel text,p_mode text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(p_channel IN ('stripe','waffo') AND p_mode IN ('test','live'),false);
$$;

CREATE OR REPLACE FUNCTION public.pay_failover_actual_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.provider_payment_method IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.provider_payment_method IS NOT DISTINCT FROM OLD.provider_payment_method THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.provider_payment_method IS NOT NULL THEN
  RAISE EXCEPTION 'PAY_FAILOVER_METHOD_FROZEN' USING ERRCODE='23514'; END IF;
 IF current_setting('graylum.pay_failover_order',true) IS DISTINCT FROM NEW.id::text
   OR current_user<>'postgres' THEN RAISE EXCEPTION 'PAY_FAILOVER_METHOD_WRITE_DENIED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.pay_failover_actual_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS pay_failover_actual_guard ON public.payment_orders;
CREATE TRIGGER pay_failover_actual_guard BEFORE INSERT OR UPDATE ON public.payment_orders
 FOR EACH ROW EXECUTE FUNCTION public.pay_failover_actual_guard();

CREATE OR REPLACE FUNCTION public.pay_failover_set_channel(p_actor uuid,p_version bigint,p_channel text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE routes jsonb; prior text; result jsonb;
BEGIN
 IF coalesce(p_channel,'') NOT IN ('stripe','waffo') THEN RAISE EXCEPTION 'PAY_FAILOVER_CHANNEL_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(7063,2);
 PERFORM 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_actor) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT value INTO routes FROM system_settings WHERE key='payment_method_routes' FOR UPDATE;
 IF routes IS NULL THEN RAISE EXCEPTION 'PAY_FAILOVER_ROUTES_MISSING'; END IF;
 IF (routes->>'version')::bigint IS DISTINCT FROM p_version THEN
  RAISE EXCEPTION 'PAY_WAFFO_ROUTE_VERSION_CONFLICT' USING ERRCODE='PT409'; END IF;
 prior:=coalesce(routes->>'newPurchaseChannel','stripe');
 IF prior=p_channel THEN RETURN routes; END IF;
 result:=routes||jsonb_build_object('version',p_version+1,'newPurchaseChannel',p_channel);
 PERFORM set_config('graylum.pay_failover_actor',p_actor::text,true);
 UPDATE system_settings SET value=result WHERE key='payment_method_routes';
 PERFORM set_config('graylum.pay_failover_actor','',true);
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_actor,'pay_failover_set_channel','payment',jsonb_build_object('from',prior,'to',p_channel,
   'previousVersion',p_version,'version',p_version+1));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.pay_failover_set_channel(uuid,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_failover_set_channel(uuid,bigint,text) TO service_role;

-- Guarded patches preserve the latest refund, repurchase and 0330 wallet-renewal protections.
DO $patch$
DECLARE p record; source text; hits integer;
BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
  $old$'tax_behavior','exclusive','credits',credits$old$,
  $new$'tax_behavior',CASE WHEN selected_channel='waffo' THEN 'inclusive' ELSE 'exclusive' END,'credits',credits$new$,1),
 ('pay_waffo_routes_guard()',
  $old$ARRAY['version','card','card_cn','wechat_pay','alipay']$old$,
  $new$ARRAY['version','card','card_cn','wechat_pay','alipay','newPurchaseChannel']$new$,1),
 ('pay_waffo_routes_guard()',
  $old$  FOREACH m IN ARRAY ARRAY['card','card_cn','wechat_pay','alipay'] LOOP$old$,
  $new$  IF v ? 'newPurchaseChannel' AND coalesce(v->>'newPurchaseChannel','') NOT IN ('stripe','waffo') THEN
    RAISE EXCEPTION 'PAY_FAILOVER_CHANNEL_INVALID' USING ERRCODE='23514'; END IF;
  IF (TG_OP='INSERT' AND coalesce(v->>'newPurchaseChannel','stripe')<>'stripe') OR
     (TG_OP='UPDATE' AND coalesce(v->>'newPurchaseChannel','stripe') IS DISTINCT FROM
       coalesce(OLD.value->>'newPurchaseChannel','stripe')) THEN
    IF nullif(current_setting('graylum.pay_failover_actor',true),'') IS NULL OR current_user<>'postgres' THEN
      RAISE EXCEPTION 'PAY_FAILOVER_RPC_REQUIRED' USING ERRCODE='42501'; END IF;
  END IF;
  FOREACH m IN ARRAY ARRAY['card','card_cn','wechat_pay','alipay'] LOOP$new$,1),
 ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
  $old$  IF p_method NOT IN ('card','card_cn') AND p_cycle='yearly' AND$old$,
  $new$  selected_channel:=coalesce(routes->>'newPurchaseChannel','stripe');
  IF selected_channel='waffo' AND p_method NOT IN ('card','card_cn','alipay') THEN
    RAISE EXCEPTION 'PAY_WAFFO_METHOD_DENIED'; END IF;
  IF selected_channel='stripe' AND p_method NOT IN ('card','card_cn') AND p_cycle='yearly' AND$new$,1),
 ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
  $old$IF p_method='card_cn' AND p_item_type='credit_package' THEN$old$,
  $new$IF selected_channel='stripe' AND p_method='card_cn' AND p_item_type='credit_package' THEN$new$,1),
 ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
  $old$  selected_channel:='stripe';
  recurring:=p_item_type='membership_plan' AND p_method IN ('card','card_cn');$old$,
  $new$  recurring:=selected_channel='stripe' AND p_item_type='membership_plan' AND p_method IN ('card','card_cn');$new$,1),
 ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
  $old$CASE WHEN p_method IN ('card','card_cn') THEN p_method='card' END$old$,
  $new$CASE WHEN selected_channel='stripe' AND p_method IN ('card','card_cn') THEN p_method='card' END$new$,1),
 ('pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
  $old$prior.payment_channel IS DISTINCT FROM 'stripe' OR prior.payment_method NOT IN ('wechat_pay','alipay')
        OR p_method NOT IN ('wechat_pay','alipay')$old$,
  $new$NOT (prior.payment_channel='stripe' AND prior.payment_method IN ('wechat_pay','alipay')
          OR prior.payment_channel='waffo' AND prior.mode='payment' AND prior.payment_method IN ('card','card_cn','alipay'))
        OR NOT (p_method IN ('wechat_pay','alipay') OR p_method IN ('card','card_cn') AND
          (SELECT coalesce(value->>'newPurchaseChannel','stripe')='waffo' FROM system_settings WHERE key='payment_method_routes'))$new$,1),
 ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamptz,text,timestamptz,timestamptz)',
  $old$IF (o.payment_method='card' AND o.payment_channel='waffo') OR o.auto_renew OR p_subscription IS NOT NULL$old$,
  $new$IF o.auto_renew OR p_subscription IS NOT NULL$new$,1),
 ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamptz,text,timestamptz,timestamptz)',
  $old$o.payment_channel IS DISTINCT FROM 'stripe' OR o.payment_method NOT IN ('wechat_pay','alipay')
     OR o.auto_renew$old$,
  $new$NOT (o.payment_channel='stripe' AND o.payment_method IN ('wechat_pay','alipay')
       OR o.payment_channel='waffo' AND o.mode='payment' AND o.payment_method IN ('card','card_cn','alipay'))
     OR o.auto_renew$new$,1),
 ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamptz,text,timestamptz,timestamptz)',
  $old$prior.payment_channel='stripe'
       AND prior.payment_method IN ('wechat_pay','alipay') AND prior.auto_renew=false$old$,
  $new$(prior.payment_channel='stripe' AND prior.payment_method IN ('wechat_pay','alipay')
         OR prior.payment_channel='waffo' AND prior.mode='payment' AND prior.payment_method IN ('card','card_cn','alipay'))
       AND prior.auto_renew=false$new$,1),
 ('pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamptz,text,timestamptz,timestamptz)',
  $old$OR o.payment_method IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_SCOPE'; END IF;$old$,
  $new$OR o.payment_method IS NULL OR o.payment_channel='waffo' AND (
     o.auto_renew AND o.payment_mode<>'test' OR NOT o.auto_renew AND
     o.provider_payment_method IS NULL) THEN RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_SCOPE'; END IF;$new$,1),
 ('pay_waffo_founder_deadline(uuid)',
  $old$IF o.payment_method IN ('card','card_cn') THEN$old$,
  $new$IF o.auto_renew THEN$new$,1),
 ('pay_common_membership_facts(uuid)',
  $old$'payment_method',o.payment_method,'status','active'$old$,
  $new$'payment_method',coalesce(o.provider_payment_method,o.payment_method),'purchase_mode',o.mode,'status','active'$new$,1),
 ('pay_waffo_abort_before_dispatch(uuid,uuid,text,timestamptz)',
  $old$o.payment_channel IS DISTINCT FROM 'stripe'$old$,
  $new$NOT (o.payment_channel='stripe' OR o.payment_channel='waffo' AND o.mode='payment'
    AND NOT o.auto_renew AND o.method_dispatched_at IS NULL)$new$,1),
 ('pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
  $old$o.payment_channel IS DISTINCT FROM 'stripe'$old$,
  $new$NOT (o.payment_channel='stripe' OR o.payment_channel='waffo' AND o.mode='payment'
     AND NOT o.auto_renew AND o.provider_payment_method IN ('card','alipay'))$new$,1),
 ('pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
  $old$o.payment_method IN ('wechat_pay','alipay')
   AND o.auto_renew IS NOT TRUE$old$,
  $new$(o.payment_channel='stripe' AND o.payment_method IN ('wechat_pay','alipay') OR o.payment_channel='waffo'
     AND o.mode='payment' AND o.provider_payment_method IN ('card','alipay'))
   AND o.auto_renew IS NOT TRUE$new$,1),
 ('pay_common_package_refund_reject(uuid,uuid,uuid,text)',
  $old$o.payment_method IN ('wechat_pay','alipay')
   AND o.auto_renew IS NOT TRUE$old$,
  $new$(o.payment_channel='stripe' AND o.payment_method IN ('wechat_pay','alipay') OR o.payment_channel='waffo'
     AND o.mode='payment' AND o.provider_payment_method IN ('card','alipay'))
   AND o.auto_renew IS NOT TRUE$new$,1),
 ('pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
  $old$r.external_id=p_cash->>'paymentIntentId' AND r.channel='stripe'$old$,
  $new$r.external_id=p_cash->>'paymentIntentId' AND r.channel=o.payment_channel$new$,1),
 ('pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
  $old$IF o.payment_method='card' THEN$old$,
  $new$IF o.payment_channel='stripe' AND o.payment_method='card' THEN$new$,1),
 ('pay_common_package_refund_result(uuid,uuid,jsonb)',
  $old$VALUES('stripe',o.merchant_namespace,o.payment_mode,'refund'$old$,
  $new$VALUES(o.payment_channel,o.merchant_namespace,o.payment_mode,'refund'$new$,1),
 ('pay_common_package_refund_result(uuid,uuid,jsonb)',
  $old$r.channel='stripe'$old$,
  $new$r.channel=o.payment_channel$new$,1),
 ('pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
  $old$OR nullif(p_cash->>'chargeId','') IS NULL$old$,
  $new$OR nullif(p_cash->>'chargeId','') IS NULL
   OR o.payment_channel='waffo' AND p_cash->>'chargeId' IS DISTINCT FROM p_cash->>'paymentIntentId'$new$,1),
 ('pay_common_package_refund_claim(uuid,uuid,uuid,jsonb)',
  $old$'stripe_refund',p_order,'pay-common:refund:'$old$,
  $new$CASE WHEN (SELECT payment_channel FROM payment_orders WHERE id=p_order)='waffo'
    THEN 'payment_refund' ELSE 'stripe_refund' END,p_order,'pay-common:refund:'$new$,1),
 ('pay_common_package_refund_result(uuid,uuid,jsonb)',
  $old$'stripe_refund',o.id,'pay-common:refund-restore:'$old$,
  $new$CASE WHEN o.payment_channel='waffo' THEN 'payment_refund' ELSE 'stripe_refund' END,
     o.id,'pay-common:refund-restore:'$new$,1),
 ('pay_waffo_claim_checkout(uuid,uuid,text,jsonb,timestamptz)',
  $old$ARRAY['orderId','userId','method','merchant','mode','providerRequest']$old$,
  $new$ARRAY['orderId','userId','method','merchant','mode','purchaseMode','providerRequest']$new$,1),
 ('pay_waffo_claim_checkout(uuid,uuid,text,jsonb,timestamptz)',
  $old$OR jsonb_typeof(p_request->'providerRequest') IS DISTINCT FROM 'object' THEN$old$,
  $new$OR jsonb_typeof(p_request->'providerRequest') IS DISTINCT FROM 'object'
   OR o.payment_channel='waffo' AND NOT o.auto_renew AND p_request->>'purchaseMode' IS DISTINCT FROM 'payment'
   OR (o.payment_channel='stripe' OR o.auto_renew) AND p_request ? 'purchaseMode' THEN$new$,1),
 ('pay_waffo_close_card_checkout(uuid,uuid,text,boolean)',
  $old$o.payment_method IS DISTINCT FROM 'card'$old$,
  $new$NOT (o.payment_method='card' OR o.mode='payment' AND NOT o.auto_renew
    AND o.payment_method IN ('card_cn','alipay'))$new$,1),
 ('pay_waffo_close_card_checkout(uuid,uuid,text,boolean)',
  $old$o.payment_mode IS DISTINCT FROM 'test'$old$,
  $new$NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)$new$,1),
 ('pay_waffo_close_card_checkout(uuid,uuid,text,boolean)',
  $old$OR o.payment_status IS DISTINCT FROM 'unpaid' OR o.fulfilled_at IS NOT NULL OR p_rejected IS NULL$old$,
  $new$OR o.payment_status IS DISTINCT FROM 'unpaid' OR o.fulfilled_at IS NOT NULL OR p_rejected IS NULL
  -- PAY-FAILOVER: a local timer cannot prove a one-time checkout has no cash in flight.
  OR o.mode='payment' AND NOT o.auto_renew AND NOT p_rejected$new$,1),
 ('pay_waffo_resolve_receipt(uuid,text,text,text)',
  $old$AND mode='test'$old$,
  $new$AND mode IN ('test','live')$new$,2),
 ('erasure_envelope_transition(jsonb,jsonb)',
  $old$  IF provider ? 'productId' THEN
   IF lower(provider->>'currency') IS DISTINCT FROM o->>'currency'$old$,
  $new$  IF provider ? 'productId' AND wrapper->>'purchaseMode'='payment' THEN
   IF lower(provider->>'currency') IS DISTINCT FROM o->>'currency'
    OR o->>'payment_channel' IS DISTINCT FROM 'waffo' OR o->>'mode' IS DISTINCT FROM 'payment'
    OR o->'auto_renew' IS DISTINCT FROM 'false'::jsonb
    OR o->>'payment_method' NOT IN ('card','card_cn','alipay')
    OR provider->'withTrial' IS DISTINCT FROM 'false'::jsonb
    OR round((provider->'priceSnapshot'->>'amount')::numeric*100) IS DISTINCT FROM (o->>'amount_total')::numeric
    OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE id=(o->>'price_ref_id')::uuid
      AND price_usage=CASE WHEN o->>'item_type'='credit_package' THEN 'package' ELSE 'one_time' END) THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW'; END IF;
  ELSIF provider ? 'productId' THEN
   IF lower(provider->>'currency') IS DISTINCT FROM o->>'currency'$new$,1),
 ('erasure_payment_envelope(jsonb,text)',
  $old$  provider:=v->'providerRequest';
  IF provider ? 'productId' AND NOT (provider ? 'mode') THEN$old$,
  $new$  provider:=v->'providerRequest';
  IF v ? 'purchaseMode' THEN
   -- Only the Waffo one-time envelope emitted by PAY-FAILOVER. Unknown transport shapes stay review.
   IF v->>'purchaseMode' IS DISTINCT FROM 'payment' OR v->>'method' NOT IN ('card','card_cn','alipay')
    OR (v-ARRAY['orderId','userId','method','merchant','mode','purchaseMode','providerRequest'])<>'{}'::jsonb
    OR NOT (provider ?& ARRAY['productId','currency','withTrial','buyerIdentity',
      'orderMerchantExternalId','metadata','expiresInSeconds','successUrl','priceSnapshot'])
    OR (provider-ARRAY['productId','currency','withTrial','buyerIdentity','orderMerchantExternalId',
      'metadata','expiresInSeconds','successUrl','priceSnapshot'])<>'{}'::jsonb
    OR coalesce(provider->>'productId','') !~ '^PROD_[A-Za-z0-9]+$'
    OR provider->>'currency' IS DISTINCT FROM 'USD' OR provider->'withTrial' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(provider->'priceSnapshot') IS DISTINCT FROM 'object'
    OR NOT (provider->'priceSnapshot' ?& ARRAY['amount','taxIncluded','taxCategory'])
    OR ((provider->'priceSnapshot')-ARRAY['amount','taxIncluded','taxCategory'])<>'{}'::jsonb
    OR coalesce(provider->'priceSnapshot'->>'amount','') !~ '^[0-9]+([.][0-9]{1,2})?$'
    OR provider->'priceSnapshot'->'taxIncluded' IS DISTINCT FROM 'true'::jsonb
    OR provider->'priceSnapshot'->>'taxCategory' IS DISTINCT FROM 'saas'
    OR coalesce(provider->>'buyerIdentity','') !~ '^[0-9a-f]{64}$'
    OR provider->>'orderMerchantExternalId' IS DISTINCT FROM v->>'orderId'
    OR provider->'metadata' IS DISTINCT FROM jsonb_build_object('orderId',v->>'orderId')
    OR provider->'expiresInSeconds' IS DISTINCT FROM '1800'::jsonb
    OR coalesce(provider->>'successUrl','') !~ '^https?://[^ ]+$' THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW'; END IF;
   provider:=erasure_ledger_value(provider,'{"productId":"id","currency":{"$enum":["USD"]},
    "withTrial":"boolean","orderMerchantExternalId":"id","metadata":{"orderId":"id"},"expiresInSeconds":"number",
    "priceSnapshot":{"amount":"number","taxIncluded":"boolean","taxCategory":{"$enum":["saas"]}}}');
   RETURN wrapper||jsonb_build_object('purchaseMode','payment','providerRequest',provider);
  END IF;
  IF provider ? 'productId' AND NOT (provider ? 'mode') THEN$new$,1)
 ) AS patches(signature,old_,new_,expected) LOOP
  source:=pg_get_functiondef(('public.'||p.signature)::regprocedure);
  IF position(p.new_ IN source)>0 THEN CONTINUE; END IF;
  hits:=(length(source)-length(replace(source,p.old_,'')))/length(p.old_);
  IF hits<>p.expected THEN RAISE EXCEPTION 'PAY_FAILOVER_PATCH_MISMATCH % / % (% found)',p.signature,p.old_,hits; END IF;
  EXECUTE replace(source,p.old_,p.new_);
 END LOOP;
END $patch$;

-- A checked cash payment may need manual review even when its actual payment method is known.
CREATE OR REPLACE FUNCTION public.pay_failover_fulfill(
 p_order uuid,p_merchant text,p_checkout text,p_payment text,p_method text,p_amount integer,p_currency text,
 p_paid_at timestamptz,p_start timestamptz,p_end timestamptz,p_review text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; state text; cash jsonb; reason_ text;
BEGIN
 PERFORM pay_dispute_lock(p_merchant||':'||(SELECT payment_mode FROM payment_orders WHERE id=p_order)||':'||p_payment,NULL);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.payment_channel IS DISTINCT FROM 'waffo' OR o.mode IS DISTINCT FROM 'payment'
   OR o.auto_renew IS DISTINCT FROM false OR NOT pay_method_mode_allowed(o.payment_channel,o.payment_mode)
   OR o.merchant_namespace IS DISTINCT FROM p_merchant OR coalesce(p_method,'') NOT IN ('card','alipay','unknown')
   OR p_review IS NOT NULL AND p_review NOT IN ('chargeback_observed','product_scope','source_term_unknown',
     'founder_term_unknown','term_invalid') THEN RAISE EXCEPTION 'PAY_FAILOVER_PAYMENT_SCOPE'; END IF;
 IF o.provider_payment_method IS NOT NULL AND p_method<>'unknown'
   AND o.provider_payment_method IS DISTINCT FROM p_method THEN RAISE EXCEPTION 'PAY_FAILOVER_METHOD_CONFLICT'; END IF;
 -- Refunds win over every duplicate/late payment event. Never re-open or issue new grants.
 IF o.payment_status IN ('refunded','partially_refunded') OR o.status IN ('refunded','partially_refunded') THEN
  RETURN jsonb_build_object('state','review','reason','refund_observed'); END IF;
 state:=pay_waffo_observe_qualification(o.id,p_merchant,o.payment_mode,p_checkout,'paid',p_payment,p_amount,p_currency,p_paid_at);
 IF o.dispute_payment_key IS NOT NULL AND o.dispute_payment_key IS DISTINCT FROM
   p_merchant||':'||o.payment_mode||':'||p_payment THEN RAISE EXCEPTION 'PAY_FAILOVER_PAYMENT_SCOPE'; END IF;
 UPDATE payment_orders SET dispute_payment_key=p_merchant||':'||o.payment_mode||':'||p_payment
  WHERE id=o.id AND dispute_payment_key IS NULL;
 IF o.fulfilled_at IS NOT NULL THEN RETURN jsonb_build_object('state','fulfilled','duplicate',true); END IF;
 IF p_method<>'unknown' THEN
  PERFORM set_config('graylum.pay_failover_order',o.id::text,true);
  UPDATE payment_orders SET provider_payment_method=p_method WHERE id=o.id AND provider_payment_method IS NULL;
  PERFORM set_config('graylum.pay_failover_order','',true);
 END IF;
 IF state<>'sold' OR p_method='unknown' OR p_review IS NOT NULL OR pay_dispute_order_frozen(o.id) THEN
  reason_:=CASE WHEN p_method='unknown' THEN 'payment_method_unknown' ELSE coalesce(p_review,
    CASE WHEN pay_dispute_order_frozen(o.id) THEN 'chargeback_observed' END,o.method_review_reason,'qualification_review') END;
  cash:=jsonb_build_object('kind','paid','amount',(p_amount::numeric/100)::numeric(20,2)::text,
    'currency',p_currency,'unit','major','evidence_ref',p_payment);
  UPDATE payment_orders SET qualification_state='review',payment_status='paid',method_review_reason=reason_,
   payment_amount_facts=CASE WHEN payment_amount_facts @> jsonb_build_array(cash) THEN payment_amount_facts
     ELSE coalesce(payment_amount_facts,'[]'::jsonb)||jsonb_build_array(cash) END WHERE id=o.id;
  RETURN jsonb_build_object('state','review','reason',reason_);
 END IF;
 RETURN pay_waffo_fulfill_payment(o.id,p_merchant,p_checkout,p_payment,p_amount,p_currency,p_paid_at,NULL,p_start,p_end);
END $$;
-- Keep existing ten-argument callers working without overloaded default arguments.
CREATE OR REPLACE FUNCTION public.pay_failover_fulfill(
 p_order uuid,p_merchant text,p_checkout text,p_payment text,p_method text,p_amount integer,p_currency text,
 p_paid_at timestamptz,p_start timestamptz,p_end timestamptz
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT pay_failover_fulfill(p_order,p_merchant,p_checkout,p_payment,p_method,p_amount,p_currency,
   p_paid_at,p_start,p_end,NULL);
$$;
REVOKE ALL ON FUNCTION public.pay_failover_fulfill(uuid,text,text,text,text,integer,text,timestamptz,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_failover_fulfill(uuid,text,text,text,text,integer,text,timestamptz,timestamptz,timestamptz)
 TO service_role;
REVOKE ALL ON FUNCTION public.pay_failover_fulfill(uuid,text,text,text,text,integer,text,timestamptz,timestamptz,timestamptz,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_failover_fulfill(uuid,text,text,text,text,integer,text,timestamptz,timestamptz,timestamptz,text)
 TO service_role;

-- Reuse the existing reversible source hold. Waffo status/outcome is deliberately not inferred:
-- under_review is our internal manual-review state and only an explicit admin can withdraw the hold.
ALTER TABLE public.payment_disputes DROP CONSTRAINT IF EXISTS payment_disputes_provider_check;
ALTER TABLE public.payment_disputes ADD CONSTRAINT payment_disputes_provider_check CHECK(provider IN ('stripe','waffo'));
ALTER TABLE public.payment_disputes ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE public.payment_disputes ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE public.payment_disputes DROP CONSTRAINT IF EXISTS pay_failover_dispute_currency;
ALTER TABLE public.payment_disputes ADD CONSTRAINT pay_failover_dispute_currency CHECK(
 (provider='stripe' AND currency IS NOT NULL AND currency ~ '^[a-z]{3}$')
 OR (provider='waffo' AND (currency IS NULL OR currency ~ '^[a-z]{3}$')));
ALTER TABLE public.payment_disputes DROP CONSTRAINT IF EXISTS pay_failover_dispute_amount;
ALTER TABLE public.payment_disputes ADD CONSTRAINT pay_failover_dispute_amount CHECK(
 (provider='stripe' AND amount IS NOT NULL AND amount>=0)
 OR (provider='waffo' AND (amount IS NULL OR amount>0)));
ALTER TABLE public.payment_disputes DROP CONSTRAINT IF EXISTS payment_disputes_provider_dispute_id_check;
ALTER TABLE public.payment_disputes ADD CONSTRAINT payment_disputes_provider_dispute_id_check CHECK(
 provider='stripe' AND provider_dispute_id ~ '^du_[A-Za-z0-9_]{1,160}$'
 OR provider='waffo' AND provider_dispute_id ~ '^[A-Za-z0-9_:-]{1,160}$');
CREATE OR REPLACE FUNCTION public.pay_failover_dispute_observed(
 p_order uuid,p_merchant text,p_mode text,p_payment text,p_dispute text,p_amount integer,p_currency text,p_observed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; d payment_disputes; key_ text;
BEGIN
 IF coalesce(p_payment,'') !~ '^PAY_[A-Za-z0-9_-]{1,156}$'
  OR coalesce(p_dispute,'') !~ '^[A-Za-z0-9_:-]{1,160}$'
  OR p_observed_at IS NULL OR p_observed_at>clock_timestamp()+interval '5 minutes' THEN
  RAISE EXCEPTION 'PAY_FAILOVER_DISPUTE_INVALID'; END IF;
 key_:=p_merchant||':'||p_mode||':'||p_payment;
 -- Canonical payment, then profile/order: same lock order as fulfillment and refunds.
 PERFORM pay_dispute_lock(key_,NULL);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.payment_channel IS DISTINCT FROM 'waffo' OR o.payment_mode IS DISTINCT FROM p_mode
  OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.mode IS DISTINCT FROM 'payment'
  OR o.auto_renew IS DISTINCT FROM false OR o.qualified_paid_at IS NULL
  OR p_amount IS NOT NULL AND (p_amount<=0 OR p_currency=o.currency AND p_amount>o.amount_total)
  OR p_currency IS NOT NULL AND p_currency !~ '^[a-z]{3}$'
  OR o.dispute_payment_key IS NOT NULL AND o.dispute_payment_key IS DISTINCT FROM key_
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='waffo' AND merchant_namespace=p_merchant
    AND mode=p_mode AND order_id=o.id AND object_type='payment' AND external_id=p_payment) THEN
  RAISE EXCEPTION 'PAY_FAILOVER_DISPUTE_SCOPE'; END IF;
 UPDATE payment_orders SET dispute_payment_key=key_ WHERE id=o.id AND dispute_payment_key IS NULL;
 INSERT INTO payment_disputes(provider,merchant_namespace,mode,provider_dispute_id,payment_key,
  provider_charge_id,provider_payment_intent_id,original_payment_at,last_event_at,order_id,subscription_id,
  amount,currency,reason,status,opened_at,renewal_stop_state)
 VALUES('waffo',p_merchant,p_mode,p_dispute,key_,p_payment,p_payment,o.qualified_paid_at,p_observed_at,
  o.id,o.subscription_id,p_amount,p_currency,'waffo_chargeback_observed','under_review',p_observed_at,'not_applicable')
 ON CONFLICT ON CONSTRAINT payment_disputes_identity DO NOTHING;
 SELECT * INTO d FROM payment_disputes WHERE merchant_namespace=p_merchant AND mode=p_mode
  AND provider_dispute_id=p_dispute FOR UPDATE;
 IF d.provider IS DISTINCT FROM 'waffo' OR d.order_id IS DISTINCT FROM o.id OR d.payment_key IS DISTINCT FROM key_
  OR d.amount IS NOT NULL AND p_amount IS NOT NULL AND d.amount IS DISTINCT FROM p_amount
  OR d.currency IS NOT NULL AND p_currency IS NOT NULL AND d.currency IS DISTINCT FROM p_currency THEN
  RAISE EXCEPTION 'PAY_FAILOVER_DISPUTE_IDENTITY_CONFLICT'; END IF;
 UPDATE payment_disputes SET last_event_at=greatest(last_event_at,p_observed_at),amount=coalesce(amount,p_amount),currency=coalesce(currency,p_currency) WHERE id=d.id;
 PERFORM pay_dispute_freeze(d.id);
 -- Missing supplier cash facts never prevent a conservative source hold or pretend a full loss.
 UPDATE payment_disputes SET source_review_required=true WHERE id=d.id
  AND (amount IS NULL OR currency IS NULL OR currency IS DISTINCT FROM o.currency);
 PERFORM pay_dispute_evidence(o.id);
 RETURN (SELECT to_jsonb(x) FROM payment_disputes x WHERE id=d.id);
END $$;
REVOKE ALL ON FUNCTION public.pay_failover_dispute_observed(uuid,text,text,text,text,integer,text,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_failover_dispute_observed(uuid,text,text,text,text,integer,text,timestamptz)
 TO service_role;
COMMIT;
