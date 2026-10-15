-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Candidate only: move into an assigned append-only migration after queue coordination.
-- No data mutation or privilege change. Original erasure guard remains authoritative.
CREATE OR REPLACE FUNCTION public.erasure_payment_envelope(v jsonb,k text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE ids jsonb:='{"orderId":"id","userId":"id","itemId":"id","itemType":"id","billingCycle":"id","priceId":"id","upgradeAttemptId":"id"}';
 shape jsonb; amount jsonb; wrapper jsonb; provider jsonb;
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
   -- Recursion handles only the known original Stripe schema, never another transport envelope.
   IF provider ?| ARRAY['providerRequest','merchant','method'] THEN
    RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
   END IF;
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
