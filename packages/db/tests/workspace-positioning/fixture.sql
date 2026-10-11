/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Local-only fixtures for 0218: a published positioning with no bound account.
CREATE SCHEMA IF NOT EXISTS ws_test;
CREATE OR REPLACE FUNCTION ws_test.actor() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();
BEGIN
 INSERT INTO profiles(id,credits) VALUES(a,0);
 RETURN a;
END $$;
-- A free conversation: positioning_draft scope with no opc draft bound to it.
CREATE OR REPLACE FUNCTION ws_test.free_session(a uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
 VALUES(a,jsonb_build_object('kind','positioning_draft','draftId',bill2_create_draft(a)),gen_random_uuid(),'{}') RETURNING id INTO sid;
 RETURN sid;
END $$;
-- published=false leaves the business unconfirmed: only a draft round exists.
CREATE OR REPLACE FUNCTION ws_test.positioning(a uuid,business_name text,canary text,published boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE sk uuid:=gen_random_uuid();m uuid:=gen_random_uuid();rev uuid:=gen_random_uuid();
 p uuid:=gen_random_uuid();r uuid:=gen_random_uuid();dr uuid:=gen_random_uuid();v uuid;d uuid;sid uuid;
 bus uuid:=gen_random_uuid();reg text:='ws-'||gen_random_uuid();
 wf jsonb:='{"steps":[{"id":"s1","information":[{"id":"i1","title":"Audience","profileKey":"audience"}]}]}';
BEGIN
 INSERT INTO skills(id,skill_key,content_kind) VALUES(sk,'ws-'||sk,'directory');
 INSERT INTO modules(id,title,skill_id,active) VALUES(m,'WS fixture',sk,true);
 INSERT INTO skill_revisions(id,skill_id,version,content,content_hash,published_by) VALUES(rev,sk,1,'fixture',repeat('a',64),a);
 INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
 VALUES(rev,sk,gen_random_uuid(),'{}',repeat('b',64),repeat('a',64),0,a);
 UPDATE skills SET status='published',published_version=1,published_content='fixture',published_content_hash=repeat('a',64),published_at=now(),published_by=a WHERE id=sk;
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(p,a,m,sk,'ws-'||p,'positioning',CASE WHEN published THEN 1 ELSE 0 END);
 IF published THEN
  INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
  VALUES(r,p,rev,repeat('b',64),wf,repeat('c',64),repeat('d',64),'published',
   jsonb_build_object('s1',jsonb_build_object('information',jsonb_build_object('i1',jsonb_build_object('value',canary,'status','confirmed')))));
  v:=gen_random_uuid();
  INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
  VALUES(v,p,r,1,'{}',repeat('e',64),'[]');
 END IF;
 -- The round currently being edited: never published, never readable.
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 VALUES(dr,p,rev,repeat('b',64),wf,repeat('c',64),repeat('d',64),'draft',
  jsonb_build_object('s1',jsonb_build_object('information',jsonb_build_object('i1',jsonb_build_object('value','DRAFT_'||canary,'status','confirmed')))));
 d:=bill2_create_draft(a);
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
 VALUES(a,jsonb_build_object('kind','positioning_draft','draftId',d),gen_random_uuid(),'{}') RETURNING id INTO sid;
 INSERT INTO artifact_workflows(id,module_id,skill_id,revision_id,workflow,label) VALUES(reg,m,sk,rev,'{}','WS fixture');
 INSERT INTO opc_drafts VALUES(d,a,p,dr,sid,gen_random_uuid(),reg,'manual');
 INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id) VALUES(bus,a,business_name,v);
 INSERT INTO opc_draft_businesses VALUES(d,bus);
 RETURN jsonb_build_object('business',bus,'version',v,'draft',d,'draftSession',sid,'project',p);
END $$;
