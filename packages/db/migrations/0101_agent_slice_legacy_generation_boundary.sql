/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- The legacy executor cannot resolve fixed cross-Skill handoffs. Reject new
-- generation there; keep original dispatched requests' recovery unchanged.
CREATE OR REPLACE FUNCTION public.agent_slice_assert_legacy_generation(p_actor_id uuid,p_project_id uuid,p_round_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM artifact_projects p JOIN artifact_rounds r ON r.project_id=p.id JOIN profiles u ON u.id=p.actor_id
   WHERE p.id=p_project_id AND r.id=p_round_id AND p.actor_id=p_actor_id AND u.status='active' AND u.is_deleted='false')
 THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM agent_slice_links WHERE round_id=p_round_id)
 THEN RAISE EXCEPTION '请在连续创作对话中继续此作品，以保留已选择的来源。'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_assert_legacy_generation(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_assert_legacy_generation(uuid,uuid,uuid) TO service_role;
DO $$ BEGIN
 IF to_regprocedure('public.artifact_generation_before_slice_boundary(uuid,uuid,uuid,text,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.artifact_generation(uuid,uuid,uuid,text,uuid,jsonb) RENAME TO artifact_generation_before_slice_boundary;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.artifact_generation_before_slice_boundary(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.artifact_generation(p_actor_id uuid,p_project_id uuid,p_round_id uuid,p_action text,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF (p_action='prepare' AND NOT EXISTS(SELECT 1 FROM artifact_generations WHERE project_id=p_project_id AND request_id=p_request_id))
 OR (p_action='dispatch' AND EXISTS(SELECT 1 FROM artifact_generations WHERE project_id=p_project_id AND request_id=p_request_id AND state='prepared')) THEN
  PERFORM agent_slice_assert_legacy_generation(p_actor_id,p_project_id,p_round_id);
 END IF;
 RETURN artifact_generation_before_slice_boundary(p_actor_id,p_project_id,p_round_id,p_action,p_request_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.artifact_generation(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_generation(uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
COMMIT;
