-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-2d (LIB_DOCS_PLAN 4.4, BILL2 prerequisites 1–3): one inline JPEG per PAYG call, image price in the
-- frozen upper bound, and a library_document billing scope. No caller is added; nothing opens to users.
-- TypeScript twin: packages/api/src/services/bill2/imageInput.ts (keep the constants identical).
-- Rollback: these are additive checks inside existing functions. Revert by re-running the previous bodies
-- from pg_get_functiondef history (markers below); no data is written or removed.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Validates the optional image of one call quote and returns {bytes,tokens}; {0,0} without an image.
-- q: stable policy payg; v: call quote; limits: providerLimits; phase: the call purpose.
CREATE OR REPLACE FUNCTION public.bill2_payg_image(q jsonb,v jsonb,limits jsonb,phase text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE i jsonb:=v->'image';a jsonb:=q->'imageInput';w bigint;h bigint;n bigint;k text;
BEGIN
 IF NOT coalesce(v ? 'image',false) THEN RETURN jsonb_build_object('bytes',0,'tokens',0);END IF;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
 OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(i) x) IS DISTINCT FROM ARRAY['dataUrlBytes','height','tokensUpper','width']
 OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(a) x) IS DISTINCT FROM ARRAY['maxDataUrlBytes','maxEdge']
 -- Only these purposes may send an image (PUBLISH-MONITOR PR-3c adds its own here and in imageInput.ts).
 OR coalesce(phase,'') NOT IN ('library_ocr') OR NOT coalesce(limits ? 'imageUsd',false)
 THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['dataUrlBytes','width','height','tokensUpper'] LOOP
  IF jsonb_typeof(i->k) IS DISTINCT FROM 'number' OR (i->>k) !~ '^[1-9][0-9]{0,6}$' THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['maxDataUrlBytes','maxEdge'] LOOP
  IF jsonb_typeof(a->k) IS DISTINCT FROM 'number' OR (a->>k) !~ '^[1-9][0-9]{0,6}$' THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 END LOOP;
 w:=(i->>'width')::bigint;h:=(i->>'height')::bigint;n:=(i->>'dataUrlBytes')::bigint;
 -- Shape limits make the ceiling cover tiled vision schemes; 2048 / 819,223 are hard maxima.
 IF (a->>'maxDataUrlBytes')::bigint>819223 OR (a->>'maxEdge')::bigint>2048
 OR n>(a->>'maxDataUrlBytes')::bigint OR n>=coalesce((v->>'bytes')::bigint,0)
 OR least(w,h)<64 OR greatest(w,h)>(a->>'maxEdge')::bigint OR greatest(w,h)>4*least(w,h)
 OR (i->>'tokensUpper')::bigint<>2*ceil(w/14.0)::bigint*ceil(h/14.0)::bigint+2048
 OR bill2_decimal(limits->'imageUsd')<0 THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 RETURN jsonb_build_object('bytes',n,'tokens',(i->>'tokensUpper')::bigint);
END $$;
REVOKE ALL ON FUNCTION public.bill2_payg_image(jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- T counts the text bytes plus the image token ceiling; the text part keeps the 196,608-byte cap;
-- U adds the image price once per image token (an upper bound for per-image or per-token pricing).
DO $$ DECLARE src text;n1 text;n2 text;n3 text;img text:=$i$bill2_payg_image(q,v,limits,p->>'phase')$i$;
BEGIN
 src:=pg_get_functiondef('public.bill2_payg_validate_quote(bill2_runs,jsonb)'::regprocedure);
 IF position('-- 0285 image' IN src)>0 THEN RETURN;END IF;
 n1:=$n$ OR t<>(v->>'bytes')::bigint+(v->>'templateTokens')::bigint+(v->>'marginTokens')::bigint$n$;
 n2:=$n$ OR (v->>'bytes')::int NOT BETWEEN 1 AND least((q->>'maxBytes')::int,196608)$n$;
 n3:=$n$u:=ceil(((t*price+o*bill2_decimal(limits->'completionUsdPerMillion'))/1000000)*1e12)/1e12+bill2_decimal(limits->'requestUsd');$n$;
 IF (length(src)-length(replace(src,n1,'')))/length(n1)<>1 OR (length(src)-length(replace(src,n2,'')))/length(n2)<>1
 OR (length(src)-length(replace(src,n3,'')))/length(n3)<>1 THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_SOURCE_MISMATCH: 0285';END IF;
 src:=replace(src,n1,format($r$ -- 0285 image
 OR t<>(v->>'bytes')::bigint-(%1$s->>'bytes')::bigint+(%1$s->>'tokens')::bigint+(v->>'templateTokens')::bigint+(v->>'marginTokens')::bigint$r$,img));
 src:=replace(src,n2,format($r$ OR (v->>'bytes')::bigint-(%1$s->>'bytes')::bigint NOT BETWEEN 1 AND least((q->>'maxBytes')::int,196608)$r$,img));
 src:=replace(src,n3,format($r$u:=ceil(((t*price+o*bill2_decimal(limits->'completionUsdPerMillion'))/1000000)*1e12)/1e12+bill2_decimal(limits->'requestUsd')
  +(%1$s->>'tokens')::bigint*(CASE WHEN limits ? 'imageUsd' THEN bill2_decimal(limits->'imageUsd') ELSE 0 END);$r$,img));
 EXECUTE src;
END $$;

-- library_document scope: the actor's own PDF or Word document that is processing or ready.
DO $$ BEGIN
 IF to_regprocedure('public.bill2_scope_allowed_before_library(uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.bill2_scope_allowed(uuid,jsonb) RENAME TO bill2_scope_allowed_before_library;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_scope_allowed(a uuid,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN s->>'kind'='library_document' THEN
  (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(s) x)=ARRAY['documentId','kind']
  AND coalesce(s->>'documentId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS(SELECT 1 FROM library_documents d WHERE d.id=(s->>'documentId')::uuid AND d.actor_id=a
   AND d.kind='document' AND d.format IN ('pdf','docx') AND d.status IN ('processing','ready') AND d.deleted_at IS NULL)
 ELSE bill2_scope_allowed_before_library(a,s) END
$$;
REVOKE ALL ON FUNCTION public.bill2_scope_allowed(uuid,jsonb),public.bill2_scope_allowed_before_library(uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

-- Account erasure keeps the image's financial fields (sizes, token ceiling, image price), never the image.
DO $$ DECLARE src text;
BEGIN
 src:=pg_get_functiondef('public.bill2_erasure_run_payload(jsonb)'::regprocedure);
 IF position('"imageUsd"' IN src)=0 THEN
  IF (length(src)-length(replace(src,'"cacheWriteUsdPerMillion": "decimal"','')))/length('"cacheWriteUsdPerMillion": "decimal"')<>1
  OR (length(src)-length(replace(src,'"expiresAt": "timestamp"','')))/length('"expiresAt": "timestamp"')<>1
  THEN RAISE EXCEPTION 'BILL2_ERASURE_SOURCE_MISMATCH: 0285 run';END IF;
  src:=replace(src,'"cacheWriteUsdPerMillion": "decimal"','"cacheWriteUsdPerMillion": "decimal", "imageUsd": "decimal"');
  src:=replace(src,'"expiresAt": "timestamp"','"expiresAt": "timestamp", "imageInput": {"maxDataUrlBytes": "integer", "maxEdge": "integer"}');
  EXECUTE src;
 END IF;
 src:=pg_get_functiondef('public.bill2_erasure_call_payload(jsonb)'::regprocedure);
 IF position('"tokensUpper"' IN src)=0 THEN
  IF (length(src)-length(replace(src,'"tools":"integer","schemaBytes":"integer"}','')))/length('"tools":"integer","schemaBytes":"integer"}')<>1
  THEN RAISE EXCEPTION 'BILL2_ERASURE_SOURCE_MISMATCH: 0285 call';END IF;
  EXECUTE replace(src,'"tools":"integer","schemaBytes":"integer"}',
   '"tools":"integer","schemaBytes":"integer","image":{"dataUrlBytes":"integer","width":"integer","height":"integer","tokensUpper":"integer"}}');
 END IF;
END $$;
COMMIT;
