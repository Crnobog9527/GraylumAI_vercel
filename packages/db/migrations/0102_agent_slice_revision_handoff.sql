/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- Revision through the original work API retains the fixed handoff as well as
-- the positioning reference. Explicit SDK transitions may select a new formal
-- handoff; the existing link validator checks its identity and dependencies.
DO $$ BEGIN
 IF to_regprocedure('public.artifact_create_work_before_slice_revision(uuid,uuid,uuid,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.artifact_create_work(uuid,uuid,uuid,uuid,jsonb) RENAME TO artifact_create_work_before_slice_revision;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.artifact_create_work_before_slice_revision(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.artifact_create_work(p_actor_id uuid,p_project_id uuid,p_round_id uuid,p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; previous agent_slice_links%ROWTYPE;
BEGIN
 result:=artifact_create_work_before_slice_revision(p_actor_id,p_project_id,p_round_id,p_request_id,p_payload);
 SELECT l.* INTO previous FROM agent_slice_links l JOIN artifact_rounds r ON r.id=l.round_id
  WHERE l.round_id=(p_payload->>'fromRoundId')::uuid AND r.project_id=p_project_id;
 IF FOUND THEN
  PERFORM agent_slice_link(p_actor_id,p_project_id,p_round_id,
   coalesce((p_payload->>'sliceSourceVersion')::uuid,previous.source_version_id),
   coalesce(p_payload->>'slicePair',previous.pair_id),p_request_id);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.artifact_create_work(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_create_work(uuid,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
