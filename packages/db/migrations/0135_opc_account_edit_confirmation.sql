/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Account revisions retain acceptance of unchanged information. Rebuild only
-- validation snapshots, through the original checks, when the user confirms
-- an edit or explicitly publishes. Old request receipts remain immutable.
BEGIN;
CREATE OR REPLACE FUNCTION opc_account_refresh_confirmations(actor uuid,project uuid,round uuid,skip_step text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE binding opc_account_strategy_drafts;r artifact_rounds;source_r artifact_rounds;p artifact_projects;account_row opc_accounts;
 step jsonb;st jsonb;k text;pass integer;canonical text;
BEGIN
 SELECT b.* INTO binding FROM opc_account_strategy_drafts b JOIN opc_drafts d ON d.draft_id=b.draft_id
  WHERE d.project_id=project AND d.round_id=round AND b.actor_id=actor;
 IF binding.draft_id IS NULL THEN RETURN;END IF;
 PERFORM bill2_actor(actor);
 -- Match the established account -> project lock order, including publication.
 SELECT * INTO account_row FROM opc_accounts WHERE project_id=binding.account_project_id AND actor_id=actor FOR UPDATE;
 SELECT b.* INTO binding FROM opc_account_strategy_drafts b WHERE b.draft_id=binding.draft_id FOR UPDATE;
 IF NOT binding.current OR account_row.project_id IS NULL OR account_row.source_version_id IS DISTINCT FROM binding.base_source_version_id OR account_row.revision IS DISTINCT FROM binding.base_account_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=project AND actor_id=actor FOR UPDATE;
 IF p.id IS NULL OR NOT bill2_scope_allowed(actor,jsonb_build_object('kind','positioning_draft','draftId',binding.draft_id))
  OR NOT artifact_evidence_allowed(project,'[]') THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=round AND project_id=project;
 IF r.state<>'draft' THEN RETURN;END IF;
 SELECT src.* INTO source_r FROM artifact_versions v JOIN artifact_rounds src ON src.id=v.round_id WHERE v.id=binding.base_source_version_id;
 FOR pass IN 1..jsonb_array_length(r.workflow->'steps') LOOP
  FOR step IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
   k:=step->>'id';SELECT * INTO r FROM artifact_rounds WHERE id=round AND project_id=project;st:=r.steps->k;
   IF k=skip_step OR coalesce((st->>'valid')::boolean,false) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'dependsOn') dep WHERE NOT coalesce((r.steps->dep->>'valid')::boolean,false)) THEN CONTINUE;END IF;
   -- A confirmation of this exact content version proves no local edit. An
   -- upstream reviewVersion change alone does not revoke the owner's answer.
   IF NOT EXISTS(SELECT 1 FROM artifact_confirmations c WHERE c.round_id=round AND c.step_id=k
    AND c.id=(st->>'confirmationId')::uuid AND c.version=(st->>'version')::int AND c.body=st->>'body'
    AND c.review_version<(st->>'reviewVersion')::int AND artifact_evidence_allowed(project,c.evidence_ids))
    AND NOT coalesce((r.workflow=source_r.workflow AND r.revision_id=source_r.revision_id
     AND st->'information'=source_r.steps->k->'information' AND st->>'body'=source_r.steps->k->>'body'
     AND coalesce((source_r.steps->k->>'valid')::boolean,false)
     AND NOT EXISTS(SELECT 1 FROM artifact_requests h WHERE h.project_id=project AND h.round_id=round AND h.payload->>'stepId'=k AND h.action IN ('save','confirm'))
     AND (st->>'version')::int=1+coalesce((SELECT max((h.response->>'version')::int) FROM artifact_requests h WHERE h.project_id=project AND h.round_id=round AND h.action='opc_information' AND h.payload->>'stepId'=k),0)
     AND EXISTS(SELECT 1 FROM artifact_requests h WHERE h.project_id=project AND h.round_id=round
      AND h.action='opc_account_inherit' AND h.payload->>'sourceVersionId'=binding.base_source_version_id::text
      AND st->'evidenceIds'=jsonb_build_array(h.response->>'evidenceId'))),false) THEN
    -- For a changed step, require the immutable explicit information write and
    -- its immediately following canonical save, never a guessed summary or a
    -- body-only edit. Provisional changed fields cannot become accepted here.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(step->'information') f
     WHERE coalesce(st->'information'->(f->>'id')->>'status','unknown') NOT IN ('confirmed','deferred')
      AND ((f->>'required')::boolean OR r.workflow IS DISTINCT FROM source_r.workflow OR r.revision_id IS DISTINCT FROM source_r.revision_id OR st->'information'->(f->>'id') IS DISTINCT FROM source_r.steps->k->'information'->(f->>'id'))) THEN CONTINUE;END IF;
    SELECT string_agg((f->>'title')||E'\n'||CASE WHEN st->'information'->(f->>'id')->>'status'='deferred' THEN '（暂缓确认）' ELSE '' END||(st->'information'->(f->>'id')->>'value'),E'\n\n' ORDER BY ord)
     INTO canonical FROM jsonb_array_elements(step->'information') WITH ORDINALITY fields(f,ord)
     WHERE coalesce(st->'information'->(f->>'id')->>'value','')<>'';
    IF st->>'body' IS DISTINCT FROM canonical OR NOT EXISTS(SELECT 1 FROM artifact_requests h
     WHERE h.project_id=project AND h.round_id=round AND h.action='opc_information' AND h.payload->>'stepId'=k
      AND h.payload->'values'=st->'information' AND (h.response->>'version')::int=(st->>'version')::int-1)
     OR NOT EXISTS(SELECT 1 FROM artifact_requests h WHERE h.project_id=project AND h.round_id=round AND h.action='save'
      AND h.payload->>'stepId'=k AND h.payload->>'body'=canonical AND (h.response->>'version')::int=(st->>'version')::int
      AND (h.payload->>'expectedVersion')::int=(st->>'version')::int-1) THEN CONTINUE;END IF;
   END IF;
   PERFORM artifact_transition_before_account_strategy(actor,p.module_id,p.skill_id,'confirm',project,round,gen_random_uuid(),
    jsonb_build_object('stepId',k,'expectedVersion',st->'version','expectedReviewVersion',st->'reviewVersion'));
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION opc_account_refresh_confirmations(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE binding opc_account_strategy_drafts;a opc_accounts;b opc_businesses;result jsonb;replay boolean;
BEGIN
 IF p_action='confirm' AND EXISTS(SELECT 1 FROM opc_drafts d JOIN opc_account_strategy_drafts draft_binding ON draft_binding.draft_id=d.draft_id WHERE d.project_id=p_project_id AND d.round_id=p_round_id AND d.actor_id=p_actor_id) THEN
  PERFORM 1 FROM opc_accounts acct JOIN opc_account_strategy_drafts draft_binding ON draft_binding.account_project_id=acct.project_id JOIN opc_drafts d ON d.draft_id=draft_binding.draft_id
   WHERE d.project_id=p_project_id AND d.round_id=p_round_id AND acct.actor_id=p_actor_id FOR UPDATE OF acct;
  PERFORM 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
   PERFORM opc_account_refresh_confirmations(p_actor_id,p_project_id,p_round_id,p_payload->>'stepId');
  END IF;
 END IF;
 IF p_action<>'publish' THEN
  RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 END IF;
 SELECT asd.* INTO binding FROM opc_account_strategy_drafts asd
  JOIN opc_drafts d ON d.draft_id=asd.draft_id
  WHERE d.project_id=p_project_id AND d.round_id=p_round_id AND asd.actor_id=p_actor_id;
 IF binding.draft_id IS NULL THEN
  RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 END IF;
 SELECT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) INTO replay;
 IF replay THEN RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);END IF;
 IF NOT binding.current THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 SELECT * INTO a FROM opc_accounts WHERE project_id=binding.account_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE draft_id=binding.draft_id AND actor_id=p_actor_id FOR UPDATE;
 IF NOT binding.current THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 IF a.project_id IS NULL OR a.source_version_id IS DISTINCT FROM binding.base_source_version_id OR
  a.revision IS DISTINCT FROM binding.base_account_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 SELECT * INTO b FROM opc_businesses WHERE id=a.business_id AND actor_id=p_actor_id FOR UPDATE;
 IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED';END IF;
 PERFORM opc_account_refresh_confirmations(p_actor_id,p_project_id,p_round_id);
 result:=artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 IF result->>'versionId' IS NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 -- The older common-business wrapper selected this version temporarily in
 -- this transaction. Restore its exact prior source and revision.
 UPDATE opc_businesses SET current_source_version_id=b.current_source_version_id,revision=b.revision WHERE id=b.id;
 UPDATE opc_accounts SET source_version_id=(result->>'versionId')::uuid,revision=revision+1 WHERE project_id=a.project_id;
 UPDATE opc_account_strategy_drafts SET base_source_version_id=(result->>'versionId')::uuid,base_account_revision=a.revision+1
  WHERE draft_id=binding.draft_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION artifact_transition_before_account_strategy(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.artifact_publish_current(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
 p_project_id uuid,p_round_id uuid,p_request_id uuid,p_expected_steps jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; actual jsonb; payload jsonb:=jsonb_build_object('expectedSteps',p_expected_steps);
BEGIN
 -- Account edits and publication share account -> project lock order.
 PERFORM 1 FROM opc_accounts acct JOIN opc_account_strategy_drafts draft_binding ON draft_binding.account_project_id=acct.project_id JOIN opc_drafts d ON d.draft_id=draft_binding.draft_id
  WHERE d.project_id=p_project_id AND d.round_id=p_round_id AND acct.actor_id=p_actor_id FOR UPDATE OF acct;
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 snapshot:=artifact_transition(p_actor_id,p_module_id,p_skill_id,'read',p_project_id,p_round_id);
 IF NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
  SELECT jsonb_object_agg(key,jsonb_build_object('version',value->'version','reviewVersion',value->'reviewVersion')) INTO actual FROM jsonb_each(snapshot->'steps');
  IF actual IS DISTINCT FROM p_expected_steps THEN RAISE EXCEPTION 'publication conflict'; END IF;
 END IF;
 RETURN artifact_transition(p_actor_id,p_module_id,p_skill_id,'publish',p_project_id,p_round_id,p_request_id,payload);
END $$;

COMMIT;
