/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive, service-only artifact transactions. Apply remotely only with separate approval.
BEGIN;
CREATE TABLE IF NOT EXISTS public.artifact_projects (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id),
 module_id uuid NOT NULL REFERENCES public.modules(id),skill_id uuid NOT NULL REFERENCES public.skills(id),
 account text CHECK(account ~ '^[a-z0-9][a-z0-9._:-]{0,159}$'), current_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_social_account ON public.artifact_projects(actor_id,account) WHERE account IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS artifact_document_project ON public.artifact_projects(actor_id,skill_id) WHERE account IS NULL;
CREATE TABLE IF NOT EXISTS public.artifact_rounds (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.artifact_projects(id),
 revision_id uuid NOT NULL REFERENCES public.skill_packages(revision_id),package_hash text NOT NULL,
 workflow jsonb NOT NULL,workflow_hash text NOT NULL,template_hash text NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','abandoned')),
 steps jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_active_draft ON public.artifact_rounds(project_id) WHERE state='draft';
CREATE TABLE IF NOT EXISTS public.artifact_evidence (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.artifact_projects(id),kind text NOT NULL CHECK(kind IN ('supplier','user','revision')),
 operation_id uuid REFERENCES public.research_operations(id),supersedes uuid REFERENCES public.artifact_evidence(id),
 payload jsonb NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_evidence_operation ON public.artifact_evidence(operation_id) WHERE operation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.artifact_evidence_restrictions (
 evidence_id uuid PRIMARY KEY REFERENCES public.artifact_evidence(id),deleted boolean NOT NULL DEFAULT false,expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.artifact_confirmations (
 id uuid PRIMARY KEY,round_id uuid NOT NULL REFERENCES public.artifact_rounds(id),step_id text NOT NULL,
 version integer NOT NULL,body text NOT NULL,evidence_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.artifact_candidates (
 id uuid PRIMARY KEY,round_id uuid NOT NULL REFERENCES public.artifact_rounds(id),step_id text NOT NULL,
 body text NOT NULL,evidence_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.artifact_versions (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.artifact_projects(id),round_id uuid NOT NULL UNIQUE REFERENCES public.artifact_rounds(id),
 version integer NOT NULL,report jsonb NOT NULL,report_hash text NOT NULL,evidence_ids jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,version)
);
CREATE TABLE IF NOT EXISTS public.artifact_requests (
 project_id uuid NOT NULL REFERENCES public.artifact_projects(id),request_id uuid NOT NULL,
 round_id uuid NOT NULL REFERENCES public.artifact_rounds(id),action text NOT NULL,payload jsonb NOT NULL,response jsonb NOT NULL,
 PRIMARY KEY(project_id,request_id)
);
-- Defense against privileged accidental history edits; no caller has table grants.
CREATE OR REPLACE FUNCTION public.artifact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'artifact history immutable'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['artifact_evidence','artifact_confirmations','artifact_candidates','artifact_versions','artifact_requests'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS artifact_immutable ON public.%I',t);
  EXECUTE format('CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.artifact_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['artifact_projects','artifact_rounds','artifact_evidence','artifact_evidence_restrictions','artifact_confirmations','artifact_candidates','artifact_versions','artifact_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.artifact_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex')
$$;
CREATE OR REPLACE FUNCTION public.artifact_evidence_allowed(project uuid,ids jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_typeof(ids)='array' AND jsonb_array_length(ids)<=64 AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements_text(ids) x LEFT JOIN public.artifact_evidence e ON e.id::text=x AND e.project_id=project
 LEFT JOIN public.artifact_evidence_restrictions r ON r.evidence_id=e.id
 WHERE e.id IS NULL OR r.deleted OR r.expires_at<=clock_timestamp())
$$;
CREATE OR REPLACE FUNCTION public.artifact_invalidate(flow jsonb,steps jsonb,changed text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE k text; result jsonb:=steps;
BEGIN
 FOR k IN WITH RECURSIVE affected(id) AS (
 SELECT changed UNION SELECT s->>'id' FROM affected a,jsonb_array_elements(flow->'steps') s
 WHERE s->'dependsOn' ? a.id) SELECT id FROM affected LOOP
  result:=jsonb_set(result,ARRAY[k,'valid'],'false');
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.artifact_step_evidence(flow jsonb,steps jsonb,step text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH RECURSIVE ancestors(id) AS (
 SELECT step UNION SELECT d FROM ancestors a,jsonb_array_elements(flow->'steps') node,jsonb_array_elements_text(node->'dependsOn') d WHERE node->>'id'=a.id)
 SELECT coalesce(jsonb_agg(DISTINCT e ORDER BY e),'[]') FROM ancestors a,jsonb_array_elements(coalesce(steps->a.id->'evidenceIds','[]')||coalesce(steps->a.id->'provenanceIds','[]')) e
$$;
CREATE OR REPLACE FUNCTION public.artifact_resource_identity(manifest jsonb,roots jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 WITH RECURSIVE paths(path) AS (
 SELECT jsonb_array_elements_text(roots||'["SKILL.md"]'::jsonb)
 UNION SELECT d FROM paths p,jsonb_array_elements(manifest->'files') f,jsonb_array_elements_text(f->'requires') d WHERE f->>'path'=p.path)
 SELECT coalesce(jsonb_agg(f ORDER BY f->>'path'),'[]') FROM jsonb_array_elements(manifest->'files') f WHERE f->>'path' IN (SELECT path FROM paths)
$$;
CREATE OR REPLACE FUNCTION public.artifact_round_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.revision_id IS DISTINCT FROM NEW.revision_id
 OR OLD.package_hash IS DISTINCT FROM NEW.package_hash OR OLD.workflow IS DISTINCT FROM NEW.workflow OR OLD.workflow_hash IS DISTINCT FROM NEW.workflow_hash
 OR OLD.template_hash IS DISTINCT FROM NEW.template_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
 OR (OLD.state<>'draft' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'fixed round is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_round_identity ON public.artifact_rounds;
CREATE TRIGGER artifact_round_identity BEFORE UPDATE ON public.artifact_rounds FOR EACH ROW EXECUTE FUNCTION public.artifact_round_identity();
CREATE OR REPLACE FUNCTION public.artifact_validate_workflow(flow jsonb,manifest jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s jsonb; v jsonb; key text;
BEGIN
 IF (jsonb_typeof(flow)<>'object' OR octet_length(flow::text)>65536 OR flow->>'kind' NOT IN ('social','document')
 OR flow->>'id' !~ '^[a-z][a-z0-9_-]{0,63}$' OR (flow->>'version')::integer<1
 OR jsonb_typeof(flow->'steps')<>'array' OR jsonb_array_length(flow->'steps') NOT BETWEEN 1 AND 32
 OR jsonb_typeof(flow->'report'->'sections')<>'array' OR jsonb_array_length(flow->'report'->'sections') NOT BETWEEN 1 AND 64
 OR flow->'report'->>'id' IS NULL OR (flow->'report'->>'version')::integer<1) IS DISTINCT FROM false THEN RAISE EXCEPTION 'invalid workflow'; END IF;
 IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(flow->'steps') x)<>jsonb_array_length(flow->'steps') THEN RAISE EXCEPTION 'invalid workflow'; END IF;
 FOR s IN SELECT * FROM jsonb_array_elements(flow->'steps') LOOP
  IF (s->>'id' !~ '^[a-z][a-z0-9_-]{0,63}$' OR s->>'title' IS NULL
  OR (s->>'minLength')::integer NOT BETWEEN 1 AND 20000 OR (s->>'maxLength')::integer NOT BETWEEN (s->>'minLength')::integer AND 20000
  OR jsonb_typeof(s->'dependsOn')<>'array' OR jsonb_typeof(s->'resources')<>'array' OR jsonb_array_length(s->'resources') NOT BETWEEN 1 AND 64
  OR jsonb_typeof(s->'requiresEvidence')<>'boolean' OR jsonb_typeof(s->'requiredCapabilities')<>'array') IS DISTINCT FROM false THEN RAISE EXCEPTION 'invalid step'; END IF;
  FOR key IN SELECT jsonb_array_elements_text(s->'dependsOn') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(flow->'steps') x WHERE x->>'id'=key) THEN RAISE EXCEPTION 'invalid dependency'; END IF;
  END LOOP;
  FOR key IN SELECT jsonb_array_elements_text(s->'resources') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'files') x WHERE x->>'path'=key) THEN RAISE EXCEPTION 'invalid resource'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(s->'requiredCapabilities') x WHERE x NOT IN ('documents.read','research.evidence')) THEN RAISE EXCEPTION 'unsupported capability'; END IF;
  IF (s->>'requiresEvidence')::boolean AND NOT s->'requiredCapabilities' ? 'research.evidence' THEN RAISE EXCEPTION 'unsupported capability'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(flow->'report'->'sections') x WHERE x->>'stepId'=s->>'id') THEN RAISE EXCEPTION 'missing report mapping'; END IF;
 END LOOP;
 IF EXISTS(WITH RECURSIVE edges(a,b,path,cycle) AS (
 SELECT node->>'id',d,ARRAY[node->>'id',d],node->>'id'=d FROM jsonb_array_elements(flow->'steps') node,jsonb_array_elements_text(node->'dependsOn') d
 UNION ALL SELECT e.a,d,e.path||d,d=ANY(e.path) FROM edges e,jsonb_array_elements(flow->'steps') node,jsonb_array_elements_text(node->'dependsOn') d WHERE node->>'id'=e.b AND NOT e.cycle)
 SELECT 1 FROM edges WHERE cycle) THEN RAISE EXCEPTION 'cyclic workflow'; END IF;
 FOR v IN SELECT * FROM jsonb_array_elements(flow->'report'->'sections') LOOP
  IF v->>'title' IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(flow->'steps') node WHERE node->>'id'=v->>'stepId') THEN RAISE EXCEPTION 'invalid report mapping'; END IF;
 END LOOP;
END $$;
-- The only privileged entry. The host passes actor exclusively from getUser.
CREATE OR REPLACE FUNCTION public.artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,
 p_project_id uuid,p_round_id uuid,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; r public.artifact_rounds%ROWTYPE; prior public.artifact_rounds%ROWTYPE;
 req public.artifact_requests%ROWTYPE; ev public.artifact_evidence%ROWTYPE; ver public.artifact_versions%ROWTYPE;
 manifest jsonb; old_manifest jsonb; flow jsonb; states jsonb; st jsonb; s jsonb; body text; ids jsonb; response jsonb;
 ident uuid:=gen_random_uuid(); k text; dep text; changed text[]:='{}'; snap jsonb; sections jsonb:='[]'; all_ids jsonb:='[]';
BEGIN
 IF p_payload IS NULL OR octet_length(p_payload::text)>1048576 OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='start' THEN
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account)
  VALUES(p_project_id,p_actor_id,p_module_id,p_skill_id,p_payload->>'account') ON CONFLICT(id) DO NOTHING;
 END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 IF NOT FOUND OR p.actor_id<>p_actor_id OR p.module_id<>p_module_id OR p.skill_id<>p_skill_id THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'actor no longer active' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id;
 IF FOUND AND r.project_id<>p.id THEN RAISE EXCEPTION 'round denied' USING ERRCODE='42501'; END IF;
 IF p_action<>'start' AND r.id IS NULL THEN RAISE EXCEPTION 'round denied'; END IF;
 IF r.id IS NOT NULL THEN
  states:=r.steps;
  FOR k,st IN SELECT * FROM jsonb_each(states) LOOP
   IF NOT artifact_evidence_allowed(p.id,artifact_step_evidence(r.workflow,states,k)) THEN states:=artifact_invalidate(r.workflow,states,k); END IF;
  END LOOP;
  r.steps:=states; -- expiry propagates without a scheduler or modification of historical snapshots.
 END IF;
 IF p_action NOT IN ('read','report','restrictEvidence','abandon') THEN
  manifest:=read_skill_package(p_actor_id,p.module_id,p.skill_id,
    CASE WHEN p_action='start' THEN (p_payload->>'revisionId')::uuid ELSE r.revision_id END,
    CASE WHEN p_action='start' THEN p_payload->>'packageHash' ELSE r.package_hash END,NULL);
 END IF;
 IF p_action IN ('read','report') THEN
  IF p_action='report' THEN
   SELECT * INTO ver FROM artifact_versions WHERE round_id=r.id AND project_id=p.id;
   IF NOT FOUND THEN RETURN jsonb_build_object('available',false,'reason','NOT_PUBLISHED'); END IF;
   IF NOT artifact_evidence_allowed(p.id,ver.evidence_ids) THEN RETURN jsonb_build_object('available',false,'reason','EVIDENCE_UNAVAILABLE','version',ver.version); END IF;
   RETURN jsonb_build_object('available',true,'version',ver.version,'id',ver.id,'report',ver.report,'hash',ver.report_hash);
  END IF;
  states:='{}';
  FOR k,st IN SELECT * FROM jsonb_each(r.steps) LOOP
   IF NOT artifact_evidence_allowed(p.id,artifact_step_evidence(r.workflow,r.steps,k)) THEN st:=st||'{"body":null,"valid":false,"available":false}'; END IF;
   states:=jsonb_set(states,ARRAY[k],st);
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'supersedes',e.supersedes,'hash',e.content_hash,'createdAt',e.created_at,
   'available',artifact_evidence_allowed(p.id,jsonb_build_array(e.id)),
   'payload',CASE WHEN artifact_evidence_allowed(p.id,jsonb_build_array(e.id)) THEN e.payload ELSE 'null'::jsonb END) ORDER BY e.id),'[]') INTO ids FROM artifact_evidence e WHERE e.project_id=p.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'stepId',c.step_id,'body',CASE WHEN artifact_evidence_allowed(p.id,c.evidence_ids) THEN c.body ELSE NULL END,'evidenceIds',c.evidence_ids) ORDER BY c.id),'[]') INTO sections FROM artifact_candidates c WHERE c.round_id=r.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'stepId',c.step_id,'version',c.version,'body',CASE WHEN artifact_evidence_allowed(p.id,c.evidence_ids) THEN c.body ELSE NULL END,'evidenceIds',c.evidence_ids) ORDER BY c.id),'[]') INTO snap FROM artifact_confirmations c WHERE c.round_id=r.id;
  -- Explicit public UI projection; never return resources, required-capability plans or manifest.
  SELECT jsonb_build_object('id',r.workflow->>'id','version',r.workflow->'version','steps',jsonb_agg(jsonb_build_object('id',x->>'id','title',x->>'title','dependsOn',x->'dependsOn') ORDER BY n)) INTO flow FROM jsonb_array_elements(r.workflow->'steps') WITH ORDINALITY t(x,n);
  RETURN jsonb_build_object('projectId',p.id,'roundId',r.id,'skillId',p.skill_id,'state',r.state,'currentVersion',p.current_version,
   'revisionId',r.revision_id,'packageHash',r.package_hash,'workflowHash',r.workflow_hash,'templateHash',r.template_hash,'workflow',flow,'steps',states,'evidence',ids,'candidates',sections,'confirmations',snap);
 END IF;
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'request identity required'; END IF;
 SELECT * INTO req FROM artifact_requests WHERE project_id=p.id AND request_id=p_request_id;
 IF FOUND THEN
  IF req.round_id<>p_round_id OR req.action<>p_action OR req.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'request conflict'; END IF;
  RETURN req.response; -- identifiers only: never replay an expired evidence body.
 END IF;
 IF p_action='start' THEN
  IF (SELECT count(*) FROM artifact_rounds WHERE project_id=p.id)>=100 THEN RAISE EXCEPTION 'round capacity'; END IF;
  IF r.id IS NOT NULL OR p.account IS DISTINCT FROM p_payload->>'account' THEN RAISE EXCEPTION 'round conflict'; END IF;
  flow:=p_payload->'workflow';PERFORM artifact_validate_workflow(flow,manifest);
  IF (flow->>'kind'='social')<>(p.account IS NOT NULL) THEN RAISE EXCEPTION 'account scope'; END IF;
  states:='{}';
  IF p_payload->>'fromRoundId' IS NOT NULL THEN
   SELECT * INTO prior FROM artifact_rounds WHERE id=(p_payload->>'fromRoundId')::uuid AND project_id=p.id;
   IF NOT FOUND OR prior.state='draft' THEN RAISE EXCEPTION 'source round denied'; END IF;
   SELECT m.manifest INTO old_manifest FROM skill_packages m WHERE m.revision_id=prior.revision_id;
  ELSIF EXISTS(SELECT 1 FROM artifact_rounds WHERE project_id=p.id) THEN RAISE EXCEPTION 'explicit source round required'; END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(flow->'steps') LOOP
   k:=s->>'id';st:=coalesce(prior.steps->k,jsonb_build_object('body','','version',0,'evidenceIds','[]'::jsonb,'provenanceIds','[]'::jsonb,'confirmationId',NULL,'valid',false));
   IF prior.id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.workflow->'steps') x WHERE x=s)
    OR artifact_resource_identity(manifest,s->'resources') IS DISTINCT FROM artifact_resource_identity(old_manifest,s->'resources')) THEN
    changed:=array_append(changed,k);
   END IF;
   states:=jsonb_set(states,ARRAY[k],st);
  END LOOP;
  FOREACH k IN ARRAY changed LOOP states:=artifact_invalidate(flow,states,k); END LOOP;
  INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
   VALUES(p_round_id,p.id,(p_payload->>'revisionId')::uuid,p_payload->>'packageHash',flow,artifact_hash(flow),artifact_hash(flow->'report'),states);
  FOR k,st IN SELECT * FROM jsonb_each(states) LOOP
   IF (st->>'valid')::boolean AND artifact_evidence_allowed(p.id,st->'evidenceIds') THEN
    ident:=gen_random_uuid();INSERT INTO artifact_confirmations VALUES(ident,p_round_id,k,(st->>'version')::integer,st->>'body',artifact_step_evidence(flow,states,k),now());
    states:=jsonb_set(states,ARRAY[k,'confirmationId'],to_jsonb(ident));
   ELSE states:=jsonb_set(states,ARRAY[k,'valid'],'false');states:=jsonb_set(states,ARRAY[k,'confirmationId'],'null'); END IF;
  END LOOP;
  UPDATE artifact_rounds SET steps=states WHERE id=p_round_id;
  response:=jsonb_build_object('roundId',p_round_id);
 ELSE
  IF p_action NOT IN ('restrictEvidence','abandon','candidate') AND r.state<>'draft' THEN RAISE EXCEPTION 'round closed'; END IF;
  states:=r.steps;k:=p_payload->>'stepId';st:=states->k;
  IF p_action IN ('save','confirm','candidate') THEN
   SELECT x INTO s FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=k;
   IF s IS NULL THEN RAISE EXCEPTION 'step denied'; END IF;
  END IF;
  IF p_action IN ('save','candidate') THEN
   body:=p_payload->>'body';ids:=p_payload->'evidenceIds';
   IF body IS NULL OR ids IS NULL OR char_length(body)>(s->>'maxLength')::integer OR NOT artifact_evidence_allowed(p.id,ids) THEN RAISE EXCEPTION 'invalid content or evidence'; END IF;
   IF p_action='candidate' THEN
    IF (SELECT count(*) FROM artifact_candidates WHERE round_id=r.id)>=256 THEN RAISE EXCEPTION 'candidate capacity'; END IF;
    ids:=artifact_step_evidence(r.workflow,jsonb_set(states,ARRAY[k,'evidenceIds'],ids),k);
    IF NOT artifact_evidence_allowed(p.id,ids) THEN RAISE EXCEPTION 'dependency evidence unavailable'; END IF;
    INSERT INTO artifact_candidates(id,round_id,step_id,body,evidence_ids) VALUES(ident,r.id,k,body,ids);
    response:=jsonb_build_object('candidateId',ident);
   ELSE
    IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM (st->>'version')::integer THEN RAISE EXCEPTION 'save conflict'; END IF;
    st:=st||jsonb_build_object('body',body,'evidenceIds',ids,'provenanceIds','[]'::jsonb,'version',(st->>'version')::integer+1);
    st:=st||jsonb_build_object('provenanceIds',artifact_step_evidence(r.workflow,jsonb_set(states,ARRAY[k],st),k));
    states:=artifact_invalidate(r.workflow,jsonb_set(states,ARRAY[k],st),k);
    UPDATE artifact_rounds SET steps=states WHERE id=r.id;
    response:=jsonb_build_object('version',st->'version');
   END IF;
  ELSIF p_action='confirm' THEN
   IF (p_payload->>'expectedVersion')::integer IS DISTINCT FROM (st->>'version')::integer OR char_length(btrim(st->>'body'))<(s->>'minLength')::integer
    OR NOT artifact_evidence_allowed(p.id,st->'evidenceIds') OR ((s->>'requiresEvidence')::boolean AND jsonb_array_length(st->'evidenceIds')=0) THEN RAISE EXCEPTION 'confirmation conflict'; END IF;
   FOR dep IN SELECT jsonb_array_elements_text(s->'dependsOn') LOOP
    IF NOT (states->dep->>'valid')::boolean OR NOT artifact_evidence_allowed(p.id,states->dep->'evidenceIds') THEN RAISE EXCEPTION 'dependency review required'; END IF;
   END LOOP;
   ids:=artifact_step_evidence(r.workflow,states,k);
   IF NOT artifact_evidence_allowed(p.id,ids) THEN RAISE EXCEPTION 'dependency evidence unavailable'; END IF;
   INSERT INTO artifact_confirmations(id,round_id,step_id,version,body,evidence_ids) VALUES(ident,r.id,k,(st->>'version')::integer,st->>'body',ids);
   states:=jsonb_set(states,ARRAY[k],st||jsonb_build_object('confirmationId',ident,'valid',true,'provenanceIds',ids));
   UPDATE artifact_rounds SET steps=states WHERE id=r.id;
   response:=jsonb_build_object('confirmationId',ident);
  ELSIF p_action='publish' THEN
   FOR s IN SELECT * FROM jsonb_array_elements(r.workflow->'steps') LOOP
    st:=states->(s->>'id');
    IF NOT (st->>'valid')::boolean OR NOT artifact_evidence_allowed(p.id,st->'evidenceIds') THEN RAISE EXCEPTION 'confirmation required'; END IF;
    IF NOT EXISTS(SELECT 1 FROM artifact_confirmations c WHERE c.id=(st->>'confirmationId')::uuid AND c.round_id=r.id AND c.step_id=s->>'id' AND c.version=(st->>'version')::integer AND c.body=st->>'body' AND c.evidence_ids=artifact_step_evidence(r.workflow,states,s->>'id')) THEN RAISE EXCEPTION 'snapshot conflict'; END IF;
    all_ids:=all_ids||artifact_step_evidence(r.workflow,states,s->>'id');
   END LOOP;
   SELECT coalesce(jsonb_agg(DISTINCT v ORDER BY v),'[]') INTO all_ids FROM jsonb_array_elements(all_ids) v;
   FOR s IN SELECT * FROM jsonb_array_elements(r.workflow->'report'->'sections') LOOP
    st:=states->(s->>'stepId');sections:=sections||jsonb_build_array(jsonb_build_object('title',s->>'title','stepId',s->>'stepId','body',st->>'body','confirmationId',st->'confirmationId','evidenceIds',st->'evidenceIds'));
   END LOOP;
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'hash',e.content_hash,'operationId',e.operation_id,'supersedes',e.supersedes,'fetchedAt',coalesce(e.payload#>'{result,fetchedAt}',to_jsonb(e.created_at)),'observedAt',e.payload->'observedAt','pagination',e.payload#>'{result,pagination}','cost',e.payload#>'{result,cost}','license','unknown',
    'objects',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o->'id','sourceUrl',o->'sourceUrl','observedAt',o->'observedAt','missingFields',o->'missingFields')),'[]') FROM jsonb_array_elements(coalesce(e.payload#>'{result,objects}','[]')) o)) ORDER BY e.id),'[]') INTO ids FROM artifact_evidence e WHERE all_ids ? e.id::text;
   snap:=jsonb_build_object('sources',ids,'title',r.workflow->'report'->>'title','sections',sections,'workflowHash',r.workflow_hash,'templateHash',r.template_hash,'revisionId',r.revision_id,'packageHash',r.package_hash,'version',p.current_version+1,'limitations','Confirmed content and referenced evidence only; not a new model analysis.');
   INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) VALUES(ident,p.id,r.id,p.current_version+1,snap,artifact_hash(snap),all_ids);
   UPDATE artifact_projects SET current_version=current_version+1 WHERE id=p.id;
   UPDATE artifact_rounds SET state='published' WHERE id=r.id;
   response:=jsonb_build_object('versionId',ident,'version',p.current_version+1);
  ELSIF p_action='abandon' THEN
   IF r.state<>'draft' THEN RAISE EXCEPTION 'round closed'; END IF;
   UPDATE artifact_rounds SET state='abandoned' WHERE id=r.id;response:='{"abandoned":true}';
  ELSIF p_action IN ('researchEvidence','userEvidence') THEN
   IF (SELECT count(*) FROM artifact_evidence WHERE project_id=p.id)>=128 THEN RAISE EXCEPTION 'evidence capacity'; END IF;
   IF p_action='researchEvidence' THEN
    SELECT o.result INTO snap FROM research_operations o JOIN research_plans plan ON plan.id=o.plan_id
     WHERE o.id=(p_payload->>'operationId')::uuid AND o.plan_id=(p_payload->>'planId')::uuid AND plan.actor_id=p.actor_id AND o.state='succeeded' AND o.result IS NOT NULL;
    IF snap IS NULL THEN RAISE EXCEPTION 'research evidence denied'; END IF;
    IF EXISTS(SELECT 1 FROM artifact_evidence WHERE project_id<>p.id AND operation_id=(p_payload->>'operationId')::uuid) THEN RAISE EXCEPTION 'evidence already belongs to another project'; END IF;
    SELECT * INTO ev FROM artifact_evidence WHERE project_id=p.id AND operation_id=(p_payload->>'operationId')::uuid;
    IF ev.id IS NOT NULL THEN ident:=ev.id;
    ELSE
     INSERT INTO artifact_evidence(id,project_id,kind,operation_id,payload,content_hash) VALUES(ident,p.id,'supplier',(p_payload->>'operationId')::uuid,
      jsonb_build_object('projection','research-result','result',snap,'license','unknown'),artifact_hash(snap));
    END IF;
   ELSE
    IF p_payload->>'supersedes' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifact_evidence WHERE id=(p_payload->>'supersedes')::uuid AND project_id=p.id) THEN RAISE EXCEPTION 'evidence denied'; END IF;
    IF char_length(p_payload->>'body') NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'invalid evidence'; END IF;
    snap:=jsonb_build_object('text',p_payload->>'body','observedAt',p_payload->'observedAt','cost',NULL,'license','unknown');
    INSERT INTO artifact_evidence(id,project_id,kind,supersedes,payload,content_hash) VALUES(ident,p.id,CASE WHEN p_payload->>'supersedes' IS NULL THEN 'user' ELSE 'revision' END,(p_payload->>'supersedes')::uuid,snap,artifact_hash(snap));
   END IF;
   INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ident) ON CONFLICT DO NOTHING;
   response:=jsonb_build_object('evidenceId',ident);
  ELSIF p_action='restrictEvidence' THEN
   SELECT * INTO ev FROM artifact_evidence WHERE id=(p_payload->>'evidenceId')::uuid AND project_id=p.id;
   IF NOT FOUND THEN RAISE EXCEPTION 'evidence denied'; END IF;
   -- Restrictions may only tighten. Never revive a deleted/expired record.
   UPDATE artifact_evidence_restrictions SET deleted=deleted OR (p_payload->>'deleted')::boolean,
    expires_at=CASE WHEN p_payload->>'expiresAt' IS NULL THEN expires_at ELSE least(expires_at,(p_payload->>'expiresAt')::timestamptz) END WHERE evidence_id=ev.id;
   IF NOT artifact_evidence_allowed(p.id,jsonb_build_array(ev.id)) THEN
    FOR prior IN SELECT * FROM artifact_rounds WHERE project_id=p.id AND state='draft' LOOP
     states:=prior.steps;
     FOR k,st IN SELECT * FROM jsonb_each(states) LOOP
      IF st->'evidenceIds' ? ev.id::text THEN states:=artifact_invalidate(prior.workflow,states,k); END IF;
     END LOOP;
     UPDATE artifact_rounds SET steps=states WHERE id=prior.id;
    END LOOP;
   END IF;
   response:=jsonb_build_object('evidenceId',ev.id,'restricted',true);
  ELSE RAISE EXCEPTION 'invalid artifact action'; END IF;
 END IF;
 INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response) VALUES(p.id,p_request_id,p_round_id,p_action,p_payload,response);
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION public.artifact_resource_identity(jsonb,jsonb),public.artifact_step_evidence(jsonb,jsonb,text),public.artifact_round_identity(),public.artifact_immutable(),public.artifact_hash(jsonb),public.artifact_evidence_allowed(uuid,jsonb),public.artifact_invalidate(jsonb,jsonb,text),public.artifact_validate_workflow(jsonb,jsonb),public.artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
