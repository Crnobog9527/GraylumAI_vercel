/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive host registrations and discovery. No automatic registrations or public table grants.
BEGIN;
CREATE TABLE IF NOT EXISTS public.artifact_workflows (
 id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{0,99}$'),
 module_id uuid NOT NULL REFERENCES public.modules(id), skill_id uuid NOT NULL REFERENCES public.skills(id),
 revision_id uuid NOT NULL REFERENCES public.skill_packages(revision_id), workflow jsonb NOT NULL,
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 160), enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS public.artifact_accounts (
 actor_id uuid NOT NULL REFERENCES public.profiles(id),module_id uuid NOT NULL REFERENCES public.modules(id),
 skill_id uuid NOT NULL REFERENCES public.skills(id),account text NOT NULL CHECK(account ~ '^[a-z0-9][a-z0-9._:-]{0,159}$'),
 PRIMARY KEY(actor_id,module_id,skill_id,account)
);
ALTER TABLE public.artifact_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artifact_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.artifact_workflows,public.artifact_accounts FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.artifact_workflow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'enabled') IS DISTINCT FROM (to_jsonb(NEW)-'enabled') THEN RAISE EXCEPTION 'registration immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_workflow_immutable ON public.artifact_workflows;
CREATE TRIGGER artifact_workflow_immutable BEFORE UPDATE ON public.artifact_workflows FOR EACH ROW EXECUTE FUNCTION public.artifact_workflow_immutable();
-- Server-only query. Internal registrations never go directly to the browser.
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
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('projectId',id,'moduleId',module_id,'skillId',skill_id,'account',account,'title',coalesce((SELECT a.workflow->'report'->>'title' FROM artifact_rounds a WHERE a.project_id=ap.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1),'已保存项目'),'currentVersion',current_version,'createdAt',created_at) ORDER BY created_at,id),'[]') FROM artifact_projects ap WHERE actor_id=p_actor_id);
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
  RETURN snapshot||jsonb_build_object('workflow',jsonb_build_object('id',r.workflow->>'id','version',r.workflow->'version','kind',r.workflow->>'kind',
   'report',r.workflow->'report','steps',(SELECT jsonb_agg(jsonb_build_object('id',x->>'id','title',x->>'title','dependsOn',x->'dependsOn',
    'minLength',x->'minLength','maxLength',x->'maxLength','requiresEvidence',x->'requiresEvidence') ORDER BY n)
    FROM jsonb_array_elements(r.workflow->'steps') WITH ORDINALITY t(x,n))));
 END IF;
 RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501';
END $$;
-- Bind browser publication to the displayed confirmation versions under the same
-- project lock used by the existing atomic publication. Replays retain the input identity.
CREATE OR REPLACE FUNCTION public.artifact_publish_current(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
 p_project_id uuid,p_round_id uuid,p_request_id uuid,p_expected_steps jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; actual jsonb; payload jsonb:=jsonb_build_object('expectedSteps',p_expected_steps);
BEGIN
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 snapshot:=artifact_transition(p_actor_id,p_module_id,p_skill_id,'read',p_project_id,p_round_id);
 IF NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
  SELECT jsonb_object_agg(key,jsonb_build_object('version',value->'version','reviewVersion',value->'reviewVersion')) INTO actual FROM jsonb_each(snapshot->'steps');
  IF actual IS DISTINCT FROM p_expected_steps THEN RAISE EXCEPTION 'publication conflict'; END IF;
 END IF;
 RETURN artifact_transition(p_actor_id,p_module_id,p_skill_id,'publish',p_project_id,p_round_id,p_request_id,payload);
END $$;
REVOKE ALL ON FUNCTION public.artifact_publish_current(uuid,uuid,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_publish_current(uuid,uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.artifact_workflow_immutable() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.artifact_query(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_query(uuid,text,uuid,uuid) TO service_role;
COMMIT;
