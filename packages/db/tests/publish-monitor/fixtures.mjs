/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Shared PUBLISH-MONITOR local DB fixtures: a member with a business and one brand account on a platform.
export const fixtureSql = `CREATE SCHEMA IF NOT EXISTS pm_test;
CREATE OR REPLACE FUNCTION pm_test.member(a uuid,plat text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE sk uuid:=gen_random_uuid();m uuid:=gen_random_uuid();rev uuid:=gen_random_uuid();p uuid:=gen_random_uuid();
 r uuid:=gen_random_uuid();v uuid:=gen_random_uuid();ac uuid:=gen_random_uuid();bus uuid:=gen_random_uuid();
BEGIN
 INSERT INTO skills(id,skill_key,content_kind) VALUES(sk,'pm-'||sk,'directory');
 INSERT INTO modules(id,title,skill_id,active) VALUES(m,'PM fixture',sk,true);
 INSERT INTO skill_revisions(id,skill_id,version,content,content_hash,published_by) VALUES(rev,sk,1,'fixture',repeat('a',64),a);
 INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
 VALUES(rev,sk,gen_random_uuid(),'{}',repeat('b',64),repeat('a',64),0,a);
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(p,a,m,sk,'source-'||p,'source title',1),(ac,a,m,sk,'account-'||ac,'account title',0);
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 VALUES(r,p,rev,repeat('b',64),'{}',repeat('c',64),repeat('d',64),'published','{}');
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) VALUES(v,p,r,1,'{}',repeat('e',64),'[]');
 INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id) VALUES(bus,a,'business',v);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) VALUES(ac,a,plat,'pm-'||ac,v,bus);
 RETURN ac;
END $$;`;

// Migrations after `from` that redefine its functions, so a reapplication check replays the chain in order.
const CHAIN = {
  '0240': ['packages/db/migrations/0265_publish_monitor_provider_cleanup.sql'],
  '0246': ['packages/db/migrations/0265_publish_monitor_provider_cleanup.sql'],
};
export const laterRedefinitions = from => CHAIN[from] ?? [];
