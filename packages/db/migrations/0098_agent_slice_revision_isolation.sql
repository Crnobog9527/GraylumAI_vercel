/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- A bounded projection of existing input/candidate facts, not another body store.
CREATE OR REPLACE FUNCTION public.agent_slice_conversation(p_actor_id uuid,p_conversation_id uuid,p_before_time timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e agent_slice_executions%ROWTYPE; reply jsonb; summary jsonb; rows jsonb:='[]'; next_cursor jsonb:=NULL; n integer:=0; permitted boolean; input_body text; step_title text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') OR
 NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR (p_before_time IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'slice cursor invalid'; END IF;
 FOR e IN SELECT * FROM agent_slice_executions WHERE conversation_id=p_conversation_id
  AND (p_before_time IS NULL OR (created_at,request_id)<(p_before_time,p_before_id))
  ORDER BY created_at DESC,request_id DESC LIMIT p_limit+1
 LOOP
  n:=n+1;
  IF n>p_limit THEN EXIT; END IF;
  permitted:=EXISTS(SELECT 1 FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id);
  reply:=jsonb_build_object('state','restricted'); summary:=reply; input_body:=NULL;
  IF permitted THEN
   BEGIN
    reply:=agent_slice_result(p_actor_id,e.request_id,'reply','read');
    summary:=agent_slice_result(p_actor_id,e.request_id,'summary','read');
   EXCEPTION WHEN insufficient_privilege THEN
    reply:=jsonb_build_object('state','restricted'); summary:=reply;
   WHEN raise_exception THEN
    IF SQLERRM<>'Skill unavailable' THEN RAISE; END IF;
    reply:=jsonb_build_object('state','restricted'); summary:=reply;
   END;
  END IF;
  IF reply->>'state'<>'restricted' AND summary->>'state'<>'restricted' THEN
   SELECT payload->>'body' INTO input_body FROM artifact_requests WHERE project_id=e.project_id AND request_id=e.request_id AND action='slice_input';
   IF input_body IS NULL THEN RAISE EXCEPTION 'slice input unavailable'; END IF;
  ELSE reply:=jsonb_build_object('state','restricted'); summary:=reply; END IF;
  SELECT s->>'title' INTO step_title FROM artifact_rounds r CROSS JOIN LATERAL jsonb_array_elements(r.workflow->'steps') s WHERE r.id=e.round_id AND s->>'id'=e.step_id;
  rows:=rows||jsonb_build_array(jsonb_build_object('executionId',e.request_id,'createdAt',e.created_at,'projectId',e.project_id,'roundId',e.round_id,'stepId',e.step_id,'pairId',e.pair_id,'stepTitle',coalesce(step_title,'创作'),'input',input_body,'reply',reply,'summary',summary));
  next_cursor:=jsonb_build_object('createdAt',e.created_at,'executionId',e.request_id);
 END LOOP;
 RETURN jsonb_build_object('items',rows,'nextCursor',CASE WHEN n>p_limit THEN next_cursor ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_conversation(uuid,uuid,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_conversation(uuid,uuid,timestamptz,uuid,integer) TO service_role;
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
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
  WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'roundId',item.round_id,'pairId',item.pair_id,'purpose',item.purpose,'state',item.state,'version',item.version,'sourceVersion',item.source_version,'sourceTitle',item.source_title,
   'title',coalesce(item.work_title,item.workflow->'report'->>'title','作品'),'account',item.account,
   'steps',(SELECT jsonb_agg(jsonb_build_object('id',s->>'id','title',s->>'title') ORDER BY n) FROM jsonb_array_elements(item.workflow->'steps') WITH ORDINALITY t(s,n))));
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.agent_slice_sources(p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item record; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 FOR item IN
 SELECT p.id project_id,p.account,p.module_id,p.skill_id,r.revision_id,v.id version_id,v.version,v.evidence_ids,
  coalesce(p.work_title,r.workflow->'report'->>'title','定位报告') title,pair.id pair_id,tw.label,
  tw.module_id target_module,tw.skill_id target_skill,tw.revision_id target_revision
 FROM artifact_projects p JOIN artifact_rounds r ON r.project_id=p.id AND r.state='published'
 JOIN artifact_versions v ON v.round_id=r.id
 JOIN artifact_workflows sw ON sw.module_id=p.module_id AND sw.skill_id=p.skill_id AND sw.enabled AND sw.workflow->>'id'=r.workflow->>'id'
 JOIN artifact_reference_configs cfg ON cfg.source_workflow=sw.id AND cfg.enabled
 JOIN agent_slice_pairs pair ON pair.script_workflow=cfg.target_workflow AND pair.enabled
 JOIN artifact_workflows tw ON tw.id=pair.script_workflow AND tw.enabled
 WHERE p.actor_id=p_actor_id AND p.work_kind='legacy'
 AND EXISTS(SELECT 1 FROM artifact_accounts ac WHERE ac.actor_id=p_actor_id AND ac.module_id=p.module_id AND ac.skill_id=p.skill_id AND ac.account=p.account)
 AND (SELECT count(*) FROM artifact_reference_configs c JOIN artifact_workflows w ON w.id=c.source_workflow AND w.enabled
      WHERE c.enabled AND c.target_workflow=pair.script_workflow AND w.module_id=p.module_id AND w.skill_id=p.skill_id AND w.workflow->>'id'=r.workflow->>'id')=1
 ORDER BY p.created_at DESC,p.id,v.version DESC,pair.id LIMIT 100
 LOOP
  IF NOT artifact_evidence_allowed(item.project_id,item.evidence_ids) THEN CONTINUE; END IF;
  BEGIN
   PERFORM read_skill_package(p_actor_id,item.module_id,item.skill_id,item.revision_id,NULL,NULL);
   PERFORM read_skill_package(p_actor_id,item.target_module,item.target_skill,item.target_revision,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
  WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'sourceVersionId',item.version_id,'version',item.version,'title',item.title,'account',item.account,'pairId',item.pair_id,'skillTitle',item.label));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_sources(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_sources(uuid) TO service_role;
COMMIT;
