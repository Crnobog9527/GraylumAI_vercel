/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc} from '../erasure-b2a/cases.mjs';
import {erase} from './cases.mjs';
export async function runStrategy(db,report){
 const f=await fixture(db),g=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const account=(await db.query('SELECT account_project_id id FROM opc_items WHERE work_item_id=$1',[g.workItem])).rows[0].id;
 const registration=(await db.query('SELECT registration FROM opc_drafts WHERE project_id=$1',[g.project])).rows[0].registration;
 const drafts=[];
 for(const current of [false,true]){
  const project=randomUUID(),round=randomUUID(),request=randomUUID();
  const draft=await rpc(db,'bill2_create_draft',f.actor);
  await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind)
   VALUES($1,$2,$3,$4,'positioning')`,[project,f.actor,g.module,g.skill]);
  const session=(await db.query(`INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
   VALUES($1,$2,$3,'{}') RETURNING id`,[f.actor,{kind:'positioning_draft',draftId:draft},request])).rows[0].id;
  await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
   VALUES($1,$2,$3,$4,'{}',$5,$5,'{"private":"PENDING_STRATEGY_BODY"}')`,[round,project,g.revision,'b'.repeat(64),'c'.repeat(64)]);
  await db.query("INSERT INTO opc_drafts VALUES($1,$2,$3,$4,$5,$6,$7,'mentor')",
   [draft,f.actor,project,round,session,request,registration]);
  await db.query(`INSERT INTO opc_account_strategy_drafts(account_project_id,draft_id,actor_id,
   root_source_version_id,base_source_version_id,base_account_revision,current) VALUES($1,$2,$3,$4,$4,0,$5)`,
   [account,draft,f.actor,g.version,current]);
  drafts.push({project,round,draft,request});
 }
 const cache=randomUUID();
 await db.query('INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES($1,$2,$3,$4)',
  [f.actor,cache,{accountProjectId:account,edits:{private:'PRIVATE_STRATEGY_EDIT'}},{draftId:drafts[1].draft}]);
 const scope=await rpc(db,'content_erasure_scope',f.actor,'artifact',account);
 for(const d of drafts)assert.ok(scope.projects.includes(d.project),'linked current and historical strategy projects included');
 await erase(db,f,'artifact',account);
 for(const d of drafts){
  const row=(await db.query('SELECT steps,erased_at FROM artifact_rounds WHERE id=$1',[d.round])).rows[0];
  assert.equal(row.steps,null);assert.ok(row.erased_at);
  await assert.rejects(rpc(db,'opc_query',f.actor,d.draft),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'opc_account_strategy_begin',f.actor,account,d.request),/CONTENT_ERASED/);
 }
 for(const method of ['opc_account_strategy_history','opc_account_strategy_schema'])
  await assert.rejects(rpc(db,method,f.actor,account),/CONTENT_ERASED/);
 await assert.rejects(rpc(db,'opc_account_strategy_begin',f.actor,account,randomUUID()),/CONTENT_ERASED/);
 await assert.rejects(rpc(db,'opc_account_strategy_save',f.actor,account,cache,g.version,drafts[1].draft,{private:'EDIT'}),/CONTENT_ERASED/);
 await assert.rejects(rpc(db,'opc_account_strategy_save_checked',f.actor,account,cache,g.version,drafts[1].draft,
  registration,{private:'EDIT'},{}),/CONTENT_ERASED/);
 const cached=(await db.query('SELECT payload,result FROM opc_library_requests WHERE request_id=$1',[cache])).rows[0];
 assert.equal(cached.payload,null);assert.equal(cached.result,null);
 await assert.rejects(db.query('UPDATE opc_account_strategy_drafts SET current=false WHERE draft_id=$1',[drafts[1].draft]),/CONTENT_ERASED/);
 assert.equal((await erase(db,f,'artifact',account)).alreadyDeleted,true);
 assert.match(JSON.stringify((await db.query('SELECT report FROM artifact_versions WHERE id=$1',[g.version])).rows[0]),/D7_SOURCE_BODY/);
 assert.equal((await db.query('SELECT body FROM opc_content_versions WHERE id=$1',[g.content])).rows[0].body,'D7_INDEPENDENT_SAVED_BODY');
 report.checks.push('account strategy drafts and edit caches scrubbed; all strategy entrypoints and late binding writes denied; shared source and independent work retained');
}
