-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DRAFT ONLY: prepared against staging 4d805783. Do not apply automatically.
-- First remove B1 callers and verify ordinary/old-request/page recovery.
-- Before external use re-read all four live definitions and reconcile later PRs.
-- This preserves all user information, metadata, notes and immutable history.
BEGIN;
CREATE OR REPLACE FUNCTION opc_information(p_actor_id uuid,p_draft_id uuid,p_step_id text,p_request_id uuid,p_expected_version integer,p_values jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;step jsonb;field jsonb;value jsonb;st jsonb;req artifact_requests;payload jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND draft_id=p_draft_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 PERFORM read_skill_package(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),r.revision_id,r.package_hash,NULL);
 payload:=jsonb_build_object('stepId',p_step_id,'expectedVersion',p_expected_version,'values',p_values);
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN IF req.action<>'opc_information' OR req.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN req.response;END IF;
 SELECT x INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 st:=r.steps->p_step_id;
 IF r.state<>'draft' OR step IS NULL OR p_request_id IS NULL OR (st->>'version')::int IS DISTINCT FROM p_expected_version OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>12000 THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
 FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
  value:=p_values->(field->>'id');
  IF value IS NULL OR value-ARRAY['status','value','nature']<>'{}' OR coalesce(value->>'status','') NOT IN ('unknown','unclear','provisional','confirmed','deferred') OR coalesce(value->>'nature','') NOT IN ('fact','decision','hypothesis','unknown') OR char_length(coalesce(value->>'value',''))>400 OR (value->>'status' IN ('confirmed','deferred') AND char_length(btrim(coalesce(value->>'value','')))=0) THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p_values))<>jsonb_array_length(step->'information') THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 st:=st||jsonb_build_object('information',p_values,'informationUpdatedAt',clock_timestamp(),'version',p_expected_version+1);
 UPDATE artifact_rounds SET steps=artifact_invalidate(r.workflow,jsonb_set(r.steps,ARRAY[p_step_id],st),p_step_id) WHERE id=r.id;
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_information',payload,jsonb_build_object('version',p_expected_version+1));RETURN jsonb_build_object('version',p_expected_version+1);
END $$;
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;information jsonb;binding opc_account_strategy_drafts;source_r artifact_rounds;source_information jsonb;
BEGIN
 result:=opc_query_before_entry_projection(p_actor_id,p_draft_id);
 IF p_draft_id IS NOT NULL THEN
  -- The predecessor already verifies actor ownership and source access. Only
  -- successful immutable writes of this same project/round/step can prove a
  -- field was confirmed; a revision may also inherit confirmed fields from its
  -- exact published predecessor. Reach alone includes deferred questions.
  SELECT jsonb_object_agg(info.key,info.value || jsonb_build_object('previouslyConfirmed',coalesce((
   SELECT jsonb_agg(field->>'id' ORDER BY ord)
   FROM jsonb_array_elements(info.value->'schema') WITH ORDINALITY fields(field,ord)
   WHERE EXISTS(SELECT 1 FROM artifact_requests a
    WHERE a.project_id=(result->>'projectId')::uuid AND a.round_id=(result->>'roundId')::uuid
     AND a.action='opc_information' AND a.payload->>'stepId'=info.key
     AND a.payload->'values'->(field->>'id')->>'status'='confirmed')
    OR EXISTS(SELECT 1 FROM artifact_requests revision
     JOIN artifact_rounds prior ON prior.id=(revision.payload->>'fromRoundId')::uuid
      AND prior.project_id=revision.project_id AND prior.state='published'
     WHERE revision.project_id=(result->>'projectId')::uuid AND revision.round_id=(result->>'roundId')::uuid
      AND revision.request_id=revision.round_id AND revision.action='opc_revision'
      AND prior.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')
  ),'[]'::jsonb))) INTO information FROM jsonb_each(result->'information') info;
  SELECT * INTO binding FROM opc_account_strategy_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  IF binding.draft_id IS NOT NULL THEN
   SELECT r.* INTO source_r FROM artifact_versions v JOIN artifact_rounds r ON r.id=v.round_id WHERE v.id=binding.base_source_version_id;
   SELECT jsonb_object_agg(step->>'id',jsonb_build_object('title',step->>'title','schema',step->'information','values',source_r.steps->(step->>'id')->'information'))
    INTO source_information FROM jsonb_array_elements(source_r.workflow->'steps') step;
   result:=result||jsonb_build_object('accountRevision',jsonb_build_object('accountProjectId',binding.account_project_id,
    'sourceVersionId',binding.base_source_version_id,'officialVersion',jsonb_array_length(opc_account_strategy_history(p_actor_id,binding.account_project_id)),
    'methodConflict',source_r.workflow IS DISTINCT FROM (SELECT workflow FROM artifact_rounds WHERE id=(result->>'roundId')::uuid) OR source_r.revision_id IS DISTINCT FROM (SELECT revision_id FROM artifact_rounds WHERE id=(result->>'roundId')::uuid),
    'sourceInformation',source_information));
   IF NOT (result->'accountRevision'->>'methodConflict')::boolean THEN
    SELECT jsonb_object_agg(info.key,info.value||jsonb_build_object(
     'reached',(SELECT jsonb_agg(field->>'id') FROM jsonb_array_elements(info.value->'schema') field),
     'previouslyConfirmed',(SELECT coalesce(jsonb_agg(field->>'id'),'[]') FROM jsonb_array_elements(info.value->'schema') field
      WHERE info.value->'previouslyConfirmed' ? (field->>'id') OR source_r.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')))
     INTO information FROM jsonb_each(information) info;
   END IF;
  END IF;
  RETURN jsonb_set(result,'{information}',coalesce(information,'{}'::jsonb));
 END IF;
 result:=jsonb_set(result,'{drafts}',coalesce((SELECT jsonb_agg(entry || jsonb_build_object(
   'businessId',b.id,'businessName',b.name,'createdAt',p.created_at,'currentVersion',p.current_version,'state',r.state) ORDER BY p.created_at DESC,p.id)
  FROM jsonb_array_elements(result->'drafts') entry
  JOIN opc_drafts d ON d.draft_id=(entry->>'draftId')::uuid AND d.actor_id=p_actor_id
  JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
  JOIN opc_businesses b ON b.id=db.business_id AND b.actor_id=p_actor_id
  JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=p_actor_id
  JOIN artifact_rounds r ON r.id=d.round_id),'[]'::jsonb));
 result:=jsonb_set(result,'{accounts}',coalesce((SELECT jsonb_agg(jsonb_set(account,'{items}',coalesce((
  SELECT jsonb_agg(item || jsonb_build_object('moduleId',p.module_id,'methodRevisionId',r.revision_id))
  FROM jsonb_array_elements(account->'items') item
  JOIN artifact_projects p ON p.id=(item->>'workItemId')::uuid AND p.actor_id=p_actor_id
  JOIN opc_items i ON i.work_item_id=p.id
  JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id
 ),'[]'::jsonb))) FROM jsonb_array_elements(result->'accounts') account),'[]'::jsonb));
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION runtime_work_projection(p_actor_id uuid,p_session_id uuid,p_round_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;context jsonb;
BEGIN
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND session_id=p_session_id AND project_id=(SELECT project_id FROM artifact_rounds WHERE id=p_round_id);
 IF NOT FOUND THEN RETURN runtime_work_projection_before_opc(p_actor_id,p_session_id,p_round_id);END IF;
 IF NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id;
 context:=opc_business_context(p_actor_id,p_session_id,p_round_id);
 RETURN jsonb_build_object('projectId',d.project_id,'roundId',r.id,'revisionId',r.revision_id,'packageHash',r.package_hash,'steps',r.steps,'source',NULL)
  ||CASE WHEN context IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessContext',context) END;
END $$;
CREATE OR REPLACE FUNCTION runtime_material_allowed_before_b1(p_actor_id uuid,p_material jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m runtime_scope_material;current_work jsonb;frozen_work jsonb;st jsonb;context jsonb;binding uuid;source_id uuid;
BEGIN
 IF p_material IS NULL OR p_material='null'::jsonb THEN RETURN;END IF;
 SELECT v.* INTO m FROM runtime_scope_material v JOIN runtime_sessions s ON s.id=v.session_id
 WHERE s.actor_id=p_actor_id AND v.session_id=(p_material->>'sessionId')::uuid AND v.revision=(p_material->>'revision')::bigint FOR SHARE OF v;
 IF m.session_id IS NULL OR m.revoked OR m.content_hash IS DISTINCT FROM p_material->>'hash' OR m.content IS DISTINCT FROM p_material->'content'
 THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 current_work:=coalesce(runtime_work_projection(p_actor_id,m.session_id,(m.content->>'roundId')::uuid),'null'::jsonb);
 frozen_work:=m.content->'work';
 -- The current projection is server-authored. A business addition must not
 -- invalidate a pre-0139 frozen request that did not inherit that source.
 IF current_work ? 'businessContext' THEN
  IF current_work->'businessContext' IS DISTINCT FROM opc_business_context(p_actor_id,m.session_id,(m.content->>'roundId')::uuid)
  THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  current_work:=current_work-'businessContext';
 END IF;
 IF frozen_work ? 'businessContext' THEN
  context:=frozen_work->'businessContext';
  IF jsonb_typeof(context) IS DISTINCT FROM 'object' OR context->>'version' IS DISTINCT FROM 'opc-business-context.v1'
   OR context-ARRAY['version','businessId','name','source']<>'{}'::jsonb
   OR NOT (context ?& ARRAY['version','businessId','name','source'])
   OR (context->'name'<>'null'::jsonb AND (jsonb_typeof(context->'name') IS DISTINCT FROM 'string' OR char_length(context->>'name') NOT BETWEEN 1 AND 120))
  THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  SELECT business.id INTO binding FROM opc_drafts d
   JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
   JOIN opc_businesses business ON business.id=db.business_id AND business.actor_id=p_actor_id
   JOIN artifact_rounds r ON r.id=(m.content->>'roundId')::uuid AND r.project_id=d.project_id
   WHERE d.actor_id=p_actor_id AND d.session_id=m.session_id AND business.id::text=context->>'businessId';
  IF binding IS NULL THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  IF context->'source'<>'null'::jsonb THEN
   IF EXISTS(SELECT 1 FROM opc_drafts d JOIN opc_account_strategy_drafts a ON a.draft_id=d.draft_id AND a.actor_id=p_actor_id
    WHERE d.session_id=m.session_id AND d.actor_id=p_actor_id) THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
   IF jsonb_typeof(context->'source') IS DISTINCT FROM 'object'
    OR (context->'source')-ARRAY['versionId','profile']<>'{}'::jsonb
    OR NOT (context->'source' ?& ARRAY['versionId','profile'])
   THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
   -- A later publication or rename must not rewrite the frozen source. Its
   -- original version must still belong to this business and remain allowed.
   SELECT v.id INTO source_id FROM artifact_versions v
    JOIN opc_drafts source_d ON source_d.project_id=v.project_id AND source_d.actor_id=p_actor_id
    JOIN bill2_drafts source_draft ON source_draft.id=source_d.draft_id AND source_draft.actor_id=p_actor_id
    JOIN artifact_projects source_project ON source_project.id=v.project_id AND source_project.actor_id=p_actor_id
    JOIN opc_draft_businesses db ON db.draft_id=source_d.draft_id AND db.business_id=binding
    WHERE v.id::text=context->'source'->>'versionId'
     AND NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts a WHERE a.draft_id=source_d.draft_id) FOR SHARE OF source_draft,source_project;
   PERFORM module.id FROM artifact_versions v JOIN artifact_projects p ON p.id=v.project_id
    JOIN artifact_rounds r ON r.id=v.round_id JOIN modules module ON module.id=p.module_id
    JOIN skills skill ON skill.id=p.skill_id JOIN skill_revisions revision ON revision.id=r.revision_id AND revision.skill_id=skill.id
    WHERE v.id=source_id FOR SHARE OF module,skill,revision;
   IF source_id IS NULL OR NOT opc_source_allowed(p_actor_id,source_id)
    OR context->'source'->'profile' IS DISTINCT FROM opc_profile(source_id)
   THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  END IF;
  frozen_work:=frozen_work-'businessContext';
 END IF;
 -- Only steps may have ordinary mutable edits. Every other pre-existing
 -- package/source/round identity field retains the original exact comparison.
 IF (CASE WHEN jsonb_typeof(frozen_work)='object' THEN frozen_work-'steps' ELSE frozen_work END)
  IS DISTINCT FROM (CASE WHEN jsonb_typeof(current_work)='object' THEN current_work-'steps' ELSE current_work END)
 THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 FOR st IN SELECT value FROM jsonb_each(coalesce(m.content->'work'->'steps','{}')) LOOP
  IF NOT artifact_evidence_allowed((m.content->'work'->>'projectId')::uuid,coalesce(st->'evidenceIds','[]')||coalesce(st->'provenanceIds','[]'))
  THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 END LOOP;
END $$;
DROP FUNCTION IF EXISTS opc_capture_apply(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer);
COMMIT;
