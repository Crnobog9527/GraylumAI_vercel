/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Preview the Skill declaration used for the next account revision without
-- creating a draft. A pending revision continues on its pinned declaration.
BEGIN;

CREATE OR REPLACE FUNCTION opc_account_strategy_schema(p_actor_id uuid,p_account_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;binding opc_account_strategy_drafts;d opc_drafts;r artifact_rounds;
 source_v artifact_versions;source_d opc_drafts;source_workflow artifact_workflows;current_workflow artifact_workflows;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=a.project_id AND current;
 IF binding.draft_id IS NOT NULL THEN
  SELECT * INTO d FROM opc_drafts WHERE draft_id=binding.draft_id AND actor_id=p_actor_id;
  SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
  IF r.state='draft' THEN
   RETURN jsonb_build_object('registrationId',d.registration,'workflow',r.workflow);
  END IF;
  IF r.state<>'published' THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 END IF;
 SELECT * INTO source_v FROM artifact_versions WHERE id=a.source_version_id;
 SELECT * INTO source_d FROM opc_drafts WHERE project_id=source_v.project_id AND actor_id=p_actor_id;
 IF source_d.draft_id IS NULL OR a.business_id IS NULL THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 SELECT * INTO source_workflow FROM artifact_workflows WHERE id=source_d.registration;
 IF source_workflow.id IS NULL OR (SELECT count(*) FROM artifact_workflows
  WHERE module_id=source_workflow.module_id AND skill_id=source_workflow.skill_id
   AND enabled AND workflow->>'kind'=source_workflow.workflow->>'kind')<>1 THEN RAISE EXCEPTION 'OPC_REGISTRATION';END IF;
 SELECT * INTO current_workflow FROM artifact_workflows
  WHERE module_id=source_workflow.module_id AND skill_id=source_workflow.skill_id
   AND enabled AND workflow->>'kind'=source_workflow.workflow->>'kind';
 RETURN jsonb_build_object('registrationId',current_workflow.id,'workflow',current_workflow.workflow);
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_schema(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_strategy_schema(uuid,uuid) TO service_role;

-- Lock in the same request-then-account order as the existing save RPC. The
-- declaration shown in the editor must still be current when it is saved.
CREATE OR REPLACE FUNCTION opc_account_strategy_save_checked(
 p_actor_id uuid,p_account_project_id uuid,p_request_id uuid,p_expected_source_version_id uuid,
 p_expected_pending_draft_id uuid,p_expected_registration_id text,p_edits jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE schema_now jsonb;result jsonb;saved_registration text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,125));
 -- A replay must be checked against the original payload by the existing RPC,
 -- even when a newer Skill was published after the original save.
 IF EXISTS(SELECT 1 FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN
  result:=opc_account_strategy_save(p_actor_id,p_account_project_id,p_request_id,
   p_expected_source_version_id,p_expected_pending_draft_id,p_edits);
  SELECT registration INTO saved_registration FROM opc_drafts
   WHERE draft_id=(result->>'draftId')::uuid AND actor_id=p_actor_id;
  IF p_expected_registration_id IS NOT NULL AND saved_registration IS DISTINCT FROM p_expected_registration_id THEN
   RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';
  END IF;
  RETURN result;
 END IF;
 IF p_expected_registration_id IS NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_account_project_id::text,125));
 schema_now:=opc_account_strategy_schema(p_actor_id,p_account_project_id);
 IF schema_now->>'registrationId' IS DISTINCT FROM p_expected_registration_id THEN
  RAISE EXCEPTION 'OPC_VERSION_CONFLICT';
 END IF;
 result:=opc_account_strategy_save(p_actor_id,p_account_project_id,p_request_id,
  p_expected_source_version_id,p_expected_pending_draft_id,p_edits);
 -- Publication does not lock this account. If it committed between the
 -- preview check and the inner begin, roll the entire save back atomically.
 SELECT registration INTO saved_registration FROM opc_drafts
  WHERE draft_id=(result->>'draftId')::uuid AND actor_id=p_actor_id;
 IF saved_registration IS DISTINCT FROM p_expected_registration_id THEN
  RAISE EXCEPTION 'OPC_VERSION_CONFLICT';
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_save_checked(uuid,uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_strategy_save_checked(uuid,uuid,uuid,uuid,uuid,text,jsonb) TO service_role;

COMMIT;
