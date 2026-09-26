/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Preview the Skill declaration used for the next account revision without
-- creating a draft. A pending revision continues on its pinned declaration.
BEGIN;

-- Keep the editor's optimistic baseline beside the existing immutable request.
-- This is request metadata, not a second strategy or version store.
CREATE TABLE IF NOT EXISTS opc_account_strategy_request_bases (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,registration_id text NOT NULL,
 step_versions jsonb,
 PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES opc_library_requests(actor_id,request_id)
);
ALTER TABLE opc_account_strategy_request_bases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_account_strategy_request_bases FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_account_strategy_request_bases;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_account_strategy_request_bases
 FOR EACH ROW EXECUTE FUNCTION artifact_immutable();

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
 p_expected_pending_draft_id uuid,p_expected_registration_id text,p_edits jsonb,p_expected_step_versions jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE schema_now jsonb;result jsonb;saved_registration text;basis opc_account_strategy_request_bases;
 pending opc_drafts;round_now artifact_rounds;step_edit record;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,125));
 -- A replay must be checked against the original payload by the existing RPC,
 -- even when a newer Skill was published after the original save.
 IF EXISTS(SELECT 1 FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN
  result:=opc_account_strategy_save(p_actor_id,p_account_project_id,p_request_id,
   p_expected_source_version_id,p_expected_pending_draft_id,p_edits);
  SELECT * INTO basis FROM opc_account_strategy_request_bases
   WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF basis.request_id IS NULL AND p_expected_step_versions IS NOT NULL THEN
   RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';
  END IF;
  IF basis.request_id IS NOT NULL AND
   (basis.registration_id IS DISTINCT FROM p_expected_registration_id OR
    basis.step_versions IS DISTINCT FROM p_expected_step_versions) THEN
   RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';
  END IF;
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
 IF p_expected_pending_draft_id IS NOT NULL THEN
  SELECT * INTO pending FROM opc_drafts WHERE draft_id=p_expected_pending_draft_id AND actor_id=p_actor_id;
  IF pending.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  -- Positioning-page edits lock this project too. Check the exact versions the
  -- library dialog displayed while holding that same lock until save commits.
  PERFORM 1 FROM artifact_projects WHERE id=pending.project_id FOR UPDATE;
  SELECT * INTO round_now FROM artifact_rounds WHERE id=pending.round_id;
  IF round_now.state<>'draft' OR jsonb_typeof(p_expected_step_versions) IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  FOR step_edit IN SELECT x.key FROM jsonb_each(p_edits) x LOOP
   IF jsonb_typeof(p_expected_step_versions->step_edit.key) IS DISTINCT FROM 'number' OR
    (round_now.steps->step_edit.key->>'version')::integer IS DISTINCT FROM
     (p_expected_step_versions->>step_edit.key)::integer THEN
    RAISE EXCEPTION 'OPC_VERSION_CONFLICT';
   END IF;
  END LOOP;
 ELSIF p_expected_step_versions IS NOT NULL THEN
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
 INSERT INTO opc_account_strategy_request_bases(actor_id,request_id,registration_id,step_versions)
 VALUES(p_actor_id,p_request_id,p_expected_registration_id,p_expected_step_versions);
 RETURN result;
END $$;
-- Reapplying this migration to an existing local preview must retire its old
-- seven-argument entry point; clients use the checked eight-argument path.
DROP FUNCTION IF EXISTS opc_account_strategy_save_checked(uuid,uuid,uuid,uuid,uuid,text,jsonb);
REVOKE ALL ON FUNCTION opc_account_strategy_save_checked(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_strategy_save_checked(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION opc_account_strategy_save(uuid,uuid,uuid,uuid,uuid,jsonb) FROM service_role;

COMMIT;
