-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- New material inherits only the draft's own business source. Existing frozen
-- material and its hash remain immutable; no stored row is rewritten.
BEGIN;

CREATE OR REPLACE FUNCTION opc_business_context(p_actor_id uuid,p_session_id uuid,p_round_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE b opc_businesses;
BEGIN
 SELECT business.* INTO b FROM opc_drafts d
 JOIN opc_draft_businesses binding ON binding.draft_id=d.draft_id
 JOIN opc_businesses business ON business.id=binding.business_id AND business.actor_id=d.actor_id
 JOIN artifact_rounds r ON r.id=p_round_id AND r.project_id=d.project_id
 WHERE d.session_id=p_session_id AND d.actor_id=p_actor_id;
 IF b.id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('version','opc-business-context.v1','businessId',b.id,
  'name',CASE WHEN b.name='未命名业务' THEN NULL ELSE b.name END,
  -- Account-bound revisions already inherit their own immutable source through
  -- 0134's steps/provenance. A shared business profile must not override it.
  'source',CASE WHEN b.current_source_version_id IS NULL OR EXISTS(
   SELECT 1 FROM opc_drafts d JOIN opc_account_strategy_drafts a ON a.draft_id=d.draft_id AND a.actor_id=p_actor_id
   WHERE d.session_id=p_session_id AND d.actor_id=p_actor_id) THEN NULL ELSE
   jsonb_build_object('versionId',b.current_source_version_id,'profile',
    CASE WHEN EXISTS(SELECT 1 FROM artifact_versions v JOIN opc_drafts source_d ON source_d.project_id=v.project_id AND source_d.actor_id=p_actor_id
      JOIN opc_draft_businesses source_binding ON source_binding.draft_id=source_d.draft_id AND source_binding.business_id=b.id
      WHERE v.id=b.current_source_version_id AND NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts a WHERE a.draft_id=source_d.draft_id)) AND opc_source_allowed(p_actor_id,b.current_source_version_id)
     THEN opc_profile(b.current_source_version_id) ELSE NULL END) END);
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

-- Retain the existing outer validator's content/storyboard/tool checks. Only
-- extend its original material identity validator for this one typed context.
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
REVOKE ALL ON FUNCTION opc_business_context(uuid,uuid,uuid),runtime_work_projection(uuid,uuid,uuid),runtime_material_allowed_before_b1(uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
