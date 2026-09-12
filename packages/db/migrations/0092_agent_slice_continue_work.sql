/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- One transaction composes the existing independent-work and fixed-link rules.
CREATE OR REPLACE FUNCTION public.agent_slice_continue_work(p_actor_id uuid,p_request_id uuid,p_project_id uuid,p_source_version_id uuid,p_pair_id text,p_purpose text,p_title text,p_from_round_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source artifact_projects%ROWTYPE; v artifact_versions%ROWTYPE; root artifact_projects%ROWTYPE; position artifact_versions%ROWTYPE;
 cfg agent_slice_pairs%ROWTYPE; ref artifact_work_references%ROWTYPE; configs text[]; selected_workflow text; payload jsonb; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=p_pair_id AND enabled FOR SHARE;
 SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id AND actor_id=p_actor_id;
 IF cfg.id IS NULL OR source.id IS NULL OR p_purpose IS NULL OR p_purpose NOT IN ('script','title') OR NOT artifact_evidence_allowed(source.id,v.evidence_ids) THEN RAISE EXCEPTION 'slice source denied' USING ERRCODE='42501'; END IF;
 IF source.work_kind='legacy' THEN
  IF p_purpose<>'script' OR p_from_round_id IS NOT NULL THEN RAISE EXCEPTION 'slice transition invalid'; END IF;
  position:=v;
 ELSE
  IF p_purpose='script' AND p_from_round_id IS NULL THEN RAISE EXCEPTION 'script revision required'; END IF;
  IF p_purpose='title' AND p_from_round_id IS NOT NULL THEN RAISE EXCEPTION 'new title work required'; END IF;
  SELECT * INTO ref FROM artifact_work_references WHERE round_id=CASE WHEN p_purpose='script' THEN p_from_round_id ELSE v.round_id END;
  IF ref.round_id IS NULL OR (p_purpose='script' AND ref.project_id<>p_project_id) THEN RAISE EXCEPTION 'slice target denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO position FROM artifact_versions WHERE id=ref.source_version_id;
 END IF;
 SELECT * INTO root FROM artifact_projects WHERE id=position.project_id AND actor_id=p_actor_id AND work_kind='legacy';
 IF root.id IS NULL OR (source.work_kind='script' AND source.source_project_id IS DISTINCT FROM root.id) THEN RAISE EXCEPTION 'slice account denied' USING ERRCODE='42501'; END IF;
 selected_workflow:=CASE WHEN p_purpose='script' THEN cfg.script_workflow ELSE cfg.title_workflow END;
 SELECT array_agg(c.id ORDER BY c.id) INTO configs FROM artifact_reference_configs c JOIN artifact_workflows w ON w.id=c.source_workflow AND w.enabled
 JOIN artifact_rounds r ON r.id=position.round_id AND r.state='published' AND r.workflow->>'id'=w.workflow->>'id'
 WHERE c.enabled AND c.target_workflow=selected_workflow AND w.module_id=root.module_id AND w.skill_id=root.skill_id;
 IF coalesce(cardinality(configs),0)<>1 THEN RAISE EXCEPTION 'one reference configuration required'; END IF;
 payload:=jsonb_build_object('sourceVersionId',position.id,'configId',configs[1],'title',p_title,
  'slicePair',cfg.id,'sliceSourceVersion',v.id,'slicePurpose',p_purpose);
 IF p_from_round_id IS NOT NULL THEN payload:=payload||jsonb_build_object('fromRoundId',p_from_round_id); END IF;
 result:=artifact_create_work(p_actor_id,p_project_id,p_request_id,p_request_id,payload);
 IF source.work_kind='script' THEN PERFORM agent_slice_link(p_actor_id,p_project_id,p_request_id,v.id,cfg.id,p_request_id); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_continue_work(uuid,uuid,uuid,uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_continue_work(uuid,uuid,uuid,uuid,text,text,text,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.agent_slice_targets(p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item record; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 FOR item IN SELECT p.id project_id,p.module_id,p.skill_id,p.work_title,r.id round_id,r.revision_id,r.workflow,r.steps,r.state,sv.version source_version,coalesce(sp.work_title,'定位报告') source_title,(SELECT version FROM artifact_versions WHERE round_id=r.id) version,c.id pair_id,source.account,
  CASE WHEN w.id=c.script_workflow THEN 'script' ELSE 'title' END purpose
  FROM artifact_projects p JOIN artifact_rounds r ON r.project_id=p.id AND r.state IN ('draft','published')
  JOIN artifact_projects source ON source.id=p.source_project_id AND source.actor_id=p_actor_id
  JOIN artifact_workflows w ON w.module_id=p.module_id AND w.skill_id=p.skill_id AND w.workflow->>'id'=r.workflow->>'id' AND w.enabled
  JOIN agent_slice_pairs c ON (c.script_workflow=w.id OR c.title_workflow=w.id) AND c.enabled
  LEFT JOIN agent_slice_links l ON l.round_id=r.id
  LEFT JOIN artifact_work_references wr ON wr.round_id=r.id
  LEFT JOIN artifact_versions sv ON sv.id=coalesce(l.source_version_id,wr.source_version_id)
  LEFT JOIN artifact_projects sp ON sp.id=sv.project_id AND sp.actor_id=p_actor_id
  WHERE p.actor_id=p_actor_id AND p.work_kind='script' ORDER BY p.created_at DESC,p.id,c.id LIMIT 100
 LOOP
  BEGIN PERFORM read_skill_package(p_actor_id,item.module_id,item.skill_id,item.revision_id,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'roundId',item.round_id,'pairId',item.pair_id,'purpose',item.purpose,'state',item.state,'version',item.version,'sourceVersion',item.source_version,'sourceTitle',item.source_title,
   'title',coalesce(item.work_title,item.workflow->'report'->>'title','作品'),'account',item.account,
   'steps',(SELECT jsonb_agg(jsonb_build_object('id',s->>'id','title',s->>'title') ORDER BY n) FROM jsonb_array_elements(item.workflow->'steps') WITH ORDINALITY t(s,n))));
 END LOOP;
 RETURN result;
END $$;
COMMIT;
