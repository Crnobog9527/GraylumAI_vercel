-- content_erasure_references and bill2_erasure_fields as of 0405, for verify.mjs --before-0406 / --before-fix.
CREATE OR REPLACE FUNCTION public.content_erasure_references(v jsonb, ids uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE x record;
BEGIN
 IF cardinality(ids)=0 OR v IS NULL THEN RETURN false; END IF;
 IF jsonb_typeof(v)='object' THEN
  FOR x IN SELECT * FROM jsonb_each(v) LOOP
   IF x.key IN ('executionId','sourceExecutionId','sourceVersionId','sourceContentId','projectId',
    'workItemId','roundId','conversationId','sessionId','dependencyId','source_message_id',
    'sourceScriptId','contentId','draftId','accountProjectId')
    AND lower(x.value#>>'{}')=ANY(ids::text[]) THEN RETURN true; END IF;
   IF content_erasure_references(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='array' THEN
  FOR x IN SELECT value FROM jsonb_array_elements(v) LOOP
   IF content_erasure_references(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='string' AND ((v#>>'{}') IS JSON OBJECT OR (v#>>'{}') IS JSON ARRAY) THEN
  RETURN content_erasure_references((v#>>'{}')::jsonb,ids);
 END IF;
 RETURN false;
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_erasure_fields(v jsonb, shape jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- These financial identifiers are free-form nonempty strings in the creation contract.
  -- Keep their exact value; constrain the containing paths and JSON types, not a new grammar.
  IF typ = 'id' AND length(s) > 0 THEN RETURN v; END IF;
  IF typ = 'hash' AND s ~ '^[a-f0-9]{64}$' THEN RETURN v; END IF;
  IF typ = 'uuid' AND s ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN v; END IF;
  IF typ = 'currency' AND s ~ '^[A-Z]{3}$' THEN RETURN v; END IF;
  IF typ = 'decimal' THEN PERFORM bill2_decimal(v); RETURN v; END IF;
  IF typ = 'timestamp' AND s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+-]+(Z)?$' THEN
    PERFORM s::timestamptz; RETURN v;
  END IF;
  RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD';
END $function$;

