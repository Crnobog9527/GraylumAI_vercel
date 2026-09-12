/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Two configured methods, fixed formal inputs, target-local evidence. No seeds.
BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_slice_pairs (
 id text PRIMARY KEY CHECK(id ~ '^[a-z][a-z0-9_-]{0,99}$'),
 script_workflow text NOT NULL REFERENCES public.artifact_workflows(id),
 title_workflow text NOT NULL REFERENCES public.artifact_workflows(id),
 script_sections jsonb NOT NULL CHECK(jsonb_typeof(script_sections)='array' AND jsonb_array_length(script_sections) BETWEEN 1 AND 32),
 title_sections jsonb NOT NULL CHECK(jsonb_typeof(title_sections)='array' AND jsonb_array_length(title_sections) BETWEEN 1 AND 32),
 max_chars integer NOT NULL CHECK(max_chars BETWEEN 1 AND 20000),
 enabled boolean NOT NULL DEFAULT false,
 CHECK(script_workflow<>title_workflow)
);
CREATE TABLE IF NOT EXISTS public.agent_slice_links (
 round_id uuid PRIMARY KEY REFERENCES public.artifact_rounds(id),
 evidence_id uuid NOT NULL UNIQUE REFERENCES public.artifact_evidence(id),
 source_version_id uuid NOT NULL REFERENCES public.artifact_versions(id),
 source_hash text NOT NULL,
 pair_id text NOT NULL REFERENCES public.agent_slice_pairs(id),
 section_ids jsonb NOT NULL,
 request_id uuid NOT NULL UNIQUE
);
ALTER TABLE public.agent_slice_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_slice_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_slice_pairs,public.agent_slice_links FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_workflow_immutable ON public.agent_slice_pairs;
CREATE TRIGGER artifact_workflow_immutable BEFORE UPDATE ON public.agent_slice_pairs FOR EACH ROW EXECUTE FUNCTION public.artifact_workflow_immutable();
DROP TRIGGER IF EXISTS artifact_immutable ON public.agent_slice_links;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.agent_slice_links FOR EACH ROW EXECUTE FUNCTION public.artifact_immutable();

DO $$ BEGIN
 IF to_regprocedure('public.artifact_evidence_allowed_before_slice(uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.artifact_evidence_allowed(uuid,jsonb) RENAME TO artifact_evidence_allowed_before_slice;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.artifact_evidence_allowed_before_slice(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.agent_slice_evidence_allowed(project uuid,ids jsonb,visited uuid[] DEFAULT '{}') RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE link agent_slice_links%ROWTYPE; version artifact_versions%ROWTYPE; source artifact_projects%ROWTYPE;
 target artifact_projects%ROWTYPE; source_round artifact_rounds%ROWTYPE;
BEGIN
 IF NOT artifact_evidence_allowed_before_slice(project,ids) THEN RETURN false; END IF;
 FOR link IN SELECT l.* FROM agent_slice_links l JOIN artifact_evidence e ON e.id=l.evidence_id
  WHERE e.project_id=project AND ids ? e.id::text LOOP
  IF cardinality(visited)>=8 OR link.evidence_id=ANY(visited) THEN RETURN false; END IF;
  SELECT * INTO version FROM artifact_versions WHERE id=link.source_version_id;
  SELECT * INTO source FROM artifact_projects WHERE id=version.project_id;
  SELECT * INTO target FROM artifact_projects WHERE id=project;
  SELECT * INTO source_round FROM artifact_rounds WHERE id=version.round_id AND state='published';
  IF source.id IS NULL OR target.id IS NULL OR source_round.id IS NULL OR source.actor_id<>target.actor_id
   OR source.source_project_id IS DISTINCT FROM target.source_project_id OR source.source_project_id IS NULL
   OR version.report_hash<>link.source_hash OR NOT EXISTS(SELECT 1 FROM agent_slice_pairs WHERE id=link.pair_id AND enabled)
   OR NOT agent_slice_evidence_allowed(source.id,version.evidence_ids,visited||link.evidence_id) THEN RETURN false; END IF;
  BEGIN
   PERFORM read_skill_package(source.actor_id,source.module_id,source.skill_id,source_round.revision_id,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
  END;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.artifact_evidence_allowed(project uuid,ids jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS $$
 SELECT agent_slice_evidence_allowed(project,ids)
$$;
REVOKE ALL ON FUNCTION public.agent_slice_evidence_allowed(uuid,jsonb,uuid[]),public.artifact_evidence_allowed(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.agent_slice_link(p_actor_id uuid,p_project_id uuid,p_round_id uuid,p_source_version_id uuid,p_pair_id text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target artifact_projects%ROWTYPE; source artifact_projects%ROWTYPE; r artifact_rounds%ROWTYPE;
 v artifact_versions%ROWTYPE; sr artifact_rounds%ROWTYPE; cfg agent_slice_pairs%ROWTYPE;
 a artifact_workflows%ROWTYPE; b artifact_workflows%ROWTYPE; link agent_slice_links%ROWTYPE;
 sections jsonb; ev uuid:=gen_random_uuid(); states jsonb; k text; st jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id AND work_kind='script' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=target.id;
 SELECT * INTO link FROM agent_slice_links WHERE round_id=p_round_id;
 IF FOUND THEN
  IF link.request_id IS DISTINCT FROM p_request_id OR link.source_version_id IS DISTINCT FROM p_source_version_id OR link.pair_id IS DISTINCT FROM p_pair_id THEN RAISE EXCEPTION 'slice link conflict'; END IF;
  RETURN jsonb_build_object('evidenceId',link.evidence_id);
 END IF;
 IF r.id IS NULL OR r.state<>'draft' OR EXISTS(SELECT 1 FROM artifact_generations WHERE round_id=r.id)
  OR EXISTS(SELECT 1 FROM artifact_candidates WHERE round_id=r.id)
  OR EXISTS(SELECT 1 FROM artifact_requests WHERE round_id=r.id AND action IN ('save','candidate','confirm','publish','slice_input'))
 THEN RAISE EXCEPTION 'slice link requires a fresh draft'; END IF;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=p_pair_id AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'slice pair unavailable'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id AND actor_id=p_actor_id AND work_kind='script';
 SELECT * INTO sr FROM artifact_rounds WHERE id=v.round_id AND state='published';
 IF source.id IS NULL OR source.id=target.id OR sr.id IS NULL OR source.source_project_id IS DISTINCT FROM target.source_project_id
  OR target.source_project_id IS NULL OR NOT artifact_evidence_allowed(source.id,v.evidence_ids)
 THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 SELECT * INTO a FROM artifact_workflows WHERE id=cfg.script_workflow AND enabled;
 SELECT * INTO b FROM artifact_workflows WHERE id=cfg.title_workflow AND enabled;
 IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'slice pair unavailable'; END IF;
 IF source.module_id=a.module_id AND source.skill_id=a.skill_id AND sr.workflow->>'id'=a.workflow->>'id'
  AND target.module_id=b.module_id AND target.skill_id=b.skill_id AND r.workflow->>'id'=b.workflow->>'id' THEN sections:=cfg.script_sections;
 ELSIF source.module_id=b.module_id AND source.skill_id=b.skill_id AND sr.workflow->>'id'=b.workflow->>'id'
  AND target.module_id=a.module_id AND target.skill_id=a.skill_id AND r.workflow->>'id'=a.workflow->>'id' THEN sections:=cfg.title_sections;
 ELSE RAISE EXCEPTION 'slice methods do not match'; END IF;
 PERFORM read_skill_package(p_actor_id,source.module_id,source.skill_id,sr.revision_id,NULL,NULL);
 PERFORM read_skill_package(p_actor_id,target.module_id,target.skill_id,r.revision_id,NULL,NULL);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(sections) x WHERE jsonb_typeof(x)<>'string')
  OR jsonb_array_length(sections)<>(SELECT count(DISTINCT x) FROM jsonb_array_elements(sections) x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(sections) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.report->'sections') s WHERE s->>'stepId'=x))
  OR (SELECT coalesce(sum(char_length(s->>'body')),0) FROM jsonb_array_elements(v.report->'sections') s WHERE sections ? (s->>'stepId'))>cfg.max_chars
 THEN RAISE EXCEPTION 'slice source sections unavailable'; END IF;
 IF (SELECT count(*) FROM artifact_evidence WHERE project_id=target.id)>=128 THEN RAISE EXCEPTION 'work capacity'; END IF;
 INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash)
  VALUES(ev,target.id,'user',jsonb_build_object('sourceVersionId',v.id,'sourceProjectId',source.id,'version',v.version,'kind','skill_handoff'),v.report_hash);
 INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
 INSERT INTO agent_slice_links VALUES(r.id,ev,v.id,v.report_hash,cfg.id,sections,p_request_id);
 states:=r.steps;
 FOR k,st IN SELECT * FROM jsonb_each(states) LOOP
  st:=st||jsonb_build_object('evidenceIds',st->'evidenceIds'||jsonb_build_array(ev),'provenanceIds',st->'provenanceIds'||jsonb_build_array(ev),'valid',false,'confirmationId',NULL);
  states:=jsonb_set(states,ARRAY[k],st);
 END LOOP;
 UPDATE artifact_rounds SET steps=states WHERE id=r.id;
 RETURN jsonb_build_object('evidenceId',ev);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_link(uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_link(uuid,uuid,uuid,uuid,text,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.agent_slice_link_read(p_actor_id uuid,p_project_id uuid,p_round_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p artifact_projects%ROWTYPE; r artifact_rounds%ROWTYPE; link agent_slice_links%ROWTYPE;
 v artifact_versions%ROWTYPE; source artifact_projects%ROWTYPE; sr artifact_rounds%ROWTYPE; cfg agent_slice_pairs%ROWTYPE; account_name text;
BEGIN
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p.id;
 SELECT * INTO link FROM agent_slice_links WHERE round_id=r.id;
 IF link.round_id IS NULL OR NOT artifact_evidence_allowed(p.id,jsonb_build_array(link.evidence_id)) THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=link.source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id;
 SELECT * INTO sr FROM artifact_rounds WHERE id=v.round_id;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=link.pair_id AND enabled;
 SELECT root.account INTO account_name FROM artifact_projects root WHERE root.id=p.source_project_id;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,NULL,NULL);
 PERFORM read_skill_package(p_actor_id,source.module_id,source.skill_id,sr.revision_id,NULL,NULL);
 RETURN jsonb_build_object('projectId',source.id,'roundId',sr.id,'versionId',v.id,'version',v.version,'hash',v.report_hash,
  'targetProjectId',p.id,'targetRoundId',r.id,'account',account_name,'sections',link.section_ids,'maxChars',cfg.max_chars);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_link_read(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_link_read(uuid,uuid,uuid) TO service_role;
COMMIT;
