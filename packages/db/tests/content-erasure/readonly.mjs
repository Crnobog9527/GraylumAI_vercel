/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0249: after its conversation is deleted, a positioning draft is read-only (Owner 2026-10-14), can be
// deleted as a whole, and is covered by account erasure.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,closeAccount} from '../erasure-b2a/cases.mjs';

const draftOf=async(db,a)=>(await db.query('SELECT draft_id,session_id,project_id,round_id FROM opc_drafts WHERE actor_id=$1 ORDER BY draft_id',[a])).rows;
const listed=async(db,a)=>(await rpc(db,'opc_query',a,null)).drafts;
const deleteConversation=(db,a,session)=>rpc(db,'content_erasure_mark_session',a,session);

// A positioning draft shaped like a real one (one step with one field), on the fixture's skill.
// `confirmed` decides whether the field was confirmed by the user.
async function draftWith(db,a,base,confirmed){
 const p=randomUUID(),r=randomUUID();
 const src=(await db.query('SELECT module_id,skill_id FROM artifact_projects WHERE id=$1',[base.project_id])).rows[0];
 const rev=(await db.query('SELECT revision_id FROM artifact_rounds WHERE id=$1',[base.round_id])).rows[0].revision_id;
 await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
  VALUES($1::uuid,$2,$3,$4,'readonly-'||$1::text,'positioning draft',0)`,[p,a,src.module_id,src.skill_id]);
 const workflow={steps:[{id:'s',information:[{id:'goal'}]}]};
 const steps=confirmed?{s:{version:1,valid:false,information:{goal:{value:'KEEP_CONFIRMED',status:'confirmed',nature:'fact'}},
  fieldMeta:{goal:{source:'manual'}}}}:{};
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
  VALUES($1,$2,$3,$4,$5,$6,$6,'draft',$7)`,[r,p,rev,'b'.repeat(64),workflow,'c'.repeat(64),steps]);
 const d=(await db.query('SELECT bill2_create_draft($1) v',[a])).rows[0].v;
 const sid=(await db.query(`INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
  VALUES($1,jsonb_build_object('kind','positioning_draft','draftId',$2::uuid),gen_random_uuid(),'{}') RETURNING id`,[a,d])).rows[0].id;
 await db.query(`INSERT INTO opc_drafts SELECT $1,$2,$3,$4,$5,gen_random_uuid(),registration,'mentor' FROM opc_drafts WHERE draft_id=$6`,
  [d,a,p,r,sid,base.draft_id]);
 await db.query('INSERT INTO opc_draft_businesses SELECT $1,business_id FROM opc_draft_businesses WHERE draft_id=$2',[d,base.draft_id]);
 return {draft_id:d,session_id:sid,project_id:p,round_id:r};
}
async function drafts(db,a){
 await db.query('SELECT d7_test.artifacts($1)',[a]);
 const [base]=await draftOf(db,a);
 // The stock fixture draft has no readable workflow; it only lends its business and registration.
 return base;
}

export async function runReadonly({db,report}){
 const f=await fixture(db);
 const base=await drafts(db,f.actor);
 const confirmed=await draftWith(db,f.actor,base,true);
 const empty=await draftWith(db,f.actor,base,false);
 // Words from the conversation (a question and a reply) that must never come back through the read-only draft.
 await db.query(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision,state,result)
  VALUES($1,$2,gen_random_uuid(),'{"input":"READONLY_PRIVATE_QUESTION","role":"skill"}',0,'completed','{"body":"READONLY_PRIVATE_REPLY"}')`,
  [f.actor,confirmed.session_id]);
 const before=await rpc(db,'opc_query',f.actor,confirmed.draft_id);
 assert.equal(before.conversationDeleted,false);
 assert.deepEqual((await listed(db,f.actor)).map(x=>x.draftId).filter(id=>id!==base.draft_id).sort(),
  [confirmed.draft_id,empty.draft_id].sort());

 // Delete both conversations (draft-bound: the full cleanup runs in the same call).
 await deleteConversation(db,f.actor,confirmed.session_id);
 await deleteConversation(db,f.actor,empty.session_id);
 const after=await rpc(db,'opc_query',f.actor,confirmed.draft_id);
 assert.equal(after.conversationDeleted,true,'read-only, not refused');
 assert.equal(after.draftId,confirmed.draft_id);assert.ok(after.snapshot,'confirmed work is still readable');
 assert.doesNotMatch(JSON.stringify(after),/READONLY_PRIVATE_(QUESTION|REPLY)/,'nothing said in the deleted conversation comes back');
 const list=(await listed(db,f.actor)).filter(x=>x.draftId!==base.draft_id);
 assert.ok(list.every(x=>'topicSessionId' in x),'entries carry the topic workspace session (null without one)');
 assert.deepEqual(list.map(x=>[x.draftId,x.conversationDeleted]),[[confirmed.draft_id,true]],
  'confirmed draft listed as read-only; the one with nothing confirmed is hidden');
 assert.equal(await rpc(db,'bill2_scope_allowed',f.actor,{kind:'positioning_draft',draftId:confirmed.draft_id}),false,
  'no new writes or model calls');
 const other=await fixture(db);
 await assert.rejects(rpc(db,'opc_query',other.actor,confirmed.draft_id),/OPC_DENIED/);
 // Every draft write refuses the read-only draft on the server, including those without a scope check.
 const id=randomUUID(),v=randomUUID();
 for(const [name,args] of [
  ['opc_save_plan',[f.actor,confirmed.draft_id,id,0,v,[]]],
  ['opc_handoff_b1',[f.actor,confirmed.draft_id,id,id,[]]],
  ['opc_handoff',[f.actor,confirmed.draft_id,id,id,[]]],
  ['opc_adopt_topics',[f.actor,confirmed.draft_id,id,0,v,[],[]]],
  ['opc_revise',[f.actor,confirmed.draft_id,id,confirmed.round_id]],
  ['opc_save_result',[f.actor,confirmed.draft_id,id,'s',id]],
  ['opc_topic_bind',[f.actor,confirmed.draft_id,id,v]],
  ['opc_topic_consent',[f.actor,confirmed.draft_id,v]],
  ['opc_topic_draft_save',[f.actor,confirmed.draft_id,id,0,v,[]]],
  ['opc_topic_material',[f.actor,confirmed.draft_id,id,'x']],
 ]){
  await assert.rejects(rpc(db,name,...args.map(x=>Array.isArray(x)?JSON.stringify(x):x)),/CONTENT_ERASED/,name);
 }
 report.checks.push('conversation deleted: confirmed draft read-only and listed; empty draft hidden; every draft write refused; other account denied');

 // A draft attached to an account (the fixture's base draft is its account's strategy) leaves the account
 // row once its conversation is deleted and shows up in the list as read-only, where it can be deleted whole.
 const strategyOf=async()=>(await rpc(db,'opc_library',f.actor,'',null,null)).businesses.flatMap(b=>b.accounts)
  .map(account=>account.strategyDraftId);
 assert.ok((await strategyOf()).includes(base.draft_id),'fixture: base draft is an account strategy');
 await deleteConversation(db,f.actor,base.session_id);
 assert.ok(!(await strategyOf()).includes(base.draft_id),'no longer attached to the account row');
 assert.ok((await listed(db,f.actor)).some(x=>x.draftId===base.draft_id&&x.conversationDeleted),'listed as read-only');
 report.checks.push('an account-attached draft moves to the list as read-only after its conversation is deleted');

 // The read-only draft can be deleted as a whole through the existing work deletion.
 const preview=await rpc(db,'content_erasure_preview',f.actor,'artifact',confirmed.project_id);
 await rpc(db,'content_erasure_confirm',f.actor,'artifact',confirmed.project_id,preview.previewHash);
 await assert.rejects(rpc(db,'opc_query',f.actor,confirmed.draft_id),/CONTENT_ERASED/);
 assert.deepEqual((await listed(db,f.actor)).filter(x=>x.draftId!==base.draft_id),[],'nothing left in the list');
 const round=(await db.query('SELECT steps,erased_at FROM artifact_rounds WHERE id=$1',[confirmed.round_id])).rows[0];
 assert.ok(round.erased_at);assert.equal(round.steps,null);
 report.checks.push('read-only draft deleted as a whole: unreadable, gone from the list, confirmed content cleared');

 // Account erasure also covers a draft left read-only.
 const g=await fixture(db);
 const kept=await draftWith(db,g.actor,await drafts(db,g.actor),true);
 await deleteConversation(db,g.actor,kept.session_id);
 assert.equal((await rpc(db,'opc_query',g.actor,kept.draft_id)).conversationDeleted,true);
 await closeAccount(db,g);
 await rpc(db,'account_erasure_scrub_runtime',g.actor);
 await rpc(db,'account_erasure_scrub_content',g.actor);
 const scrubbed=(await db.query('SELECT steps,erased_at FROM artifact_rounds WHERE id=$1',[kept.round_id])).rows[0];
 assert.ok(scrubbed.erased_at,'account erasure clears the read-only draft');assert.equal(scrubbed.steps,null);
 await assert.rejects(rpc(db,'opc_query',g.actor,kept.draft_id),/./);
 report.checks.push('account erasure clears a read-only draft');
}
