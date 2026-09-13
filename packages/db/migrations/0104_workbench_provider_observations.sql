/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- BILL-1 evidence retention only. No historical inference, terminal transition,
-- wallet change, provider retry, or quarantine release.
BEGIN;
ALTER TABLE public.artifact_generations
 ADD COLUMN IF NOT EXISTS provider_observations jsonb;

CREATE OR REPLACE FUNCTION public.artifact_observe_generation(
 p_actor_id uuid,p_project_id uuid,p_round_id uuid,p_request_id uuid,
 p_token uuid,p_observation jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.artifact_generations%ROWTYPE; phase text; k text; v jsonb;
BEGIN
 -- Same project-first lock order as artifact_generation and rejection.
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM artifact_generations
 WHERE project_id=p_project_id AND round_id=p_round_id AND request_id=p_request_id FOR UPDATE;
 IF NOT FOUND OR o.dispatch_token IS DISTINCT FROM p_token OR o.state NOT IN ('dispatched','unknown','responded','succeeded','refunded')
 THEN RAISE EXCEPTION 'generation conflict'; END IF;
 IF jsonb_typeof(p_observation) IS DISTINCT FROM 'object' OR octet_length(p_observation::text)>2048
 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 IF NOT (p_observation ?& ARRAY['phase','httpStatus','providerResponseId','finishReason','usage'])
 OR (p_observation - ARRAY['phase','httpStatus','providerResponseId','finishReason','usage']) <> '{}'::jsonb
 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 phase:=p_observation->>'phase';
 IF phase IS NULL OR phase NOT IN ('headers','body')
 OR jsonb_typeof(p_observation->'httpStatus') IS DISTINCT FROM 'number'
 OR (p_observation->>'httpStatus')::numeric NOT BETWEEN 100 AND 599
 OR (p_observation->>'httpStatus')::numeric <> trunc((p_observation->>'httpStatus')::numeric)
 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 FOREACH k IN ARRAY ARRAY['providerResponseId','finishReason'] LOOP
  v:=p_observation->k;
  IF v <> 'null'::jsonb AND (jsonb_typeof(v)<>'string'
   OR (k='providerResponseId' AND (p_observation->>k) !~ '^[A-Za-z0-9_-]{1,200}$')
   OR (k='finishReason' AND (p_observation->>k) !~ '^[A-Za-z0-9_-]{1,64}$'))
  THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 END LOOP;
 v:=p_observation->'usage';
 IF v <> 'null'::jsonb THEN
  IF jsonb_typeof(v)<>'object' OR NOT (v ?& ARRAY['promptTokens','completionTokens','reportedCostUsd'])
   OR (v - ARRAY['promptTokens','completionTokens','reportedCostUsd']) <> '{}'::jsonb
  THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
  FOREACH k IN ARRAY ARRAY['promptTokens','completionTokens','reportedCostUsd'] LOOP
   IF v->k <> 'null'::jsonb THEN
    IF jsonb_typeof(v->k)<>'number' THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
    IF (v->>k)::numeric < 0 OR (k<>'reportedCostUsd' AND
      ((v->>k)::numeric>9007199254740991 OR (v->>k)::numeric<>trunc((v->>k)::numeric)))
    THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
   END IF;
  END LOOP;
 END IF;
 -- Each of the two observations is immutable and idempotent. Different header
 -- and body IDs are retained separately; neither is a settlement authority.
 IF o.provider_observations ? phase THEN
  IF o.provider_observations->phase IS DISTINCT FROM p_observation
  THEN RAISE EXCEPTION 'provider observation conflict'; END IF;
  RETURN;
 END IF;
 UPDATE artifact_generations SET provider_observations=
  coalesce(provider_observations,'{}'::jsonb)||jsonb_build_object(phase,p_observation)
 WHERE id=o.id;
END $$;
REVOKE ALL ON FUNCTION public.artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;
-- No table/column grants: evidence remains private, outside the public projection.
COMMIT;
-- Repeatable additive migration. Roll application back while retaining this
-- column/RPC and evidence; old callers and existing terminal logic ignore it.
