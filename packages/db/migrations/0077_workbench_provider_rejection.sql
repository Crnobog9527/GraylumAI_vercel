-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- A verified pre-generation HTTP 429 is a refusal, not an unknown paid result.
-- No historical unknown request is reclassified by this migration.
BEGIN;
ALTER TABLE public.artifact_generations ADD COLUMN IF NOT EXISTS failure_code text
 CHECK (failure_code IS NULL OR failure_code='provider_rate_limited');
CREATE OR REPLACE FUNCTION public.artifact_generation_public(o public.artifact_generations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('requestId',o.request_id,'stepId',o.step_id,'state',o.state,
 'reservedCredits',(o.quote->>'reservedCredits')::integer,'chargedCredits',o.charged_credits,
 'candidateId',o.candidate_id,'createdAt',o.created_at,'failureCode',o.failure_code)
$$;
CREATE OR REPLACE FUNCTION public.artifact_reject_generation(
 p_actor_id uuid,p_project_id uuid,p_round_id uuid,p_request_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; o public.artifact_generations%ROWTYPE;
BEGIN
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM artifact_generations WHERE project_id=p.id AND round_id=p_round_id AND request_id=p_request_id;
 IF NOT FOUND OR o.dispatch_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'generation conflict'; END IF;
 IF o.state='refunded' AND o.failure_code='provider_rate_limited' THEN RETURN artifact_generation_public(o); END IF;
 -- No browser endpoint accepts this proof or token. The server calls this only
 -- after a bounded HTTP 429 error envelope with no choices or usage. Timeouts,
 -- HTTP 200 error bodies and already-unknown operations cannot use this path.
 IF o.state<>'dispatched' OR o.result IS NOT NULL OR o.candidate_id IS NOT NULL THEN RAISE EXCEPTION 'generation conflict'; END IF;
 PERFORM atomic_refund(p_actor_id,o.pre_deduct_id,'Workbench provider rejected before generation');
 UPDATE artifact_generations SET state='refunded',charged_credits=0,failure_code='provider_rate_limited'
 WHERE id=o.id RETURNING * INTO o;
 RETURN artifact_generation_public(o);
END $$;
REVOKE ALL ON FUNCTION public.artifact_reject_generation(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_reject_generation(uuid,uuid,uuid,uuid,uuid) TO service_role;
COMMIT;
-- Idempotent and additive; no saved rows or client permissions change on apply.
-- Rollback: deploy the previous server, then revoke service_role EXECUTE on the
-- new function. Keep the column and existing refund records for audit/recovery.
