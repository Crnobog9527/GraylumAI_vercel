/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Local-first OPC business bindings. No provider enablement or remote seeds.
BEGIN;
ALTER TABLE artifact_projects DROP CONSTRAINT IF EXISTS artifact_projects_work_kind_check;
ALTER TABLE artifact_projects ADD CONSTRAINT artifact_projects_work_kind_check CHECK(work_kind IN ('legacy','script','positioning','account','result'));
CREATE TABLE IF NOT EXISTS opc_drafts (
 draft_id uuid PRIMARY KEY REFERENCES bill2_drafts(id), actor_id uuid NOT NULL REFERENCES profiles(id),
 project_id uuid NOT NULL UNIQUE REFERENCES artifact_projects(id), round_id uuid NOT NULL UNIQUE REFERENCES artifact_rounds(id) DEFERRABLE INITIALLY DEFERRED,
 session_id uuid NOT NULL UNIQUE REFERENCES runtime_sessions(id), request_id uuid NOT NULL,
 registration text NOT NULL REFERENCES artifact_workflows(id), mode text NOT NULL CHECK(mode IN ('mentor','manual')),
 UNIQUE(actor_id,request_id)
);
CREATE TABLE IF NOT EXISTS opc_turns (
 token uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid NOT NULL REFERENCES opc_drafts(draft_id),
 session_id uuid NOT NULL REFERENCES runtime_sessions(id),request_id uuid NOT NULL,
 round_id uuid NOT NULL REFERENCES artifact_rounds(id),step_id text NOT NULL,purpose text NOT NULL CHECK(purpose IN ('step','mentor','plan')),
 material_revision bigint NOT NULL,input_hash text NOT NULL,UNIQUE(session_id,request_id),
 FOREIGN KEY(session_id,material_revision) REFERENCES runtime_scope_material(session_id,revision)
);
ALTER TABLE opc_turns DROP CONSTRAINT IF EXISTS opc_turns_purpose_check;
ALTER TABLE opc_turns ADD CONSTRAINT opc_turns_purpose_check CHECK(purpose IN ('step','mentor','plan'));
ALTER TABLE opc_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_turns FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_turns;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_turns FOR EACH ROW EXECUTE FUNCTION artifact_immutable();
CREATE TABLE IF NOT EXISTS opc_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid NOT NULL REFERENCES opc_drafts(draft_id),
 version bigint NOT NULL CHECK(version>0),source_version_id uuid NOT NULL REFERENCES artifact_versions(id),
 request_id uuid NOT NULL,request jsonb NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(draft_id,version),UNIQUE(draft_id,request_id),CHECK(octet_length(body::text)<=64000)
);
CREATE TABLE IF NOT EXISTS opc_accounts (
 project_id uuid PRIMARY KEY REFERENCES artifact_projects(id),actor_id uuid NOT NULL REFERENCES profiles(id),
 platform text NOT NULL CHECK(platform ~ '^[a-z0-9_-]{1,32}$'),account_key text NOT NULL CHECK(account_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
 source_version_id uuid NOT NULL REFERENCES artifact_versions(id),revision bigint NOT NULL DEFAULT 1,
 UNIQUE(actor_id,platform,account_key)
);
CREATE TABLE IF NOT EXISTS opc_items (
 work_item_id uuid PRIMARY KEY REFERENCES artifact_projects(id),plan_id uuid NOT NULL REFERENCES opc_plans(id),
 item_key uuid NOT NULL,account_project_id uuid NOT NULL REFERENCES opc_accounts(project_id),
 source_version_id uuid NOT NULL REFERENCES artifact_versions(id),brief text NOT NULL,day date NOT NULL,
 UNIQUE(plan_id,item_key)
);
CREATE TABLE IF NOT EXISTS opc_handoffs (
 actor_id uuid NOT NULL REFERENCES profiles(id),request_id uuid NOT NULL,draft_id uuid NOT NULL REFERENCES opc_drafts(draft_id),
 payload jsonb NOT NULL,result jsonb NOT NULL,PRIMARY KEY(actor_id,request_id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['opc_drafts','opc_plans','opc_accounts','opc_items','opc_handoffs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['opc_drafts','opc_plans','opc_items','opc_handoffs'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS artifact_immutable ON %I',t);
  EXECUTE format('CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION artifact_immutable()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION opc_source_allowed(a uuid,v_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v artifact_versions;p artifact_projects;r artifact_rounds;
BEGIN
 SELECT * INTO v FROM artifact_versions WHERE id=v_id;
 SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a;
 SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND state='published';
 IF p.id IS NULL OR r.id IS NULL OR NOT artifact_evidence_allowed(p.id,v.evidence_ids) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM opc_drafts d JOIN bill2_drafts b ON b.id=d.draft_id WHERE d.project_id=p.id AND b.revoked) THEN RETURN false;END IF;
 PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $$;
-- Only persisted draft bindings allow social results before an account exists.
CREATE OR REPLACE FUNCTION artifact_round_account_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p artifact_projects;
BEGIN
 IF NEW.workflow->>'kind'='social' THEN
  SELECT * INTO p FROM artifact_projects WHERE id=NEW.project_id;
  IF p.work_kind='positioning' AND EXISTS(SELECT 1 FROM opc_drafts d JOIN bill2_drafts b ON b.id=d.draft_id
   JOIN runtime_sessions s ON s.id=d.session_id WHERE d.project_id=p.id AND d.round_id=NEW.id AND d.actor_id=p.actor_id
   AND NOT b.revoked AND b.actor_id=p.actor_id AND s.actor_id=p.actor_id AND s.scope=jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RETURN NEW;END IF;
  PERFORM 1 FROM artifact_accounts WHERE actor_id=p.actor_id AND module_id=p.module_id AND skill_id=p.skill_id AND account=p.account FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact account denied' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION opc_start(p_actor_id uuid,p_request_id uuid,p_registration text,p_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;w artifact_workflows;descriptor jsonb;binding jsonb;states jsonb;project uuid:=gen_random_uuid();round uuid:=gen_random_uuid();
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_mode NOT IN ('mentor','manual') THEN RAISE EXCEPTION 'OPC_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN
  IF d.registration<>p_registration OR d.mode<>p_mode THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM runtime_sessions WHERE actor_id=p_actor_id AND start_request_id=p_request_id) THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  SELECT * INTO w FROM artifact_workflows WHERE id=p_registration AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPC_REGISTRATION';END IF;
  descriptor:=read_skill_package(p_actor_id,w.module_id,w.skill_id,w.revision_id,NULL,NULL);
  PERFORM artifact_validate_workflow(w.workflow,descriptor);
  PERFORM opc_information_schema(w.workflow);
  binding:=runtime_start(p_actor_id,p_request_id,jsonb_build_object('scope',jsonb_build_object('kind','positioning_draft')));
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind) VALUES(project,p_actor_id,w.module_id,w.skill_id,'positioning');
  INSERT INTO opc_drafts VALUES((binding->'scope'->>'draftId')::uuid,p_actor_id,project,round,(binding->>'sessionId')::uuid,p_request_id,p_registration,p_mode) RETURNING * INTO d;
  SELECT jsonb_object_agg(x->>'id',jsonb_build_object('body','','version',0,'reviewVersion',0,'evidenceIds','[]'::jsonb,'provenanceIds','[]'::jsonb,'confirmationId',NULL,'valid',false)) INTO states FROM jsonb_array_elements(w.workflow->'steps') x;
  INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
   VALUES(round,project,w.revision_id,descriptor->>'packageHash',w.workflow,artifact_hash(w.workflow),artifact_hash(w.workflow->'report'),states);
 END IF;
 RETURN jsonb_build_object('draftId',d.draft_id,'projectId',d.project_id,'roundId',d.round_id,'sessionId',d.session_id);
END $$;
CREATE OR REPLACE FUNCTION opc_save_plan(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;p opc_plans;n bigint;req jsonb;item jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 req:=jsonb_build_object('expectedVersion',p_expected_version,'sourceVersionId',p_source_version_id,'body',p_body);
 SELECT * INTO p FROM opc_plans WHERE draft_id=d.draft_id AND request_id=p_request_id;
 IF FOUND THEN
  IF p.request<>req THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 ELSE
  IF p_request_id IS NULL OR NOT opc_source_allowed(p_actor_id,p_source_version_id) OR NOT EXISTS(SELECT 1 FROM artifact_versions WHERE id=p_source_version_id AND project_id=d.project_id) THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
  SELECT coalesce(max(version),0) INTO n FROM opc_plans WHERE draft_id=d.draft_id;
  IF n IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR jsonb_array_length(p_body) NOT BETWEEN 1 AND 28 OR octet_length(p_body::text)>64000 THEN RAISE EXCEPTION 'OPC_PLAN_INVALID';END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_body) LOOP
   IF item-ARRAY['id','platform','account','title','brief','day']<>'{}' OR (item->>'id')::uuid IS NULL
    OR coalesce(item->>'platform','')!~'^[a-z0-9_-]{1,32}$' OR coalesce(item->>'account','')!~'^[a-z0-9][a-z0-9._:-]{0,127}$'
    OR char_length(coalesce(item->>'title','')) NOT BETWEEN 1 AND 160 OR char_length(coalesce(item->>'brief','')) NOT BETWEEN 1 AND 2000
    OR (item->>'day')::date IS NULL THEN RAISE EXCEPTION 'OPC_PLAN_INVALID';END IF;
  END LOOP;
  IF jsonb_array_length(p_body)<>(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_body) x) THEN RAISE EXCEPTION 'OPC_DUPLICATE_ITEM';END IF;
  INSERT INTO opc_plans(draft_id,version,source_version_id,request_id,request,body) VALUES(d.draft_id,n+1,p_source_version_id,p_request_id,req,p_body) RETURNING * INTO p;
 END IF;
 RETURN jsonb_build_object('planId',p.id,'version',p.version);
END $$;
-- A target account uses an optimistic expected revision; null means create only.
CREATE OR REPLACE FUNCTION opc_handoff(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_plan_id uuid,p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;p opc_plans;h opc_handoffs;ac opc_accounts;v artifact_versions;src artifact_projects;item jsonb;target jsonb;req jsonb;result jsonb:='[]';wid uuid;binding jsonb;olditem opc_items;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text,107));
 req:=jsonb_build_object('draftId',p_draft_id,'planId',p_plan_id,'accounts',p_accounts);
 SELECT * INTO h FROM opc_handoffs WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN IF h.payload<>req THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN h.result;END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO src FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO p FROM opc_plans WHERE id=p_plan_id AND draft_id=d.draft_id;
 SELECT * INTO v FROM artifact_versions WHERE id=p.source_version_id AND project_id=d.project_id;
 IF p.id IS NULL OR NOT opc_source_allowed(p_actor_id,v.id) OR v.version<>src.current_version
  OR p.version<>(SELECT max(version) FROM opc_plans WHERE draft_id=d.draft_id) THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 IF jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_accounts) NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'OPC_ACCOUNTS_INVALID';END IF;
 IF jsonb_array_length(p_accounts)<>(SELECT count(DISTINCT (x->>'platform',x->>'account')) FROM jsonb_array_elements(p_accounts) x)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.body) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) t WHERE t->>'platform'=x->>'platform' AND t->>'account'=x->>'account')) THEN RAISE EXCEPTION 'OPC_ACCOUNTS_INVALID';END IF;
 FOR target IN SELECT * FROM jsonb_array_elements(p_accounts) ORDER BY value->>'platform',value->>'account' LOOP
  IF target-ARRAY['platform','account','expectedRevision']<>'{}' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.body) x WHERE x->>'platform'=target->>'platform' AND x->>'account'=target->>'account') THEN RAISE EXCEPTION 'OPC_ACCOUNTS_INVALID';END IF;
  SELECT * INTO ac FROM opc_accounts WHERE actor_id=p_actor_id AND platform=target->>'platform' AND account_key=target->>'account' FOR UPDATE;
  IF ac.project_id IS NULL THEN
   IF target->>'expectedRevision' IS NOT NULL THEN RAISE EXCEPTION 'OPC_ACCOUNT_CONFLICT';END IF;
   INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,work_title) VALUES(gen_random_uuid(),p_actor_id,src.module_id,src.skill_id,'account',target->>'account') RETURNING id INTO ac.project_id;
   INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id) VALUES(ac.project_id,p_actor_id,target->>'platform',target->>'account',v.id) RETURNING * INTO ac;
  ELSE
   IF ac.revision IS DISTINCT FROM (target->>'expectedRevision')::bigint THEN RAISE EXCEPTION 'OPC_ACCOUNT_CONFLICT';END IF;
   UPDATE opc_accounts SET source_version_id=v.id,revision=revision+1 WHERE project_id=ac.project_id RETURNING * INTO ac;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p.body) x WHERE x->>'platform'=ac.platform AND x->>'account'=ac.account_key LOOP
   SELECT * INTO olditem FROM opc_items WHERE plan_id=p.id AND item_key=(item->>'id')::uuid;
   IF olditem.work_item_id IS NULL THEN
    wid:=gen_random_uuid();
    INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id,work_title) VALUES(wid,p_actor_id,src.module_id,src.skill_id,'script',ac.project_id,item->>'title');
    INSERT INTO opc_items VALUES(wid,p.id,(item->>'id')::uuid,ac.project_id,v.id,item->>'brief',(item->>'day')::date);
    binding:=runtime_start(p_actor_id,wid,jsonb_build_object('scope',jsonb_build_object('kind','work_item','projectId',ac.project_id,'workItemId',wid)));
    PERFORM runtime_material(p_actor_id,(binding->>'sessionId')::uuid,'save',wid,0,jsonb_build_object('brief',item->>'brief','material',opc_profile(v.id)::text,'roundId',NULL));
   ELSE
    wid:=olditem.work_item_id;
    SELECT jsonb_build_object('sessionId',id) INTO binding FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',ac.project_id,'workItemId',wid);
   END IF;
   result:=result||jsonb_build_array(jsonb_build_object('projectId',ac.project_id,'workItemId',wid,'sessionId',binding->>'sessionId','itemId',item->>'id'));
  END LOOP;
 END LOOP;
 INSERT INTO opc_handoffs VALUES(p_actor_id,p_request_id,d.draft_id,req,result);
 RETURN result;
END $$;
DO $$ BEGIN
 IF to_regprocedure('bill2_scope_allowed_before_opc(uuid,jsonb)') IS NULL THEN ALTER FUNCTION bill2_scope_allowed(uuid,jsonb) RENAME TO bill2_scope_allowed_before_opc;END IF;
END $$;
CREATE OR REPLACE FUNCTION bill2_scope_allowed(a uuid,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT bill2_scope_allowed_before_opc(a,s) OR (s->>'kind'='work_item' AND NOT(s?'draftId') AND EXISTS(
 SELECT 1 FROM opc_items i JOIN artifact_projects w ON w.id=i.work_item_id JOIN opc_accounts ac ON ac.project_id=i.account_project_id
 WHERE w.id=(s->>'workItemId')::uuid AND ac.project_id=(s->>'projectId')::uuid AND w.source_project_id=ac.project_id
 AND w.actor_id=a AND ac.actor_id=a AND opc_source_allowed(a,i.source_version_id)))
$$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure sig,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'opc_%' OR proname IN ('bill2_scope_allowed','bill2_scope_allowed_before_opc','artifact_round_account_guard')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  IF f.proname IN ('opc_start','opc_save_plan','opc_handoff') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_draft_id IS NULL THEN
  RETURN jsonb_build_object('drafts',(SELECT coalesce(jsonb_agg(jsonb_build_object('draftId',draft_id,'sessionId',session_id,'projectId',project_id,'roundId',round_id,'mode',mode)),'[]') FROM opc_drafts WHERE actor_id=p_actor_id AND NOT EXISTS(SELECT 1 FROM bill2_drafts b WHERE b.id=opc_drafts.draft_id AND b.revoked)),
   'accounts',(SELECT coalesce(jsonb_agg(jsonb_build_object('projectId',ac.project_id,'platform',platform,'account',account_key,'revision',revision,'sourceVersionId',ac.source_version_id,'profile',CASE WHEN opc_source_allowed(p_actor_id,ac.source_version_id) THEN opc_profile(ac.source_version_id) ELSE NULL END,
    'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',w.work_title,'day',i.day,'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN i.brief ELSE NULL END,'sessionId',ss.id)),'[]') FROM opc_items i JOIN artifact_projects w ON w.id=i.work_item_id JOIN runtime_sessions ss ON ss.actor_id=p_actor_id AND ss.scope=jsonb_build_object('kind','work_item','projectId',ac.project_id,'workItemId',i.work_item_id) WHERE i.account_project_id=ac.project_id))),'[]') FROM opc_accounts ac WHERE actor_id=p_actor_id));
 END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 result:=artifact_query(p_actor_id,'read',d.project_id,d.round_id);
 RETURN jsonb_build_object('draftId',d.draft_id,'sessionId',d.session_id,'projectId',d.project_id,'roundId',d.round_id,'mode',d.mode,'snapshot',result,'information',(SELECT jsonb_object_agg(x->>'id',jsonb_build_object('schema',x->'information','values',r.steps->(x->>'id')->'information')) FROM artifact_rounds r,jsonb_array_elements(r.workflow->'steps') x WHERE r.id=d.round_id),
 'turns',(SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'stepId',t.step_id,'kind',CASE WHEN t.purpose='plan' THEN 'plan' WHEN e.payload->'request'->'organizeAfter'='true'::jsonb THEN 'organizer' ELSE 'mentor' END) ORDER BY e.created_at,e.id),'[]') FROM opc_turns t JOIN runtime_executions e ON e.session_id=t.session_id AND e.request_id=t.request_id AND e.actor_id=p_actor_id WHERE t.draft_id=d.draft_id AND t.session_id=d.session_id),
 'report',artifact_transition(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),'report',d.project_id,d.round_id),
 'plans',(SELECT coalesce(jsonb_agg(jsonb_build_object('planId',id,'version',version,'sourceVersionId',source_version_id,'body',CASE WHEN opc_source_allowed(p_actor_id,source_version_id) THEN body ELSE NULL END) ORDER BY version DESC),'[]') FROM opc_plans WHERE draft_id=d.draft_id),
 'handoffs',(SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'result',h.result)),'[]') FROM opc_handoffs h WHERE draft_id=d.draft_id));
END $$;
REVOKE ALL ON FUNCTION opc_query(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_query(uuid,uuid) TO service_role;
CREATE TABLE IF NOT EXISTS opc_result_links (
 evidence_id uuid PRIMARY KEY REFERENCES artifact_evidence(id),execution_id uuid NOT NULL REFERENCES runtime_executions(id),
 round_id uuid NOT NULL REFERENCES artifact_rounds(id),step_id text NOT NULL,candidate_id uuid UNIQUE REFERENCES artifact_candidates(id),UNIQUE(execution_id,round_id,step_id)
);
ALTER TABLE opc_result_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_result_links FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_result_links;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_result_links FOR EACH ROW EXECUTE FUNCTION artifact_immutable();
DO $$ BEGIN
 IF to_regprocedure('artifact_evidence_allowed_before_opc(uuid,jsonb)') IS NULL THEN ALTER FUNCTION artifact_evidence_allowed(uuid,jsonb) RENAME TO artifact_evidence_allowed_before_opc;END IF;
END $$;
CREATE OR REPLACE FUNCTION artifact_evidence_allowed(project uuid,ids jsonb) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS $$
 SELECT artifact_evidence_allowed_before_opc(project,ids) AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE ids ? l.evidence_id::text AND NOT runtime_history_available(l.execution_id))
$$;
CREATE OR REPLACE FUNCTION opc_save_result(p_actor_id uuid,p_draft_id uuid,p_execution_id uuid,p_step_id text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;p artifact_projects;r artifact_rounds;e runtime_executions;link opc_result_links;ev uuid;body text;response jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO p FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 IF NOT EXISTS(SELECT 1 FROM opc_turns t WHERE t.session_id=d.session_id AND t.request_id=e.request_id AND t.token::text=e.payload->>'opcTurnToken' AND t.purpose='step' AND t.step_id=p_step_id AND t.round_id=r.id) OR d.draft_id IS NULL OR e.state IS DISTINCT FROM 'completed' OR NOT runtime_history_available(e.id)
  OR e.payload->>'revisionId' IS DISTINCT FROM r.revision_id::text OR e.payload->>'moduleId' IS DISTINCT FROM p.module_id::text
  OR e.payload->'scopeMaterial'->'content'->'work'->>'roundId' IS DISTINCT FROM r.id::text OR NOT(r.steps ? p_step_id) OR e.payload->'scopeMaterial'->'content'->>'brief' IS DISTINCT FROM 'step:'||p_step_id THEN RAISE EXCEPTION 'OPC_RESULT_DENIED';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') st,jsonb_array_elements(st->'information') f WHERE st->>'id'=p_step_id AND (f->>'required')::boolean AND coalesce(e.payload->'scopeMaterial'->'content'->'work'->'steps'->p_step_id->'information'->(f->>'id')->>'status','unknown') NOT IN ('confirmed','deferred')) THEN RAISE EXCEPTION 'OPC_INFORMATION_REQUIRED';END IF;
 -- Only this explicit host-bound step flow projects its requested organizer output.
 -- Existing Runtime result-read permissions stay unchanged; private inputs and receipts stay server-side.
 body:=CASE WHEN e.payload->'request'->'organizeAfter'='true'::jsonb AND e.payload ? 'attachedOrganizer' THEN e.result->>'summary' ELSE e.result->>'body' END;
 IF body IS NULL THEN RAISE EXCEPTION 'OPC_RESULT_PENDING';END IF;
 SELECT * INTO link FROM opc_result_links WHERE execution_id=e.id AND round_id=r.id AND step_id=p_step_id;
 IF link.evidence_id IS NULL THEN
  ev:=gen_random_uuid();
  INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES(ev,p.id,'user',jsonb_build_object('executionId',e.id),artifact_hash(e.result));
  INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);

 ELSE RETURN jsonb_build_object('candidateId',link.candidate_id);END IF;
 response:=artifact_transition(p_actor_id,p.module_id,p.skill_id,'candidate',p.id,r.id,p_request_id,jsonb_build_object('stepId',p_step_id,'body',body,'evidenceIds',jsonb_build_array(ev)));
 IF link.evidence_id IS NULL THEN INSERT INTO opc_result_links VALUES(ev,e.id,r.id,p_step_id,(response->>'candidateId')::uuid);END IF;
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION opc_save_result(uuid,uuid,uuid,text,uuid),artifact_evidence_allowed(uuid,jsonb),artifact_evidence_allowed_before_opc(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_save_result(uuid,uuid,uuid,text,uuid) TO service_role;
DO $$ BEGIN
 IF to_regprocedure('runtime_work_projection_before_opc(uuid,uuid,uuid)') IS NULL THEN ALTER FUNCTION runtime_work_projection(uuid,uuid,uuid) RENAME TO runtime_work_projection_before_opc;END IF;
END $$;
CREATE OR REPLACE FUNCTION runtime_work_projection(p_actor_id uuid,p_session_id uuid,p_round_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;v jsonb;
BEGIN
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND session_id=p_session_id AND project_id=(SELECT project_id FROM artifact_rounds WHERE id=p_round_id);
 IF NOT FOUND THEN RETURN runtime_work_projection_before_opc(p_actor_id,p_session_id,p_round_id);END IF;
 IF NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id;
 -- Read the frozen step material only. A full artifact UI query also expands
 -- candidates and would recursively authorize the result currently being checked.
 RETURN jsonb_build_object('projectId',d.project_id,'roundId',r.id,'revisionId',r.revision_id,'packageHash',r.package_hash,'steps',r.steps,'source',NULL);
END $$;
CREATE OR REPLACE FUNCTION opc_step_material(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_step_id text,p_purpose text,p_input text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;m runtime_scope_material;n bigint;r artifact_rounds;t opc_turns;result jsonb;spec jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND draft_id=p_draft_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM runtime_sessions WHERE id=d.session_id FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 IF p_purpose NOT IN ('step','mentor','plan') OR (p_purpose IN ('step','mentor') AND r.state<>'draft') OR (p_purpose='plan' AND r.state<>'published') OR NOT(r.steps?p_step_id) THEN RAISE EXCEPTION 'OPC_STEP_DENIED';END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=d.session_id AND request_id=p_request_id;
 IF FOUND THEN
  SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=p_request_id;
  IF t.token IS NULL OR t.purpose IS DISTINCT FROM p_purpose OR t.step_id IS DISTINCT FROM p_step_id OR t.input_hash IS DISTINCT FROM artifact_hash(to_jsonb(p_input)) OR m.content->>'brief' IS DISTINCT FROM p_purpose||':'||p_step_id OR m.revoked THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('revision',m.revision,'turnToken',t.token);
 END IF;
 SELECT x INTO spec FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 IF p_purpose IN ('step','mentor') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(spec->'dependsOn') dep WHERE (r.steps->dep->>'valid')::boolean IS DISTINCT FROM true) THEN RAISE EXCEPTION 'OPC_DEPENDENCIES_UNCONFIRMED';END IF;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=d.session_id;
 result:=runtime_material(p_actor_id,d.session_id,'save',p_request_id,n,jsonb_build_object('brief',p_purpose||':'||p_step_id,'material','','roundId',r.id));
 INSERT INTO opc_turns(draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash) VALUES(d.draft_id,d.session_id,p_request_id,r.id,p_step_id,p_purpose,(result->>'revision')::bigint,artifact_hash(to_jsonb(p_input))) RETURNING * INTO t;
 RETURN result||jsonb_build_object('turnToken',t.token);
END $$;
DO $$ BEGIN
 IF to_regprocedure('artifact_save_candidate_before_opc(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text)') IS NULL THEN
  ALTER FUNCTION artifact_save_candidate(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) RENAME TO artifact_save_candidate_before_opc;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION artifact_save_candidate(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_project_id uuid,p_round_id uuid,p_request_id uuid,p_step_id text,p_candidate_id uuid,p_expected_version integer,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r artifact_rounds;e runtime_executions;
BEGIN
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT ex.* INTO e FROM artifact_candidates c JOIN opc_result_links l ON c.id=l.candidate_id JOIN runtime_executions ex ON ex.id=l.execution_id WHERE c.id=p_candidate_id;
 IF e.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
  SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p_project_id;
  IF artifact_generation_basis(r.workflow,r.steps,p_step_id) IS DISTINCT FROM artifact_generation_basis(r.workflow,e.payload->'scopeMaterial'->'content'->'work'->'steps',p_step_id) THEN RAISE EXCEPTION 'candidate input changed';END IF;
 END IF;
 RETURN artifact_save_candidate_before_opc(p_actor_id,p_module_id,p_skill_id,p_project_id,p_round_id,p_request_id,p_step_id,p_candidate_id,p_expected_version,p_body);
END $$;
REVOKE ALL ON FUNCTION runtime_work_projection_before_opc(uuid,uuid,uuid),runtime_work_projection(uuid,uuid,uuid),opc_step_material(uuid,uuid,uuid,text,text,text),artifact_save_candidate_before_opc(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text),artifact_save_candidate(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_step_material(uuid,uuid,uuid,text,text,text),artifact_save_candidate(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) TO service_role;
CREATE OR REPLACE FUNCTION opc_work_result(p_actor_id uuid,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;i opc_items;p artifact_projects;r artifact_rounds;v artifact_versions;ev uuid;flow jsonb;report jsonb;chosen jsonb;m uuid;k uuid;rev uuid;descriptor jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id;
 SELECT * INTO i FROM opc_items WHERE work_item_id=(s.scope->>'workItemId')::uuid;
 IF i.work_item_id IS NULL OR e.state IS DISTINCT FROM 'completed' OR NOT runtime_history_available(e.id) OR e.result->>'body' IS NULL THEN RAISE EXCEPTION 'OPC_RESULT_DENIED';END IF;
 SELECT c INTO chosen FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key';
 m:=coalesce(chosen->>'moduleId',e.payload->>'moduleId')::uuid;k:=coalesce(chosen->>'skillId',e.payload->>'skillId')::uuid;rev:=coalesce(chosen->>'revisionId',e.payload->>'revisionId')::uuid;
 IF rev IS NULL THEN RAISE EXCEPTION 'OPC_SKILL_RESULT_REQUIRED';END IF;
 descriptor:=read_skill_package(p_actor_id,m,k,rev,NULL,NULL);
 SELECT * INTO v FROM artifact_versions WHERE id=e.id;
 IF v.id IS NULL THEN
  -- A result container is not another project/work item or Session. Reuse the
  -- existing immutable artifact/version body store without inventing Skill steps.
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id,work_title,current_version)
   VALUES(e.id,p_actor_id,m,k,'result',i.work_item_id,'Skill 成果',1);
  flow:=jsonb_build_object('id','runtime-result','version',1,'kind','document','steps','[]'::jsonb,'report',jsonb_build_object('id','result','version',1,'title','Skill 成果','sections','[]'::jsonb));
  INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
   VALUES(e.id,e.id,rev,descriptor->>'packageHash',flow,artifact_hash(flow),artifact_hash(flow->'report'),'published','{}');
  ev:=gen_random_uuid();INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES(ev,e.id,'user',jsonb_build_object('executionId',e.id),artifact_hash(e.result));
  INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
  INSERT INTO opc_result_links VALUES(ev,e.id,e.id,'result',NULL);
  report:=jsonb_build_object('title','Skill 成果','sections',jsonb_build_array(jsonb_build_object('title','正文','stepId','result','body',e.result->>'body')),'executionId',e.id);
  INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) VALUES(e.id,e.id,e.id,1,report,artifact_hash(report),jsonb_build_array(ev)) RETURNING * INTO v;
 END IF;
 RETURN jsonb_build_object('artifactId',v.id,'version',v.version);
END $$;
CREATE OR REPLACE FUNCTION opc_work_results(p_actor_id uuid,p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT bill2_scope_allowed(p_actor_id,s.scope) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('artifactId',v.id,'version',v.version,'body',CASE WHEN artifact_evidence_allowed(v.project_id,v.evidence_ids) THEN v.report->'sections'->0->>'body' ELSE NULL END) ORDER BY v.created_at),'[]') FROM artifact_versions v JOIN runtime_executions e ON e.id=v.id WHERE e.session_id=s.id);
END $$;
REVOKE ALL ON FUNCTION opc_work_result(uuid,uuid),opc_work_results(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_work_result(uuid,uuid),opc_work_results(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION opc_plan_result(p_actor_id uuid,p_draft_id uuid,p_execution_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;e runtime_executions;r artifact_rounds;v artifact_versions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id AND state='published';
 SELECT * INTO v FROM artifact_versions WHERE round_id=r.id;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 IF NOT EXISTS(SELECT 1 FROM opc_turns t WHERE t.session_id=d.session_id AND t.request_id=e.request_id AND t.token::text=e.payload->>'opcTurnToken' AND t.purpose='plan' AND t.round_id=r.id) OR e.payload->'scopeMaterial'->'content'->>'brief' NOT LIKE 'plan:%' OR v.id IS NULL OR e.state IS DISTINCT FROM 'completed' OR NOT runtime_history_available(e.id) OR NOT opc_source_allowed(p_actor_id,v.id)
 OR e.payload->>'revisionId' IS DISTINCT FROM r.revision_id::text OR e.payload->'scopeMaterial'->'content'->'work'->>'roundId' IS DISTINCT FROM r.id::text THEN RAISE EXCEPTION 'OPC_RESULT_DENIED';END IF;
 RETURN jsonb_build_object('sourceVersionId',v.id,'body',e.result->>'body');
END $$;
REVOKE ALL ON FUNCTION opc_plan_result(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_plan_result(uuid,uuid,uuid) TO service_role;
DO $$ BEGIN
 IF to_regprocedure('runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)') IS NULL THEN ALTER FUNCTION runtime_direct_billing_allowed(uuid,jsonb,uuid) RENAME TO runtime_direct_billing_allowed_before_opc;END IF;
END $$;
CREATE OR REPLACE FUNCTION runtime_direct_billing_allowed(a uuid,p jsonb,p_run_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;ap artifact_projects;r artifact_rounds;
BEGIN
 PERFORM runtime_direct_billing_allowed_before_opc(a,p,p_run_id);
 IF p->'scope'->>'kind'='positioning_draft' THEN
  SELECT * INTO d FROM opc_drafts WHERE draft_id=(p->'scope'->>'draftId')::uuid AND actor_id=a;
  IF d.draft_id IS NOT NULL THEN
   SELECT * INTO ap FROM artifact_projects WHERE id=d.project_id;
   SELECT * INTO r FROM artifact_rounds WHERE project_id=d.project_id AND id=(p->'input'->'scopeMaterial'->'content'->'work'->>'roundId')::uuid;
   IF NOT EXISTS(SELECT 1 FROM opc_turns t WHERE t.draft_id=d.draft_id AND t.token::text=p->'input'->>'opcTurnToken' AND t.request_id::text=p->'input'->'request'->>'requestId' AND t.material_revision::text=p->'input'->'scopeMaterial'->>'revision' AND t.round_id=r.id) OR r.id IS NULL OR p->>'moduleId' IS DISTINCT FROM ap.module_id::text OR p->>'revisionId' IS DISTINCT FROM r.revision_id::text
    OR p->'input'->>'role' IS DISTINCT FROM 'skill' OR p->'input'->'scopeMaterial'->'content'->'work'->>'roundId' IS DISTINCT FROM r.id::text
   THEN RAISE EXCEPTION 'OPC_POSITIONING_SCOPE_REQUIRED';END IF;
  END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid),runtime_direct_billing_allowed(uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION opc_draft_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR to_jsonb(OLD)-'round_id' IS DISTINCT FROM to_jsonb(NEW)-'round_id' THEN RAISE EXCEPTION 'OPC_IMMUTABLE_DRAFT';END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_drafts;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_drafts FOR EACH ROW EXECUTE FUNCTION opc_draft_identity();
CREATE OR REPLACE FUNCTION opc_revise(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_round_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;req artifact_requests;new_steps jsonb;k text;st jsonb;c uuid;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR p_request_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN IF req.action<>'opc_revision' OR req.payload->>'fromRoundId' IS DISTINCT FROM p_expected_round_id::text THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN req.response;END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id AND state='published';
 IF r.id IS NULL OR r.id IS DISTINCT FROM p_expected_round_id THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 PERFORM read_skill_package(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),r.revision_id,r.package_hash,NULL);
 new_steps:=r.steps;
 UPDATE opc_drafts SET round_id=p_request_id WHERE draft_id=d.draft_id;
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
 VALUES(p_request_id,d.project_id,r.revision_id,r.package_hash,r.workflow,r.workflow_hash,r.template_hash,new_steps);
 FOR k,st IN SELECT * FROM jsonb_each(new_steps) LOOP
  IF (st->>'valid')::boolean AND artifact_evidence_allowed(d.project_id,artifact_step_evidence(r.workflow,new_steps,k)||coalesce(st->'provenanceIds','[]')) THEN
   c:=gen_random_uuid();INSERT INTO artifact_confirmations VALUES(c,p_request_id,k,(st->>'version')::int,(st->>'reviewVersion')::int,st->>'body',artifact_step_evidence(r.workflow,new_steps,k),now());
   new_steps:=jsonb_set(new_steps,ARRAY[k,'confirmationId'],to_jsonb(c));
  ELSE new_steps:=artifact_invalidate(r.workflow,new_steps,k);END IF;
 END LOOP;
 UPDATE artifact_rounds SET steps=new_steps WHERE id=p_request_id;
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,p_request_id,'opc_revision',jsonb_build_object('fromRoundId',r.id),jsonb_build_object('roundId',p_request_id));
 RETURN jsonb_build_object('roundId',p_request_id);
END $$;
REVOKE ALL ON FUNCTION opc_draft_identity(),opc_revise(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_revise(uuid,uuid,uuid,uuid) TO service_role;

DO $$ BEGIN
 IF to_regprocedure('artifact_query_before_opc(uuid,text,uuid,uuid)') IS NULL THEN ALTER FUNCTION artifact_query(uuid,text,uuid,uuid) RENAME TO artifact_query_before_opc;END IF;
END $$;
CREATE OR REPLACE FUNCTION artifact_query(p_actor_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_action='resolve' AND EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND work_kind='result') THEN RAISE EXCEPTION 'artifact result is immutable' USING ERRCODE='42501';END IF;
 result:=artifact_query_before_opc(p_actor_id,p_action,p_project_id,p_round_id);
 IF p_action='read' AND EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND work_kind='result') THEN result:=jsonb_set(result,'{workflow,steps}','[]');END IF;
 IF p_action='projects' THEN
  SELECT coalesce(jsonb_agg(x),'[]') INTO result FROM jsonb_array_elements(result) x
  WHERE NOT EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=(x->>'projectId')::uuid AND (p.work_kind IN ('positioning','account','result') OR EXISTS(SELECT 1 FROM opc_items i WHERE i.work_item_id=p.id)));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION artifact_query_before_opc(uuid,text,uuid,uuid),artifact_query(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION artifact_query(uuid,text,uuid,uuid) TO service_role;

-- Information goals and profile mapping belong to the published method. The host
-- validates state; it never promotes a model's hypothesis to a confirmed fact.
CREATE OR REPLACE FUNCTION opc_information_schema(flow jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE step jsonb;field jsonb;
BEGIN
 FOR step IN SELECT * FROM jsonb_array_elements(flow->'steps') LOOP
  IF jsonb_typeof(step->'information') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'information') NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(step->'information') x)<>jsonb_array_length(step->'information') THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
  FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
   IF coalesce(field->>'id','')!~'^[a-z][a-z0-9_-]{0,63}$' OR char_length(coalesce(field->>'title','')) NOT BETWEEN 1 AND 160 OR jsonb_typeof(field->'required') IS DISTINCT FROM 'boolean'
    OR (field?'profileKey' AND coalesce(field->>'profileKey','')!~'^[a-z][a-z0-9_-]{0,63}$') THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(flow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey') NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(flow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey')<>(SELECT count(DISTINCT f->>'profileKey') FROM jsonb_array_elements(flow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey') THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
END $$;
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
CREATE OR REPLACE FUNCTION opc_profile(version_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE r artifact_rounds;v artifact_versions;result jsonb;
BEGIN
 SELECT * INTO v FROM artifact_versions WHERE id=version_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND state='published';
 SELECT coalesce(jsonb_object_agg(f->>'profileKey',jsonb_build_object('label',f->>'title','value',r.steps->(s->>'id')->'information'->(f->>'id')->>'value','status',r.steps->(s->>'id')->'information'->(f->>'id')->>'status','nature',r.steps->(s->>'id')->'information'->(f->>'id')->>'nature','stepId',s->>'id','confirmationId',r.steps->(s->>'id')->>'confirmationId','updatedAt',r.steps->(s->>'id')->>'informationUpdatedAt','sourceVersionId',v.id,'validAtConfirmation',true)),'{}') INTO result FROM jsonb_array_elements(r.workflow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey';
 IF octet_length(result::text)>20000 THEN RAISE EXCEPTION 'OPC_PROFILE_CAPACITY';END IF;
 RETURN result;
END $$;
DO $$ BEGIN
 IF to_regprocedure('artifact_transition_before_opc(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)') IS NULL THEN ALTER FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) RENAME TO artifact_transition_before_opc;END IF;
END $$;
CREATE OR REPLACE FUNCTION artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r artifact_rounds;step jsonb;f jsonb;
BEGIN
 IF p_action IN ('confirm','publish') AND EXISTS(SELECT 1 FROM opc_drafts WHERE project_id=p_project_id) AND NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
  PERFORM 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p_project_id;
  FOR step IN SELECT * FROM jsonb_array_elements(r.workflow->'steps') x WHERE p_action='publish' OR x->>'id'=p_payload->>'stepId' LOOP
   FOR f IN SELECT * FROM jsonb_array_elements(step->'information') x WHERE (x->>'required')::boolean LOOP
    IF coalesce(r.steps->(step->>'id')->'information'->(f->>'id')->>'status','unknown') NOT IN ('confirmed','deferred') THEN RAISE EXCEPTION 'OPC_INFORMATION_REQUIRED';END IF;
   END LOOP;
  END LOOP;
 END IF;
 RETURN artifact_transition_before_opc(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION opc_information_schema(jsonb),opc_information(uuid,uuid,text,uuid,integer,jsonb),opc_profile(uuid),artifact_transition_before_opc(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_information(uuid,uuid,text,uuid,integer,jsonb),artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
