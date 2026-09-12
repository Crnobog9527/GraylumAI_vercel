/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- Metadata only. Every version is explicit; no latest inference or model call.
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
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'sourceVersionId',item.version_id,'version',item.version,'title',item.title,'account',item.account,'pairId',item.pair_id,'skillTitle',item.label));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_sources(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_sources(uuid) TO service_role;
COMMIT;
