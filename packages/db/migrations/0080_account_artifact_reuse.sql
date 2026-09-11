/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Bounded report-to-work references. No registrations or remote configuration seeded.
BEGIN;
ALTER TABLE public.artifact_projects ADD COLUMN IF NOT EXISTS work_kind text NOT NULL DEFAULT 'legacy' CHECK(work_kind IN ('legacy','script'));
ALTER TABLE public.artifact_projects ADD COLUMN IF NOT EXISTS source_project_id uuid REFERENCES public.artifact_projects(id);
ALTER TABLE public.artifact_projects ADD COLUMN IF NOT EXISTS work_title text;
DROP INDEX IF EXISTS public.artifact_social_account;
CREATE UNIQUE INDEX artifact_social_account ON public.artifact_projects(actor_id,account) WHERE account IS NOT NULL AND work_kind='legacy';
DROP INDEX IF EXISTS public.artifact_document_project;
CREATE UNIQUE INDEX artifact_document_project ON public.artifact_projects(actor_id,skill_id) WHERE account IS NULL AND work_kind='legacy';
CREATE TABLE IF NOT EXISTS public.artifact_reference_configs (
 id text PRIMARY KEY CHECK(id ~ '^[a-z][a-z0-9_-]{0,99}$'),
 source_workflow text NOT NULL REFERENCES public.artifact_workflows(id),
 target_workflow text NOT NULL REFERENCES public.artifact_workflows(id),
 section_ids jsonb NOT NULL CHECK(jsonb_typeof(section_ids)='array' AND jsonb_array_length(section_ids) BETWEEN 1 AND 32),
 max_chars integer NOT NULL CHECK(max_chars BETWEEN 1 AND 20000),
 enabled boolean NOT NULL DEFAULT false,
 CHECK(source_workflow<>target_workflow)
);
CREATE TABLE IF NOT EXISTS public.artifact_work_references (
 round_id uuid PRIMARY KEY REFERENCES public.artifact_rounds(id),
 project_id uuid NOT NULL REFERENCES public.artifact_projects(id),
 evidence_id uuid NOT NULL UNIQUE REFERENCES public.artifact_evidence(id),
 source_version_id uuid NOT NULL REFERENCES public.artifact_versions(id),
 config_id text NOT NULL REFERENCES public.artifact_reference_configs(id),
 section_ids jsonb NOT NULL, source_hash text NOT NULL,
 creation_request_id uuid NOT NULL, creation_payload jsonb NOT NULL
);
ALTER TABLE public.artifact_reference_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artifact_work_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.artifact_reference_configs,public.artifact_work_references FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON public.artifact_work_references;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.artifact_work_references FOR EACH ROW EXECUTE FUNCTION public.artifact_immutable();
DROP TRIGGER IF EXISTS artifact_workflow_immutable ON public.artifact_reference_configs;
CREATE TRIGGER artifact_workflow_immutable BEFORE UPDATE ON public.artifact_reference_configs FOR EACH ROW EXECUTE FUNCTION public.artifact_workflow_immutable();

-- Sources must remain legacy positioning projects. No recursive cross-work graph.
CREATE OR REPLACE FUNCTION public.artifact_reference_available(evidence uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM artifact_work_references ref
 JOIN artifact_reference_configs cfg ON cfg.id=ref.config_id AND cfg.enabled
 JOIN artifact_projects target ON target.id=ref.project_id
 JOIN artifact_versions v ON v.id=ref.source_version_id
 JOIN artifact_projects source ON source.id=v.project_id
 JOIN artifact_rounds r ON r.id=v.round_id
 WHERE ref.evidence_id=evidence AND target.actor_id=source.actor_id
 AND target.source_project_id=source.id AND source.work_kind='legacy' AND r.workflow->>'kind'='social'
 AND v.report_hash=ref.source_hash AND r.state='published'
 AND EXISTS(SELECT 1 FROM artifact_accounts a WHERE a.actor_id=source.actor_id AND a.module_id=source.module_id AND a.skill_id=source.skill_id AND a.account=source.account)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.evidence_ids) x
  LEFT JOIN artifact_evidence e ON e.id::text=x AND e.project_id=source.id
  LEFT JOIN artifact_evidence_restrictions er ON er.evidence_id=e.id
  WHERE e.id IS NULL OR er.deleted OR er.expires_at<=clock_timestamp()));
$$;
CREATE OR REPLACE FUNCTION public.artifact_evidence_allowed(project uuid,ids jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN false ELSE (
 WITH refs AS (SELECT DISTINCT value AS id FROM jsonb_array_elements_text(ids))
 SELECT (SELECT count(*) FROM refs)<=128 AND NOT EXISTS(
 SELECT 1 FROM refs x LEFT JOIN public.artifact_evidence e ON e.id::text=x.id AND e.project_id=project
 LEFT JOIN public.artifact_evidence_restrictions r ON r.evidence_id=e.id
 WHERE e.id IS NULL OR r.deleted OR r.expires_at<=clock_timestamp()
 OR (EXISTS(SELECT 1 FROM public.artifact_work_references wr WHERE wr.evidence_id=e.id) AND NOT public.artifact_reference_available(e.id)))
 ) END
$$;
DO $$ BEGIN
 IF to_regprocedure('public.artifact_transition_before_reuse(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) RENAME TO artifact_transition_before_reuse;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.artifact_transition_before_reuse(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.artifact_create_work(p_actor_id uuid,p_project_id uuid,p_round_id uuid,p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg artifact_reference_configs%ROWTYPE; src artifact_projects%ROWTYPE; dst artifact_projects%ROWTYPE;
 v artifact_versions%ROWTYPE; target artifact_workflows%ROWTYPE; source_flow artifact_workflows%ROWTYPE;
 prior artifact_rounds%ROWTYPE; existing artifact_work_references%ROWTYPE; descriptor jsonb; result jsonb; ev uuid:=gen_random_uuid(); states jsonb; k text; st jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 -- Stable operation identity serializes create/retry before the project exists.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,80));
 SELECT * INTO existing FROM artifact_work_references WHERE round_id=p_round_id;
 IF FOUND THEN
  IF existing.project_id<>p_project_id OR existing.creation_request_id<>p_request_id OR existing.creation_payload IS DISTINCT FROM p_payload
   OR NOT EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'work identity conflict'; END IF;
  RETURN jsonb_build_object('projectId',p_project_id,'roundId',p_round_id);
 END IF;
 IF p_payload->>'title' IS NULL OR char_length(p_payload->>'title') NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'work title required'; END IF;
 SELECT * INTO cfg FROM artifact_reference_configs WHERE id=p_payload->>'configId' AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reference configuration unavailable'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=(p_payload->>'sourceVersionId')::uuid;
 SELECT * INTO src FROM artifact_projects WHERE id=v.project_id AND actor_id=p_actor_id AND work_kind='legacy' FOR SHARE;
 IF NOT FOUND OR src.account IS NULL THEN RAISE EXCEPTION 'source denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM artifact_accounts WHERE actor_id=p_actor_id AND module_id=src.module_id AND skill_id=src.skill_id AND account=src.account FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'source denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO source_flow FROM artifact_workflows WHERE id=cfg.source_workflow;
 IF source_flow.module_id IS DISTINCT FROM src.module_id OR source_flow.skill_id IS DISTINCT FROM src.skill_id
  OR NOT EXISTS(SELECT 1 FROM artifact_rounds WHERE id=v.round_id AND state='published' AND workflow->>'kind'='social' AND workflow->>'id'=source_flow.workflow->>'id')
  OR NOT artifact_evidence_allowed(src.id,v.evidence_ids) THEN RAISE EXCEPTION 'source unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.section_ids) x WHERE jsonb_typeof(x)<>'string')
 OR jsonb_array_length(cfg.section_ids)<>(SELECT count(DISTINCT x) FROM jsonb_array_elements(cfg.section_ids) x)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(cfg.section_ids) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.report->'sections') sec WHERE sec->>'stepId'=x))
 OR (SELECT coalesce(sum(char_length(sec->>'body')),0) FROM jsonb_array_elements(v.report->'sections') sec WHERE cfg.section_ids ? (sec->>'stepId'))>cfg.max_chars THEN RAISE EXCEPTION 'invalid reference sections or capacity'; END IF;
 SELECT * INTO target FROM artifact_workflows WHERE id=cfg.target_workflow AND enabled;
 IF NOT FOUND OR target.workflow->>'kind'<>'document' THEN RAISE EXCEPTION 'target unavailable'; END IF;
 SELECT * INTO dst FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 IF p_payload->>'fromRoundId' IS NULL THEN
  IF dst.id IS NOT NULL OR p_project_id<>p_request_id OR p_round_id<>p_request_id THEN RAISE EXCEPTION 'new work identity conflict'; END IF;
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id,work_title)
   VALUES(p_project_id,p_actor_id,target.module_id,target.skill_id,'script',src.id,p_payload->>'title');
 ELSE
  IF dst.actor_id IS DISTINCT FROM p_actor_id OR dst.work_kind IS DISTINCT FROM 'script' OR dst.source_project_id IS DISTINCT FROM src.id
    OR dst.module_id IS DISTINCT FROM target.module_id OR dst.skill_id IS DISTINCT FROM target.skill_id THEN RAISE EXCEPTION 'revision denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO prior FROM artifact_rounds WHERE id=(p_payload->>'fromRoundId')::uuid AND project_id=dst.id AND state='published';
  IF NOT FOUND OR p_round_id<>p_request_id THEN RAISE EXCEPTION 'revision source denied'; END IF;
 END IF;
 IF prior.id IS NOT NULL THEN target.revision_id:=prior.revision_id;target.workflow:=prior.workflow; END IF;
 descriptor:=read_skill_package(p_actor_id,target.module_id,target.skill_id,target.revision_id,NULL,NULL);
 PERFORM artifact_validate_workflow(target.workflow,descriptor);
 IF (SELECT count(*) FROM artifact_rounds WHERE project_id=p_project_id)>=100 OR (SELECT count(*) FROM artifact_evidence WHERE project_id=p_project_id)>=128 THEN RAISE EXCEPTION 'work capacity'; END IF;
 states:='{}';
 FOR k IN SELECT x->>'id' FROM jsonb_array_elements(target.workflow->'steps') x LOOP
  st:=jsonb_build_object('body','','version',0,'reviewVersion',0,'evidenceIds','[]'::jsonb,'provenanceIds','[]'::jsonb,'valid',false,'confirmationId',NULL);
  IF prior.id IS NOT NULL AND EXISTS(SELECT 1 FROM artifact_work_references WHERE round_id=prior.id AND source_version_id=v.id) THEN st:=coalesce(prior.steps->k,st); END IF;
  states:=jsonb_set(states,ARRAY[k],st||jsonb_build_object('valid',false,'confirmationId',NULL));
 END LOOP;
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
 VALUES(p_round_id,p_project_id,target.revision_id,descriptor->>'packageHash',target.workflow,artifact_hash(target.workflow),artifact_hash(target.workflow->'report'),states);
 -- A local evidence identity stores provenance only, never a second source body.
 INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES(ev,p_project_id,'user',jsonb_build_object('sourceVersionId',v.id,'sourceProjectId',src.id,'version',v.version),v.report_hash);
 INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
 INSERT INTO artifact_work_references VALUES(p_round_id,p_project_id,ev,v.id,cfg.id,cfg.section_ids,v.report_hash,p_request_id,p_payload);
 SELECT steps INTO states FROM artifact_rounds WHERE id=p_round_id;
 FOR k,st IN SELECT * FROM jsonb_each(states) LOOP
  -- Revisions keep text only when it belongs to the same fixed source. A new
  -- source requires explicit fresh content; old source text is never relabelled.
  IF prior.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifact_work_references WHERE round_id=prior.id AND source_version_id=v.id) THEN
   st:=jsonb_build_object('body','','version',0,'reviewVersion',0,'evidenceIds','[]'::jsonb,'provenanceIds','[]'::jsonb,'valid',false,'confirmationId',NULL);
  END IF;
  st:=st||jsonb_build_object('evidenceIds',st->'evidenceIds'||jsonb_build_array(ev),'provenanceIds',st->'provenanceIds'||jsonb_build_array(ev),'valid',false,'confirmationId',NULL);
  states:=jsonb_set(states,ARRAY[k],st);
 END LOOP;
 UPDATE artifact_rounds SET steps=states WHERE id=p_round_id;
 RETURN jsonb_build_object('projectId',p_project_id,'roundId',p_round_id);
END $$;
REVOKE ALL ON FUNCTION public.artifact_create_work(uuid,uuid,uuid,uuid,jsonb),public.artifact_reference_available(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_create_work(uuid,uuid,uuid,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,
 p_project_id uuid,p_round_id uuid,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ref artifact_work_references%ROWTYPE; ids jsonb;
BEGIN
 IF p_action='start' AND EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND work_kind='script') THEN RAISE EXCEPTION 'use explicit work revision'; END IF;
 SELECT * INTO ref FROM artifact_work_references WHERE round_id=p_round_id AND project_id=p_project_id;
 IF FOUND AND p_action IN ('save','candidate') THEN
  SELECT jsonb_agg(DISTINCT x) INTO ids FROM jsonb_array_elements(coalesce(p_payload->'evidenceIds','[]')||jsonb_build_array(ref.evidence_id)||coalesce((SELECT steps->(p_payload->>'stepId')->'provenanceIds' FROM artifact_rounds WHERE id=p_round_id),'[]')) x;
  p_payload:=jsonb_set(p_payload,'{evidenceIds}',ids);
 END IF;
 RETURN artifact_transition_before_reuse(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.artifact_work_source(p_actor_id uuid,p_project_id uuid,p_round_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ref artifact_work_references%ROWTYPE; v artifact_versions%ROWTYPE; p artifact_projects%ROWTYPE; sections jsonb;
BEGIN
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM artifact_rounds WHERE id=p_round_id AND project_id=p.id) THEN RAISE EXCEPTION 'round denied'; END IF;
 SELECT * INTO ref FROM artifact_work_references WHERE round_id=p_round_id;
 IF NOT FOUND THEN RETURN 'null'; END IF;
 IF NOT artifact_evidence_allowed(p.id,jsonb_build_array(ref.evidence_id)) THEN RAISE EXCEPTION 'source unavailable'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=ref.source_version_id;
 SELECT jsonb_agg(sec ORDER BY n) INTO sections FROM jsonb_array_elements(v.report->'sections') WITH ORDINALITY t(sec,n) WHERE ref.section_ids ? (sec->>'stepId');
 RETURN jsonb_build_object('evidenceId',ref.evidence_id,'sourceProjectId',v.project_id,'sourceRoundId',v.round_id,'sourceVersionId',v.id,'version',v.version,'hash',ref.source_hash,'configId',ref.config_id,'sections',sections);
END $$;
REVOKE ALL ON FUNCTION public.artifact_work_source(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_work_source(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.artifact_query(p_actor_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; r public.artifact_rounds%ROWTYPE; w public.artifact_workflows%ROWTYPE;
 result jsonb:='[]'; descriptor jsonb; snapshot jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='catalog' THEN
  IF (SELECT count(*) FROM artifact_workflows WHERE enabled)>100 THEN RAISE EXCEPTION 'registry capacity'; END IF;
  FOR w IN SELECT * FROM artifact_workflows WHERE enabled ORDER BY id LIMIT 100 LOOP
   BEGIN
    descriptor:=read_skill_package(p_actor_id,w.module_id,w.skill_id,w.revision_id,NULL,NULL);
    PERFORM artifact_validate_workflow(w.workflow,descriptor);
    result:=result||jsonb_build_array(jsonb_build_object('id',w.id,'label',w.label,'moduleId',w.module_id,'skillId',w.skill_id,
     'revisionId',w.revision_id,'packageHash',descriptor->>'packageHash','workflow',w.workflow,
     'accounts',(SELECT coalesce(jsonb_agg(account ORDER BY account),'[]') FROM artifact_accounts WHERE actor_id=p_actor_id AND module_id=w.module_id AND skill_id=w.skill_id)));
   EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
    WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF;
   END;
  END LOOP;
  RETURN result;
 ELSIF p_action='projects' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('projectId',id,'moduleId',module_id,'skillId',skill_id,'account',account,'linkedAccount',(SELECT source.account FROM artifact_projects source WHERE source.id=ap.source_project_id),'workKind',work_kind,'sourceProjectId',source_project_id,'title',coalesce(work_title,(SELECT a.workflow->'report'->>'title' FROM artifact_rounds a WHERE a.project_id=ap.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1),'已保存项目'),'currentVersion',current_version,'createdAt',created_at) ORDER BY created_at,id),'[]') FROM artifact_projects ap WHERE actor_id=p_actor_id);
 END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='rounds' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('roundId',a.id,'state',a.state,'revisionId',a.revision_id,'packageHash',a.package_hash,
    'workflowHash',a.workflow_hash,'templateHash',a.template_hash,'version',v.version,'createdAt',a.created_at) ORDER BY a.created_at,a.id),'[]')
   FROM artifact_rounds a LEFT JOIN artifact_versions v ON v.round_id=a.id WHERE a.project_id=p.id);
 END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='resolve' THEN
  RETURN jsonb_build_object('moduleId',p.module_id,'skillId',p.skill_id,'account',p.account,'revisionId',r.revision_id,'workflow',r.workflow);
 ELSIF p_action='read' THEN
  snapshot:=artifact_transition(p_actor_id,p.module_id,p.skill_id,'read',p.id,r.id);
  -- Direct candidate inputs are retained in immutable request records. The
  -- candidate's evidenceIds remain the complete inherited provenance.
  snapshot:=snapshot||jsonb_build_object('candidates',(SELECT coalesce(jsonb_agg(c||jsonb_build_object('directEvidenceIds',
   (SELECT q.payload->'evidenceIds' FROM artifact_requests q WHERE q.project_id=p.id AND q.round_id=r.id
    AND q.action='candidate' AND q.response->>'candidateId'=c->>'id' LIMIT 1))),'[]')
   FROM jsonb_array_elements(snapshot->'candidates') c));
  RETURN snapshot||jsonb_build_object('generations',(SELECT coalesce(jsonb_agg(artifact_generation_public(g) ORDER BY created_at),'[]') FROM artifact_generations g WHERE round_id=r.id),'workflow',jsonb_build_object('id',r.workflow->>'id','version',r.workflow->'version','kind',r.workflow->>'kind',
   'report',r.workflow->'report','steps',(SELECT jsonb_agg(jsonb_build_object('id',x->>'id','title',x->>'title','dependsOn',x->'dependsOn',
    'minLength',x->'minLength','maxLength',x->'maxLength','requiresEvidence',x->'requiresEvidence') ORDER BY n)
    FROM jsonb_array_elements(r.workflow->'steps') WITH ORDINALITY t(x,n))));
 END IF;
 RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501';
END $$;
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
   END;
  END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.artifact_reference_choices(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_reference_choices(uuid,uuid) TO service_role;
-- Known financial receipts remain settleable after source loss. Discard the
-- unavailable body before it can be copied into a new candidate for settlement.
CREATE OR REPLACE FUNCTION public.artifact_reference_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE ref artifact_work_references%ROWTYPE;
BEGIN
 SELECT * INTO ref FROM artifact_work_references WHERE round_id=NEW.round_id;
 IF FOUND AND NEW.result IS NOT NULL AND NOT artifact_evidence_allowed(NEW.project_id,NEW.evidence_ids||jsonb_build_array(ref.evidence_id)) THEN
  NEW.result:=jsonb_set(NEW.result,'{body}','"[来源已不可用]"');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_reference_receipt_guard ON public.artifact_generations;
CREATE TRIGGER artifact_reference_receipt_guard BEFORE INSERT OR UPDATE ON public.artifact_generations FOR EACH ROW EXECUTE FUNCTION public.artifact_reference_receipt_guard();
REVOKE ALL ON FUNCTION public.artifact_reference_receipt_guard() FROM PUBLIC,anon,authenticated,service_role;
-- Late settlement can insert candidates before updating generation state.
-- Scrub those inserts as well; retain all monetary fields and original identities.
CREATE OR REPLACE FUNCTION public.artifact_reference_candidate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE ref artifact_work_references%ROWTYPE; ids jsonb;
BEGIN
 SELECT * INTO ref FROM artifact_work_references WHERE round_id=NEW.round_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='artifact_candidates' THEN ids:=NEW.evidence_ids;
 ELSE ids:=coalesce(NEW.payload->'evidenceIds','[]')||coalesce((SELECT evidence_ids FROM artifact_candidates WHERE id::text=(NEW.response->>'candidateId') AND round_id=NEW.round_id),'[]'); END IF;
 IF NOT artifact_evidence_allowed(ref.project_id,ids||jsonb_build_array(ref.evidence_id)) THEN
  IF TG_TABLE_NAME='artifact_candidates' THEN NEW.body:='[来源已不可用]';
  ELSIF NEW.payload ? 'body' THEN NEW.payload:=jsonb_set(NEW.payload,'{body}','"[来源已不可用]"'); END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_reference_candidate_guard ON public.artifact_candidates;
CREATE TRIGGER artifact_reference_candidate_guard BEFORE INSERT ON public.artifact_candidates FOR EACH ROW EXECUTE FUNCTION public.artifact_reference_candidate_guard();
DROP TRIGGER IF EXISTS artifact_reference_candidate_guard ON public.artifact_requests;
CREATE TRIGGER artifact_reference_candidate_guard BEFORE INSERT ON public.artifact_requests FOR EACH ROW EXECUTE FUNCTION public.artifact_reference_candidate_guard();
REVOKE ALL ON FUNCTION public.artifact_reference_candidate_guard() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
