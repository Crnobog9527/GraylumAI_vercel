-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: private text in existing public ledger rows; no automatic caller.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Fixed financial metadata shapes only. Preserve original scalar types and null/missing distinctions.
CREATE OR REPLACE FUNCTION public.erasure_ledger_value(v jsonb,shape jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE k text; item jsonb; result jsonb; typ text:=shape#>>'{}';
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN v; END IF;
 IF jsonb_typeof(shape)='object' AND shape ? '$enum' THEN
  IF jsonb_typeof(v)='string' AND (shape->'$enum') @> jsonb_build_array(v) THEN RETURN v; END IF;
  RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE';
 END IF;
 IF jsonb_typeof(shape)='object' THEN
  IF jsonb_typeof(v)<>'object' THEN RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE'; END IF;
  result:='{}';
  FOR k,item IN SELECT * FROM jsonb_each(shape) LOOP
   IF v ? k THEN result:=result||jsonb_build_object(k,erasure_ledger_value(v->k,item)); END IF;
  END LOOP;
  RETURN result;
 ELSIF jsonb_typeof(shape)='array' THEN
  IF jsonb_typeof(v)<>'array' THEN RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE'; END IF;
  result:='[]';
  FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
   result:=result||jsonb_build_array(erasure_ledger_value(item,shape->0));
  END LOOP;
  RETURN result;
 END IF;
 IF typ='number' AND jsonb_typeof(v) IN ('number','string')
  AND v#>>'{}' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN v; END IF;
 IF typ='delivery_failure_reason' AND v='"confirmed_delivery_failure"'::jsonb THEN RETURN v; END IF;
 IF typ='boolean' AND jsonb_typeof(v)='boolean' THEN RETURN v; END IF;
 IF typ='id' AND jsonb_typeof(v)='string' AND length(v#>>'{}')>0 THEN RETURN v; END IF;
 RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE';
END $$;
REVOKE ALL ON FUNCTION public.erasure_ledger_value(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erasure_ledger_value(jsonb,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.erasure_ledger_metadata(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT erasure_ledger_value(v,$shape${
 "requestId": "id",
 "preDeductId": "id",
 "chargedGrantId": "id",
 "chargedPeriodKey": "id",
 "modelId": "id",
 "contractVersion": "id",
 "runId": "id",
 "callId": "id",
 "outcome": "id",
 "canonicalResult": "id",
 "eventId": "id",
 "subscriptionId": "id",
 "periodKey": "id",
 "refundId": "id",
 "invoiceId": "id",
 "idempotencyKey": "id",
 "refundStatus": "id",
 "refundEventType": "id",
 "reversalStatus": "id",
 "grantType": "id",
 "billingCycle": "id",
 "stripeSubscriptionStatus": "id",
 "stripeSubscriptionUserId": "id",
 "thresholdVersion": "id",
 "sourceType": "id",
 "sourceId": "id",
 "balance_before": "number",
 "balance_after": "number",
 "amountToPeriod": "number",
 "amountToOther": "number",
 "periodConsumedDelta": "number",
 "preDeductedAmount": "number",
 "actualCredits": "number",
 "difference": "number",
 "requestedDifference": "number",
 "refundAmount": "number",
 "requestedRefundAmount": "number",
 "consumedCredits": "number",
 "refundedCredits": "number",
 "requestedRefundedCredits": "number",
 "consumedTokens": {
  "inputTokens": "number",
  "outputTokens": "number"
 },
 "providerCostUsd": "number",
 "requiredClawbackAmount": "number",
 "appliedClawbackAmount": "number",
 "shortfallAmount": "number",
 "clawbackAmount": "number",
 "reversedGrantCount": "number",
 "nominalReserved": "number",
 "actualRestore": "number",
 "intercepted": "number",
 "periodIndex": "number",
 "totalPeriods": "number",
 "G": "number",
 "H": "number",
 "A": "number",
 "L": "number",
 "refundInterceptedOverrun": "number",
 "refundInterceptedRestoration": "number",
 "reviewRequired": "boolean",
 "usageInPrivateReceipts": "boolean",
 "aborted": "boolean",
 "timestamp": "id",
 "reversedGrantPeriodKeys": [
  "id"
 ],
 "usage": {
  "inputTokens": "number",
  "outputTokens": "number",
  "totalTokens": "number",
  "cachedTokens": "number",
  "cacheCreationTokens": "number",
  "webSearchCount": "number",
  "input_tokens": "number",
  "output_tokens": "number",
  "prompt_tokens": "number",
  "completion_tokens": "number",
  "total_tokens": "number",
  "cache_read_input_tokens": "number",
  "cache_creation_input_tokens": "number",
  "prompt_tokens_details": {
   "cached_tokens": "number"
  },
  "completion_tokens_details": {
   "reasoning_tokens": "number"
  },
  "cacheReadTokens": "number",
  "contractVersion": "id",
  "runId": "id",
  "callId": "id",
  "preDeductId": "id",
  "providerCostUsd": "number",
  "nominalCostUsd": "number",
  "nominalSource": {
   "$enum": ["nominal", "not_dispatched", "confirmed_failure", "actual_fallback"]
  },
  "theoreticalDelta": "number",
  "chargedDelta": "number",
  "platformCapCredits": "number",
  "platformBoundCredits": "number",
  "outcome": {
   "$enum": ["responded", "truncated", "delivered", "cancelled", "confirmed_failure"]
  },
  "generationId": "id",
  "researchOperationId": "id",
  "executionId": "id",
  "calculatedModelCostUsd": "number",
  "agentKeyCost": {
   "unit": {
    "$enum": ["agentkey-credit"]
   },
   "quoted": "number",
   "actual": "number",
   "status": {
    "$enum": ["reported", "unknown"]
   }
  },
  "searchCount": "number",
  "pricing": {
   "modelId": "id",
   "inputPer1M": "number",
   "outputPer1M": "number",
   "searchPer1K": "number",
   "pricingSource": "id",
   "cacheReadPer1M": "number",
   "cacheWritePer1M": "number",
   "providerModel": "id",
   "rates": {
    "inputPer1M": "number",
    "outputPer1M": "number",
    "cacheReadPer1M": "number",
    "cacheWritePer1M": "number",
    "cacheCreationPer1M": "number",
    "searchPer1K": "number"
   },
   "settings": {
    "creditsPerUsd": "number",
    "tokenPriceMultiplier": "number",
    "minPreDeduct": "number",
    "maxPreDeduct": "number",
    "safetyMargin": "number",
    "searchSurchargeCredits": "number",
    "requireModelPricing": "boolean"
   },
   "pricing": {
    "inputPer1M": "number",
    "outputPer1M": "number",
    "cacheReadPer1M": "number",
    "cacheWritePer1M": "number",
    "cacheCreationPer1M": "number",
    "searchPer1K": "number"
   },
   "reservedCredits": "number",
   "inputTokens": "number",
   "maxTokens": "number"
  },
  "credits": "number",
  "costUsd": "number",
  "providerId": "id",
  "usageEvidence": {
   "promptTokens": "number",
   "completionTokens": "number",
   "totalTokens": "number",
   "toolUsePromptTokens": "number",
   "cachedTokens": "number",
   "cacheWriteTokens": "number",
   "reasoningTokens": "number",
   "source": {
    "$enum": ["provider_usage"]
   },
   "providerResponseId": "id",
   "openRouterCost": {
    "totalUsd": "number",
    "upstreamInferenceUsd": "number",
    "upstreamPromptUsd": "number",
    "upstreamCompletionUsd": "number",
    "serverToolUsd": "number",
    "searchUsd": "number",
    "isByok": "boolean"
   }
  }
 },
 "pricing": {
  "modelId": "id",
  "inputPer1M": "number",
  "outputPer1M": "number",
  "searchPer1K": "number",
  "pricingSource": "id",
  "cacheReadPer1M": "number",
  "cacheWritePer1M": "number",
  "providerModel": "id",
  "rates": {
   "inputPer1M": "number",
   "outputPer1M": "number",
   "cacheReadPer1M": "number",
   "cacheWritePer1M": "number",
   "cacheCreationPer1M": "number",
   "searchPer1K": "number"
  },
  "settings": {
   "creditsPerUsd": "number",
   "tokenPriceMultiplier": "number",
   "minPreDeduct": "number",
   "maxPreDeduct": "number",
   "safetyMargin": "number",
   "searchSurchargeCredits": "number",
   "requireModelPricing": "boolean"
  },
  "pricing": {
   "inputPer1M": "number",
   "outputPer1M": "number",
   "cacheReadPer1M": "number",
   "cacheWritePer1M": "number",
   "cacheCreationPer1M": "number",
   "searchPer1K": "number"
  },
  "reservedCredits": "number",
  "inputTokens": "number",
  "maxTokens": "number"
 },
 "billingSettingsSnapshot": {
  "creditsPerUsd": "number",
  "tokenPriceMultiplier": "number",
  "minPreDeduct": "number",
  "maxPreDeduct": "number",
  "safetyMargin": "number"
 },
 "nominalCostUsd": "number",
 "theoreticalDelta": "number",
 "chargedDelta": "number",
 "platformCapCredits": "number",
 "platformBoundCredits": "number",
 "requestedCompensation": "number",
 "nominalSource": {
  "$enum": ["nominal", "not_dispatched", "confirmed_failure", "actual_fallback"]
 },
 "originalPreDeductId": "id",
 "originalSpendId": "id",
 "reason": "delivery_failure_reason",
 "evidence": {
  "inputTokens": "number",
  "outputTokens": "number",
  "cacheReadTokens": "number",
  "cacheCreationTokens": "number",
  "credits": "number",
  "costUsd": "number",
  "providerId": "id",
  "outcome": {
   "$enum": ["responded", "truncated"]
  },
  "usageEvidence": {
   "promptTokens": "number",
   "completionTokens": "number",
   "totalTokens": "number",
   "toolUsePromptTokens": "number",
   "cachedTokens": "number",
   "cacheWriteTokens": "number",
   "reasoningTokens": "number",
   "source": {
    "$enum": ["provider_usage"]
   },
   "providerResponseId": "id",
   "openRouterCost": {
    "totalUsd": "number",
    "upstreamInferenceUsd": "number",
    "upstreamPromptUsd": "number",
    "upstreamCompletionUsd": "number",
    "serverToolUsd": "number",
    "searchUsd": "number",
    "isByok": "boolean"
   }
  }
 },
 "provider_usage": {
  "promptTokens": "number",
  "completionTokens": "number",
  "totalTokens": "number",
  "toolUsePromptTokens": "number",
  "cachedTokens": "number",
  "cacheWriteTokens": "number",
  "reasoningTokens": "number",
  "source": {
   "$enum": ["provider_usage"]
  },
  "providerResponseId": "id",
  "openRouterCost": {
   "totalUsd": "number",
   "upstreamInferenceUsd": "number",
   "upstreamPromptUsd": "number",
   "upstreamCompletionUsd": "number",
   "serverToolUsd": "number",
   "searchUsd": "number",
   "isByok": "boolean"
  }
 },
 "search_evidence": {
  "requested": "boolean",
  "available": "boolean",
  "executed": "boolean",
  "queryCount": "number",
  "providerUnits": "number",
  "surchargeUnits": "number",
  "surchargeCredits": "number",
  "status": {
   "$enum": ["not_requested", "unavailable", "verified", "unknown"]
  },
  "providerUnit": {
   "$enum": ["grounded-prompt", "unique-query", "search-query"]
  }
 },
 "count_method": {
  "$enum": ["official", "estimate"]
 },
 "count_source": {
  "$enum": ["anthropic_count_tokens", "gemini_count_tokens", "provider_usage", "estimate"]
 },
 "preflight_count_source": {
  "$enum": ["anthropic_count_tokens", "gemini_count_tokens", "provider_usage", "estimate"]
 },
 "counter_version": {
  "$enum": ["2026-03-10"]
 },
 "generationId": "id",
 "researchOperationId": "id",
 "executionId": "id",
 "calculatedModelCostUsd": "number",
 "agentKeyCost": {
  "unit": {
   "$enum": ["agentkey-credit"]
  },
  "quoted": "number",
  "actual": "number",
  "status": {
   "$enum": ["reported", "unknown"]
  }
 },
 "searchCount": "number"
}$shape$::jsonb);
$$;
REVOKE ALL ON FUNCTION public.erasure_ledger_metadata(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erasure_ledger_metadata(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.erasure_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prior jsonb; incoming jsonb:=to_jsonb(NEW); projected jsonb; cols text[]; closed boolean;
BEGIN
 cols:=CASE TG_TABLE_NAME WHEN 'credit_transactions' THEN ARRAY['description','metadata','content_erased_at']
  WHEN 'billing_history' THEN ARRAY['reason','metadata','content_erased_at']
  WHEN 'token_stats' THEN ARRAY['metadata','content_erased_at']
  WHEN 'ai_usage_logs' THEN ARRAY['error_message','ip_address','user_agent','metadata','content_erased_at'] END;
 IF cols IS NULL THEN RAISE EXCEPTION 'ERASURE_LEDGER_TABLE_DENIED'; END IF;
 IF TG_OP='UPDATE' THEN prior:=to_jsonb(OLD); END IF;
 IF TG_OP='INSERT' AND incoming->>'content_erased_at' IS NOT NULL THEN
  RAISE EXCEPTION 'ERASURE_LEDGER_IMMUTABLE';
 END IF;
 -- Existing client paths remain unchanged. They cannot claim cleanup or bypass closed-account RLS.
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  AND current_user<>'service_role' THEN
  IF incoming->>'content_erased_at' IS NOT NULL THEN RAISE EXCEPTION 'ERASURE_LEDGER_DENIED'; END IF;
  RETURN NEW;
 END IF;
 closed:=EXISTS(SELECT 1 FROM account_erasure_requests e JOIN profiles p ON p.id=e.profile_id
  WHERE e.profile_id=NEW.user_id AND p.status='deleted' AND p.is_deleted='true');
 IF prior->>'content_erased_at' IS NOT NULL THEN
  IF incoming->'content_erased_at' IS DISTINCT FROM prior->'content_erased_at'
   OR incoming->'user_id' IS DISTINCT FROM prior->'user_id' THEN
   RAISE EXCEPTION 'ERASURE_LEDGER_IMMUTABLE';
  END IF;
 ELSIF TG_OP='UPDATE' AND incoming->>'content_erased_at' IS NOT NULL THEN
  IF NOT closed OR current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   OR (incoming-cols) IS DISTINCT FROM (prior-cols) THEN
   RAISE EXCEPTION 'ERASURE_LEDGER_DENIED';
  END IF;
 ELSIF NOT closed THEN RETURN NEW;
 END IF;
 projected:=erasure_ledger_metadata(NEW.metadata);
 IF TG_OP='UPDATE' AND prior->>'content_erased_at' IS NULL
  AND incoming->>'content_erased_at' IS NOT NULL
  AND projected IS DISTINCT FROM erasure_ledger_metadata(OLD.metadata) THEN
  RAISE EXCEPTION 'ERASURE_LEDGER_EVIDENCE_CHANGED';
 END IF;
 incoming:=incoming||jsonb_build_object('metadata',projected,
  'content_erased_at',coalesce(prior->>'content_erased_at',incoming->>'content_erased_at',clock_timestamp()::text));
 IF TG_TABLE_NAME='credit_transactions' THEN incoming:=incoming||'{"description":null}'::jsonb;
 ELSIF TG_TABLE_NAME='billing_history' THEN incoming:=incoming||'{"reason":null}'::jsonb;
 ELSIF TG_TABLE_NAME='ai_usage_logs' THEN
  incoming:=incoming||'{"error_message":null,"ip_address":null,"user_agent":null}'::jsonb;
 END IF;
 NEW:=jsonb_populate_record(NEW,incoming);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.erasure_ledger_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['credit_transactions','billing_history','token_stats','ai_usage_logs'] LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS content_erased_at timestamptz',t);
  EXECUTE format('DROP TRIGGER IF EXISTS zz_erasure_ledger_guard ON public.%I',t);
  -- Normalize existing ledger classification first; cleanup then refuses any changed financial field.
  EXECUTE format('CREATE TRIGGER zz_erasure_ledger_guard BEFORE INSERT OR UPDATE ON public.%I
   FOR EACH ROW EXECUTE FUNCTION public.erasure_ledger_guard()',t);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_ledger(
 p_profile_id uuid,p_table text,p_limit integer DEFAULT 100,p_after_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item record; processed integer:=0; manual integer:=0; remaining bigint; last_id uuid; assignments text;
BEGIN
 IF p_table IS NULL OR p_table<>ALL(ARRAY['credit_transactions','billing_history','token_stats','ai_usage_logs']) THEN
  RAISE EXCEPTION 'ERASURE_LEDGER_TABLE_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM account_erasure_requests e JOIN profiles p ON p.id=e.profile_id
  WHERE e.profile_id=p_profile_id AND p.status='deleted' AND p.is_deleted='true') THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501';
 END IF;
 assignments:=CASE p_table WHEN 'credit_transactions' THEN 'description=NULL,'
  WHEN 'billing_history' THEN 'reason=NULL,' WHEN 'token_stats' THEN ''
  ELSE 'error_message=NULL,ip_address=NULL,user_agent=NULL,' END;
 -- One table per transaction, skip locked rows, stable cursor: no profile/run lock or network call.
 FOR item IN EXECUTE format('SELECT id FROM public.%I WHERE user_id=$1 AND content_erased_at IS NULL
   AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED',p_table)
  USING p_profile_id,p_after_id,p_limit LOOP
  last_id:=item.id;
  BEGIN
   EXECUTE format('UPDATE public.%I SET %s metadata=erasure_ledger_metadata(metadata),
    content_erased_at=clock_timestamp() WHERE id=$1',p_table,assignments) USING item.id;
   processed:=processed+1;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM NOT IN ('ERASURE_LEDGER_INVALID_EVIDENCE','ERASURE_LEDGER_DENIED') THEN RAISE; END IF;
   manual:=manual+1;
  END;
 END LOOP;
 EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1 AND content_erased_at IS NULL',p_table)
  INTO remaining USING p_profile_id;
 RETURN jsonb_build_object('processed',processed,'remaining',remaining,'manualReview',manual,'nextRowId',last_id);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_ledger(uuid,text,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_ledger(uuid,text,integer,uuid) TO service_role;
COMMIT;
