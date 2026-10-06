-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE B2b: original-run financial projection; no automatic caller.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Two facts are required for one-way enforcement and original request integrity.
-- Financial state continues to live in the original run/call/receipt/ledger.
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS content_erased_at timestamptz;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS original_payload_hash text;
ALTER TABLE public.bill2_runs DROP CONSTRAINT IF EXISTS bill2_run_erasure_facts;
ALTER TABLE public.bill2_runs ADD CONSTRAINT bill2_run_erasure_facts CHECK (
  (content_erased_at IS NULL AND original_payload_hash IS NULL) OR
  (content_erased_at IS NOT NULL AND original_payload_hash IS NOT NULL AND original_payload_hash ~ '^[a-f0-9]{64}$'));

-- Private recursive whitelist, used only with the fixed contract below. No arbitrary JSON survives.
-- Preserve the original scalar representation for decimal/accounting facts; reject malformed facts.
CREATE OR REPLACE FUNCTION public.bill2_erasure_fields(v jsonb, shape jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE result jsonb; k text; spec jsonb; item jsonb; typ text := shape #>> '{}'; s text := v #>> '{}';
BEGIN
  IF jsonb_typeof(shape) = 'object' THEN
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD'; END IF;
    result := '{}';
    IF shape ? '$map' THEN
      FOR k, item IN SELECT * FROM jsonb_each(v) LOOP
        PERFORM bill2_erasure_fields(to_jsonb(k), shape->'$map');
        result := result || jsonb_build_object(k, bill2_erasure_fields(item, shape->'$value'));
      END LOOP;
    ELSE
      FOR k, spec IN SELECT * FROM jsonb_each(shape) LOOP
        IF v ? k THEN result := result || jsonb_build_object(k, bill2_erasure_fields(v->k, spec)); END IF;
      END LOOP;
    END IF;
    RETURN result;
  ELSIF jsonb_typeof(shape) = 'array' THEN
    IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD'; END IF;
    result := '[]';
    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
      result := result || jsonb_build_array(bill2_erasure_fields(item, shape->0));
    END LOOP;
    RETURN result;
  END IF;
  IF typ = 'boolean' AND jsonb_typeof(v) = 'boolean' THEN RETURN v; END IF;
  IF typ = 'integer' AND jsonb_typeof(v) = 'number' AND s ~ '^(0|[1-9][0-9]*)$' THEN RETURN v; END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD'; END IF;
  IF typ = 'id' AND length(s) BETWEEN 1 AND 256 AND s ~ '^[A-Za-z0-9._:/-]+$' THEN RETURN v; END IF;
  IF typ = 'hash' AND s ~ '^[a-f0-9]{64}$' THEN RETURN v; END IF;
  IF typ = 'uuid' AND s ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN v; END IF;
  IF typ = 'currency' AND s ~ '^[A-Z]{3}$' THEN RETURN v; END IF;
  IF typ = 'decimal' THEN PERFORM bill2_decimal(v); RETURN v; END IF;
  IF typ = 'timestamp' AND s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+-]+(Z)?$' THEN
    PERFORM s::timestamptz; RETURN v;
  END IF;
  RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD';
END $$;

CREATE OR REPLACE FUNCTION public.bill2_erasure_run_payload(v jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT bill2_erasure_fields(v, $shape$
{
  "contractVersion": "id",
  "mode": "id",
  "testWindowId": "uuid",
  "moduleId": "uuid",
  "skillId": "uuid",
  "operation": "id",
  "modelId": "uuid",
  "revisionId": "uuid",
  "sourceHash": "hash",
  "callPolicy": [
    {
      "modelId": "uuid",
      "provider": "id",
      "account": "id",
      "model": "id",
      "protocol": "id",
      "multiplier": "decimal",
      "upperUsd": "decimal",
      "inputLimit": "integer",
      "outputLimit": "integer",
      "automaticRetry": "boolean",
      "hiddenTools": "boolean",
      "lookupSupported": "boolean",
      "providerLimits": {
        "providerSlug": "id",
        "contextTokens": "integer",
        "promptUsdPerMillion": "decimal",
        "completionUsdPerMillion": "decimal",
        "requestUsd": "decimal",
        "cacheWriteUsdPerMillion": "decimal"
      },
      "payg": {
        "policyId": "id",
        "profileVersion": "id",
        "evidenceVersion": "id",
        "pricingHash": "hash",
        "endpointTag": "id",
        "nominalPricing": {
          "version": "id",
          "pricingHash": "hash",
          "endpointTag": "id",
          "tiers": [
            {
              "minPromptTokens": "integer",
              "prompt": "decimal",
              "completion": "decimal",
              "internalReasoning": "decimal",
              "request": "decimal",
              "cacheRead": "decimal",
              "cacheWrite": "decimal"
            }
          ],
          "timeOfDay": [
            {
              "minPromptTokens": "integer",
              "prompt": "decimal",
              "completion": "decimal",
              "internalReasoning": "decimal",
              "request": "decimal",
              "cacheRead": "decimal",
              "cacheWrite": "decimal"
            }
          ]
        },
        "templateTokens": "integer",
        "marginTokens": "integer",
        "version": "id",
        "admissionPath": "id",
        "maxBytes": "integer",
        "maxMessages": "integer",
        "maxTools": "integer",
        "maxSchemaBytes": "integer",
        "purposes": [
          "id"
        ],
        "expiresAt": "timestamp"
      }
    }
  ],
  "rules": {
    "version": "id",
    "quoteVersion": "id",
    "creditsPerUsd": "decimal",
    "multiplier": "decimal",
    "fx": {
      "$map": "currency",
      "$value": {
        "version": "id",
        "usdPerUnit": "decimal"
      }
    },
    "billingUnit": {
      "version": "id",
      "creditsPerUsd": "decimal",
      "defaultMultiplier": "decimal",
      "models": {
        "$map": "uuid",
        "$value": {
          "multiplier": "decimal",
          "source": "id"
        }
      },
      "providers": {
        "$map": "id",
        "$value": {
          "multiplier": "decimal",
          "source": "id"
        }
      },
      "hash": "hash"
    }
  },
  "limits": {
    "costUsd": "decimal",
    "credits": "integer",
    "maxPreDeduct": "integer",
    "maxCalls": "integer",
    "deadline": "timestamp"
  },
  "purposeBudget": {
    "purpose": "id",
    "inputBytes": "integer",
    "historyItems": "integer"
  }
}
  $shape$::jsonb);
$$;
REVOKE ALL ON FUNCTION public.bill2_erasure_fields(jsonb,jsonb), public.bill2_erasure_run_payload(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bill2_run_erasure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE projected jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.content_erased_at IS NOT NULL OR NEW.original_payload_hash IS NOT NULL THEN
      RAISE EXCEPTION 'BILL2_RUN_ERASURE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.content_erased_at IS NULL AND NEW.content_erased_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.content_erased_at IS NULL THEN
    IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))
      OR NOT coalesce(bill2_erasure_closed(OLD.actor_id,coalesce(OLD.pre_deduct_id,OLD.id)),false)
      OR NOT OLD.closed THEN RAISE EXCEPTION 'BILL2_RUN_ERASURE_DENIED'; END IF;
    projected := CASE WHEN OLD.result_financial_projection_version IS NOT NULL THEN OLD.result
      ELSE bill2_outcome_projection(OLD.result) END;
    IF (to_jsonb(NEW) - ARRAY['payload','scope','result','content_erased_at','original_payload_hash',
        'result_financial_projection_hash','result_financial_projection_version']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['payload','scope','result','content_erased_at','original_payload_hash',
        'result_financial_projection_hash','result_financial_projection_version'])
      OR NEW.payload IS DISTINCT FROM bill2_erasure_run_payload(OLD.payload)
      OR NEW.scope IS DISTINCT FROM '{}'::jsonb OR NEW.result IS DISTINCT FROM projected
      OR NEW.original_payload_hash IS DISTINCT FROM encode(sha256(convert_to(OLD.payload::text,'utf8')),'hex') THEN
      RAISE EXCEPTION 'BILL2_RUN_ERASURE_IMMUTABLE';
    END IF;
  ELSE
    IF NEW.content_erased_at IS DISTINCT FROM OLD.content_erased_at
      OR NEW.original_payload_hash IS DISTINCT FROM OLD.original_payload_hash
      OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.scope IS DISTINCT FROM OLD.scope THEN
      RAISE EXCEPTION 'BILL2_RUN_ERASURE_IMMUTABLE';
    END IF;
  END IF;
  -- Late close may add only the existing B2a outcome projection, never a body/reference URL.
  IF NEW.result IS NOT NULL THEN
    IF jsonb_typeof(NEW.result) IS DISTINCT FROM 'object'
      OR NEW.result - ARRAY['kind','evidenceHash','evidenceRefHash'] <> '{}'::jsonb
      OR coalesce(NEW.result->>'kind','') NOT IN ('usable_result','confirmed_delivery_failure')
      OR coalesce(NEW.result->>'evidenceHash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(NEW.result->>'evidenceRefHash','') !~ '^[a-f0-9]{64}$'
      OR NEW.result_financial_projection_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'BILL2_RUN_ERASURE_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bill2_run_erasure_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS bill2_run_erasure_guard ON public.bill2_runs;
CREATE TRIGGER bill2_run_erasure_guard BEFORE INSERT OR UPDATE ON public.bill2_runs
  FOR EACH ROW EXECUTE FUNCTION public.bill2_run_erasure_guard();

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_run(p_profile_id uuid,p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r bill2_runs; projected jsonb; result_projection jsonb;
BEGIN
  SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_profile_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501'; END IF;
  PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
  PERFORM x.id FROM bill2_receipts x JOIN bill2_calls c ON c.id=x.call_id
    WHERE c.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
  PERFORM id FROM profiles WHERE id=p_profile_id FOR UPDATE;
  IF NOT coalesce(bill2_erasure_closed(p_profile_id,coalesce(r.pre_deduct_id,r.id)),false) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501';
  END IF;
  IF r.content_erased_at IS NOT NULL THEN RETURN '{"processed":0,"remaining":0}'::jsonb; END IF;
  -- The existing recovery path must first close the call set; no cancellation or refund is invented here.
  IF NOT r.closed THEN RETURN '{"processed":0,"remaining":1,"reason":"call_set_open"}'::jsonb; END IF;
  projected := bill2_erasure_run_payload(r.payload);
  result_projection := CASE WHEN r.result_financial_projection_version IS NOT NULL THEN r.result
    ELSE bill2_outcome_projection(r.result) END;
  UPDATE bill2_runs SET payload=projected,scope='{}',result=result_projection,
    content_erased_at=clock_timestamp(),original_payload_hash=encode(sha256(convert_to(r.payload::text,'utf8')),'hex'),
    result_financial_projection_version=CASE WHEN result_projection IS NOT NULL THEN 1 END,
    result_financial_projection_hash=CASE WHEN result_projection IS NOT NULL
      THEN encode(sha256(convert_to(result_projection::text,'utf8')),'hex') END WHERE id=r.id;
  RETURN '{"processed":1,"remaining":0}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_run(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_run(uuid,uuid) TO service_role;
COMMIT;
