-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DATA-ERASURE / DB-PERF (number 0406 assigned by the controller): deleting a long conversation still took 8.7 s on staging
-- after 0404 (rolled-back measurement by the controller, 60 s timeout): content_erasure_references 145 092 calls / 1.7 s
-- and bill2_erasure_fields 26 476 calls / 0.9 s were the two biggest functions, and about 3 s ran outside the functions the
-- measurement could attribute (the conversation-scope checks in content_erasure_mark_session call the same helpers).
-- content_erasure_references(v, ids) walks every node of a JSON value (one plpgsql call per node) to find a string equal to
-- one of the ids; it is applied to the JSON columns of every row of the account (scope material, requests, rounds, ...).
-- bill2_erasure_fields(v, shape) walks every key of the shape (dozens) for every object of a receipt or run payload.
-- Changes, results identical: (1) content_erasure_references becomes a SQL wrapper that first checks, with one regular
-- expression over the value's lower-cased text, whether any id appears in it at all (a match must contain the id text);
-- only values that contain an id, or contain a JSON escape sequence that could spell one, are walked, by the unchanged
-- walker now named content_erasure_references_walk. (2) bill2_erasure_fields walks the keys the value and the shape share
-- instead of every key of the shape; scalar checks and every error are unchanged.
-- Compatibility: same signatures, volatility and result for every input; old and new application code are interchangeable.
-- Repeatable: CREATE OR REPLACE only, no data or index change. Recovery: re-apply content_erasure_references (without the
-- wrapper) and bill2_erasure_fields from packages/db/functions as of 0405; the new walker function can stay.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.content_erasure_references_walk(v jsonb, ids uuid[])
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
   IF content_erasure_references_walk(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='array' THEN
  FOR x IN SELECT value FROM jsonb_array_elements(v) LOOP
   IF content_erasure_references_walk(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='string' AND ((v#>>'{}') IS JSON OBJECT OR (v#>>'{}') IS JSON ARRAY) THEN
  RETURN content_erasure_references_walk((v#>>'{}')::jsonb,ids);
 END IF;
 RETURN false;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_references(v jsonb, ids uuid[])
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- 0406: a reference is a string equal to one of the ids, so its text must appear in the value's text. One pass of a regular
 -- expression over the text rules out nearly every value without walking its nodes. A value that contains a JSON escape
 -- (a nested JSON string may spell an id with \u escapes) is always walked, so the answer is exactly the old one.
 SELECT CASE WHEN ids IS NULL OR cardinality(ids)=0 OR v IS NULL THEN false
  ELSE (position('\u' IN lower(v::text))>0
    OR coalesce(lower(v::text) ~ (SELECT string_agg(i::text,'|') FROM unnest(ids) i),false))
   AND content_erasure_references_walk(v,ids) END
$function$;

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
      FOR k, spec IN SELECT s.key, s.value FROM jsonb_each(v) x JOIN jsonb_each(shape) s ON s.key = x.key LOOP
        result := result || jsonb_build_object(k, bill2_erasure_fields(v->k, spec));
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

COMMIT;
