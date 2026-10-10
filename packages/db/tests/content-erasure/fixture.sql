-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local synthetic fixture: real constraints and triggers stay enabled.
CREATE SCHEMA IF NOT EXISTS d7_test;
CREATE OR REPLACE FUNCTION d7_test.artifacts(a uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE sk uuid:=gen_random_uuid();m uuid:=gen_random_uuid();rev uuid:=gen_random_uuid();
 p uuid:=gen_random_uuid();r uuid:=gen_random_uuid();v uuid:=gen_random_uuid();
 ac uuid:=gen_random_uuid();wi uuid:=gen_random_uuid();d uuid;sid uuid;plan uuid:=gen_random_uuid();
 bus uuid:=gen_random_uuid();item uuid:=gen_random_uuid();reg text:='d7-'||gen_random_uuid();c uuid:=gen_random_uuid();
BEGIN
 INSERT INTO skills(id,skill_key,content_kind) VALUES(sk,'d7-'||sk,'directory');
 INSERT INTO modules(id,title,skill_id,active) VALUES(m,'D7 fixture',sk,true);
 INSERT INTO skill_revisions(id,skill_id,version,content,content_hash,published_by) VALUES(rev,sk,1,'fixture',repeat('a',64),a);
 INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
 VALUES(rev,sk,gen_random_uuid(),'{}',repeat('b',64),repeat('a',64),0,a);
 UPDATE skills SET status='published',published_version=1,published_content='fixture',published_content_hash=repeat('a',64),published_at=now(),published_by=a WHERE id=sk;
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(p,a,m,sk,'source-'||p,'source private title',1),(ac,a,m,sk,'account-'||ac,'account title',0),(wi,a,m,sk,'work-'||wi,'independent title',0);
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 VALUES(r,p,rev,repeat('b',64),'{}',repeat('c',64),repeat('d',64),'published','{"private":"D7_SOURCE_BODY"}');
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
 VALUES(v,p,r,1,'{"body":"D7_SOURCE_BODY"}',repeat('e',64),'[]');
 d:=bill2_create_draft(a);
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
 VALUES(a,jsonb_build_object('kind','positioning_draft','draftId',d),gen_random_uuid(),'{}') RETURNING id INTO sid;
 INSERT INTO artifact_workflows(id,module_id,skill_id,revision_id,workflow,label) VALUES(reg,m,sk,rev,'{}','D7 fixture');
 INSERT INTO opc_drafts VALUES(d,a,p,r,sid,gen_random_uuid(),reg,'manual');
 INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id) VALUES(bus,a,'business',v);
 INSERT INTO opc_draft_businesses VALUES(d,bus);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) VALUES(ac,a,'fixture','d7-'||ac,v,bus);
 INSERT INTO opc_plans(id,draft_id,version,source_version_id,request_id,request,body)
 VALUES(plan,d,1,v,gen_random_uuid(),jsonb_build_object('sourceVersionId',v),jsonb_build_array(jsonb_build_object('id',item,'contentType','video')));
 INSERT INTO opc_items(work_item_id,plan_id,item_key,account_project_id,source_version_id,brief,day)
 VALUES(wi,plan,item,ac,v,'independent brief',current_date);
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
 VALUES(a,jsonb_build_object('kind','work_item','projectId',ac,'workItemId',wi),gen_random_uuid(),'{}') RETURNING id INTO sid;
 INSERT INTO opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,request_id)
 VALUES(c,a,wi,'script',1,'final','D7_INDEPENDENT_SAVED_BODY',gen_random_uuid());
 RETURN jsonb_build_object('actor',a,'project',p,'version',v,'round',r,'workItem',wi,'session',sid,'content',c,'module',m,'revision',rev,'skill',sk);
END $$;
