/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
CREATE OR REPLACE FUNCTION public.artifact_reference_choices(p_actor_id uuid,p_source_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source artifact_projects%ROWTYPE; v artifact_versions%ROWTYPE; cfg artifact_reference_configs%ROWTYPE; w artifact_workflows%ROWTYPE; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id AND actor_id=p_actor_id AND work_kind='legacy';
 IF NOT FOUND THEN RAISE EXCEPTION 'source denied' USING ERRCODE='42501'; END IF;
 IF NOT artifact_evidence_allowed(source.id,v.evidence_ids) THEN RAISE EXCEPTION 'source unavailable'; END IF;
 FOR cfg IN SELECT c.* FROM artifact_reference_configs c JOIN artifact_workflows sw ON sw.id=c.source_workflow
  WHERE c.enabled AND sw.module_id=source.module_id AND sw.skill_id=source.skill_id ORDER BY c.id LOOP
  SELECT * INTO w FROM artifact_workflows WHERE id=cfg.target_workflow AND enabled AND workflow->>'kind'='document';
  IF FOUND THEN
   BEGIN
    PERFORM read_skill_package(p_actor_id,w.module_id,w.skill_id,w.revision_id,NULL,NULL);
    result:=result||jsonb_build_array(jsonb_build_object('id',cfg.id,'label',w.label));
   EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
   WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF;
   END;
  END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.artifact_reference_choices(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_reference_choices(uuid,uuid) TO service_role;
COMMIT;
