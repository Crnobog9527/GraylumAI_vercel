-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Candidate only: move into an assigned append-only migration after queue coordination.
-- No data mutation or privilege change. Original erasure guard remains authoritative.
CREATE OR REPLACE FUNCTION public.erasure_payment_envelope(v jsonb,k text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE ids jsonb:='{"orderId":"id","userId":"id","itemId":"id","itemType":"id","billingCycle":"id","priceId":"id","upgradeAttemptId":"id"}';
 shape jsonb; amount jsonb; wrapper jsonb; provider jsonb; facts jsonb; nested jsonb; line jsonb;
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN v; END IF;
 -- PAY-WAFFO / method checkout stores a test-mode transport envelope around provider facts.
 -- Keep financial identifiers, never buyer identity, redirect URLs or arbitrary request content.
 IF k='checkout' AND (v ? 'providerRequest' OR v ? 'merchant' OR v ? 'method') THEN
  IF jsonb_typeof(v)<>'object' OR NOT (v ?& ARRAY['orderId','userId','method','merchant','mode','providerRequest'])
   OR v->>'mode' IS DISTINCT FROM 'test' OR jsonb_typeof(v->'providerRequest') IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
  wrapper:=erasure_ledger_value(v,'{"orderId":"id","userId":"id","merchant":"id",
   "mode":{"$enum":["test"]},"method":{"$enum":["card","card_cn","alipay","wechat_pay"]}}');
  IF EXISTS(SELECT 1 FROM jsonb_each(wrapper) WHERE value='null'::jsonb) THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
  provider:=v->'providerRequest';
  IF provider ? 'productId' AND NOT (provider ? 'mode') THEN
   IF v->>'method'<>'card' OR NOT (provider ?& ARRAY['productId','currency','withTrial',
    'includePaymentMethods','orderMerchantExternalId','metadata','expiresInSeconds'])
    OR coalesce(provider->>'productId','') !~ '^PROD_[A-Za-z0-9]+$'
    OR provider->'includePaymentMethods' IS DISTINCT FROM '["card"]'::jsonb
    OR provider->>'orderMerchantExternalId' IS DISTINCT FROM v->>'orderId'
    OR provider->'metadata'->>'orderId' IS DISTINCT FROM v->>'orderId'
    OR jsonb_typeof(provider->'expiresInSeconds') IS DISTINCT FROM 'number'
    OR provider->>'expiresInSeconds' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   provider:=erasure_ledger_value(provider,'{"productId":"id","currency":{"$enum":["USD"]},
    "withTrial":"boolean","includePaymentMethods":[{"$enum":["card"]}],
    "orderMerchantExternalId":"id","metadata":{"orderId":"id"},"expiresInSeconds":"number"}');
   IF EXISTS(SELECT 1 FROM jsonb_each(provider) WHERE value='null'::jsonb) THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
  ELSIF provider->>'mode' IN ('subscription','payment') AND NOT (provider ? 'productId') THEN
   -- Only the complete shapes emitted by buildStripeCheckoutRequest may authorize erasure.
   IF provider ?| ARRAY['providerRequest','merchant','method']
    OR jsonb_typeof(provider->'line_items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(provider->'metadata') IS DISTINCT FROM 'object'
    OR jsonb_typeof(provider->'expires_at') IS DISTINCT FROM 'number'
    OR coalesce(provider->>'expires_at','') !~ '^[1-9][0-9]*$'
    OR provider->>'client_reference_id' IS DISTINCT FROM v->>'userId' THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   facts:=erasure_ledger_value(provider->'metadata',ids);
   IF NOT (facts ?& ARRAY['orderId','userId','itemId','itemType','billingCycle','priceId'])
    OR EXISTS(SELECT 1 FROM jsonb_each(facts) WHERE value='null'::jsonb)
    OR facts->>'orderId' IS DISTINCT FROM v->>'orderId'
    OR facts->>'userId' IS DISTINCT FROM v->>'userId'
    OR facts->>'itemType' NOT IN ('membership_plan','credit_package')
    OR facts->>'billingCycle' NOT IN ('one_time','monthly','yearly')
    OR facts->>'itemType'='credit_package' AND facts->>'billingCycle'<>'one_time'
    OR facts->>'itemType'='membership_plan' AND facts->>'billingCycle'='one_time'
    OR provider->>'mode' IS DISTINCT FROM (CASE
      WHEN v->>'method' IN ('card','card_cn') AND facts->>'itemType'='membership_plan'
      THEN 'subscription' ELSE 'payment' END)
    OR jsonb_array_length(provider->'line_items')<>1 THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   line:=provider->'line_items'->0;
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR line->'quantity' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   IF line ? 'price' THEN
    IF line->>'price' IS DISTINCT FROM facts->>'priceId' OR line ? 'price_data' THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
   ELSIF jsonb_typeof(line->'price_data') IS DISTINCT FROM 'object'
    OR jsonb_typeof(line->'price_data'->'unit_amount') IS DISTINCT FROM 'number'
    OR coalesce(line->'price_data'->>'unit_amount','') !~ '^[0-9]+$'
    OR coalesce(line->'price_data'->>'currency','') !~ '^[a-z]{3}$' THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   IF provider->>'mode'='subscription' THEN
    IF v->>'method' NOT IN ('card','card_cn') OR facts->>'itemType'<>'membership_plan'
     OR facts->>'billingCycle' NOT IN ('monthly','yearly') OR NOT (line ? 'price')
     OR provider ? 'payment_intent_data' THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
    nested:=provider->'subscription_data'->'metadata';
   ELSE
    IF provider ? 'subscription_data' OR provider ? 'discounts' THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
    nested:=provider->'payment_intent_data'->'metadata';
   END IF;
   IF jsonb_typeof(nested) IS DISTINCT FROM 'object'
    OR erasure_ledger_value(nested,ids) IS DISTINCT FROM facts THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   IF v->>'method'='card' THEN
    IF provider->'managed_payments'->'enabled' IS DISTINCT FROM 'true'::jsonb
     OR provider ?| ARRAY['payment_method_types','payment_method_options','billing_address_collection'] THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
   ELSE
    IF provider ? 'managed_payments'
     OR provider->'payment_method_types' IS DISTINCT FROM
       jsonb_build_array(CASE WHEN v->>'method'='card_cn' THEN 'card' ELSE v->>'method' END) THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
    IF v->>'method'='card_cn' AND provider->>'billing_address_collection' IS DISTINCT FROM 'required'
     OR v->>'method' IN ('alipay','wechat_pay') AND
      (provider->>'mode'<>'payment' OR provider->>'customer_creation' IS DISTINCT FROM 'always')
     OR v->>'method'='wechat_pay' AND provider->'payment_method_options'->'wechat_pay'->>'client' IS DISTINCT FROM 'web'
     OR v->>'method'<>'wechat_pay' AND provider ? 'payment_method_options' THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
   END IF;
   IF provider ? 'discounts' THEN
    IF jsonb_typeof(provider->'discounts') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
    IF jsonb_array_length(provider->'discounts')<>1
     OR coalesce(provider->'discounts'->0->>'coupon','') !~ '^[A-Za-z0-9_-]{1,200}$' THEN
     RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
    END IF;
   END IF;
   -- Recursion projects the validated original Stripe schema, never another wrapper.
   provider:=erasure_payment_envelope(provider,'checkout');
  ELSE
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
  RETURN wrapper||jsonb_build_object('providerRequest',provider);
 END IF;
 IF k='checkout' THEN
  shape:='{"mode":{"$enum":["subscription","payment"]},"payment_method_types":[{"$enum":["card","alipay","wechat_pay"]}],
   "managed_payments":{"enabled":"boolean"},"discounts":[{"coupon":"id"}],
   "payment_method_options":{"wechat_pay":{"client":{"$enum":["web"]}}},
   "billing_address_collection":{"$enum":["auto","required"]},"customer_creation":{"$enum":["always","if_required"]},"client_reference_id":"id","expires_at":"number",
   "line_items":[{"price":"id","quantity":"number","price_data":{"currency":"id","unit_amount":"number"}}]}'::jsonb
   ||jsonb_build_object('metadata',ids,'subscription_data',jsonb_build_object('metadata',ids),
    'payment_intent_data',jsonb_build_object('metadata',ids));
 ELSIF k='change' THEN
  shape:='{"originalPrice":"id","itemId":"id","createdAt":"number","quote":{"amountDue":"number", "currency":"id",
   "quotedAt":"number","fingerprint":"id","freshnessProof":"id"}}'::jsonb||jsonb_build_object('stripeMetadata',ids);
 ELSE RAISE EXCEPTION 'ERASURE_ENVELOPE_KIND'; END IF;
 FOR amount IN SELECT value FROM jsonb_path_query(v,
  CASE WHEN k='checkout' THEN '$.line_items[*].quantity'::jsonpath ELSE '$.quote.amountDue'::jsonpath END) q(value)
  UNION ALL SELECT value FROM jsonb_path_query(v,
  CASE WHEN k='checkout' THEN '$.line_items[*].price_data.unit_amount'::jsonpath ELSE '$.quote.quotedAt'::jsonpath END) q(value)
 LOOP
  IF jsonb_typeof(amount)<>'number' OR amount#>>'{}' !~ '^[0-9]+$' THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
 END LOOP;
 RETURN erasure_ledger_value(v,shape);
END $$;

CREATE OR REPLACE FUNCTION public.erasure_envelope_transition(o jsonb,n jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE wrapper jsonb:=o->'checkout_request'; provider jsonb:=wrapper->'providerRequest'; price text;
BEGIN
 -- Validate the owning financial row before the existing guard permits the first erasure marker.
 IF o->>'request_erased_at' IS NULL AND n->>'request_erased_at' IS NOT NULL
  AND wrapper ?| ARRAY['providerRequest','merchant','method'] THEN
  IF wrapper->>'orderId' IS DISTINCT FROM o->>'id'
   OR wrapper->>'userId' IS DISTINCT FROM o->>'user_id'
   OR wrapper->>'merchant' IS DISTINCT FROM o->>'merchant_namespace'
   OR wrapper->>'mode' IS DISTINCT FROM o->>'payment_mode'
   OR wrapper->>'method' IS DISTINCT FROM o->>'payment_method' THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
  SELECT external_id INTO price FROM payment_provider_refs
   WHERE id=(o->>'price_ref_id')::uuid AND channel=o->>'payment_channel'
    AND merchant_namespace=o->>'merchant_namespace' AND mode=o->>'payment_mode' AND object_type='price'
    AND billing_cycle=o->>'billing_cycle'
    AND CASE o->>'item_type' WHEN 'membership_plan' THEN membership_plan_id::text=o->>'item_id'
      WHEN 'credit_package' THEN credit_package_id::text=o->>'item_id' ELSE false END;
  IF price IS NULL OR price IS DISTINCT FROM
    coalesce(provider->>'productId',provider->'metadata'->>'priceId') THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
  IF provider ? 'productId' THEN
   IF lower(provider->>'currency') IS DISTINCT FROM o->>'currency'
    OR o->>'payment_channel' IS DISTINCT FROM 'waffo' OR o->>'item_type' IS DISTINCT FROM 'membership_plan'
    OR o->>'mode' IS DISTINCT FROM 'subscription'
    OR provider->'withTrial' IS DISTINCT FROM to_jsonb(o->>'offer_kind'='gold_first30') THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
  ELSE
   IF o->>'payment_channel' IS DISTINCT FROM 'stripe'
    OR provider->>'mode' IS DISTINCT FROM o->>'mode'
    OR provider->'metadata'->>'itemId' IS DISTINCT FROM o->>'item_id'
    OR provider->'metadata'->>'itemType' IS DISTINCT FROM o->>'item_type'
    OR provider->'metadata'->>'billingCycle' IS DISTINCT FROM o->>'billing_cycle'
    OR (provider ? 'discounts') IS DISTINCT FROM
      (o->>'offer_kind'='gold_first30' AND o->>'mode'='subscription') THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   IF provider->'line_items'->0 ? 'price_data' AND
    ((provider->'line_items'->0->'price_data'->>'unit_amount')::numeric IS DISTINCT FROM (o->>'amount_total')::numeric
     OR provider->'line_items'->0->'price_data'->>'currency' IS DISTINCT FROM o->>'currency') THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
   IF provider ? 'discounts' AND NOT EXISTS(SELECT 1 FROM payment_provider_refs
    WHERE channel=o->>'payment_channel' AND merchant_namespace=o->>'merchant_namespace'
     AND mode=o->>'payment_mode' AND object_type='coupon' AND offer_kind=o->>'offer_kind'
     AND membership_plan_id::text=o->>'item_id' AND billing_cycle=o->>'billing_cycle'
     AND external_id=provider->'discounts'->0->>'coupon') THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
  END IF;
 END IF;
 RETURN o->>'request_erased_at' IS NULL AND n->>'request_erased_at' IS NOT NULL
  AND erasure_payment_terminal(o)
  AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=(o->>'user_id')::uuid)
  AND (o-ARRAY['checkout_request','purchase_change_request','request_erased_at'])=
      (n-ARRAY['checkout_request','purchase_change_request','request_erased_at'])
  AND n->'checkout_request' IS NOT DISTINCT FROM erasure_payment_envelope(o->'checkout_request','checkout')
  AND n->'purchase_change_request' IS NOT DISTINCT FROM erasure_payment_envelope(o->'purchase_change_request','change');
END $$;
