/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-10b B: the topic workspace on the turn path. What a topic turn reads before it opens, and its saved reply as the source
// of the topic draft and the adoption (the page's handle is the turn's request id, as for a report): allowed and refused, repeats,
// the charge (kind=chat, metered once), and the deletion of a conversation's events and drafts.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

function helpers({c,one,open,begin,identity,record,close,policy}){
 const source=a=>one('select turn_test.topic_source($1) v',[a.actor]);
 const read=(a,src,request=randomUUID())=>one('select topic_turn_source($1,$2,$3) v',[a.actor,src.draft,request]);
 const pol=()=>policy({gCredits:30,minCredits:10,limits:{model:1,paidTools:0,freeTools:0}});
 const item=(src,over={})=>({id:randomUUID(),platform:src.platform,account:src.account,title:'AI_TITLE',brief:'AI_BRIEF',day:'2026-11-02',contentType:'article',...over});
 // One topic turn as Node runs it: opened as chat in the workspace's conversation, one paid call, both messages saved.
 const topicTurn=async(a,src,reply,{request=randomUUID(),kind='completed'}={})=>{
  const o=await open(a,{kind:'chat',session:src.topicSession,request,pol:pol()});
  await begin(a,o.turnId,1,{upper:0.05});await identity(a,o.turnId,1);await record(a,o.turnId,1,{n:0.01,actual:0.01});
  const closed=await close(a,o.turnId,kind,kind==='completed'?{messages:[{role:'user',content:'topics please'},{role:'assistant',content:reply}]}
   :{messages:[],delivered:false,refundAll:true});
  return {request,turn:o.turnId,closed};
 };
 const save=(a,src,handle,body,{request=handle,version=0}={})=>one('select opc_topic_draft_from_execution($1,$2,$3,$4,$5,$6,$7) v',
  [a.actor,src.draft,request,version,src.version,handle,JSON.stringify(body)]);
 const adopt=(a,src,body,accounts,{request=randomUUID(),expected=0,sources=null,draftVersion=null}={})=>
  one('select opc_adopt_topics_with_source($1,$2,$3,$4,$5,$6,$7,$8,$9) v',[a.actor,src.draft,request,expected,src.version,
   JSON.stringify(body),JSON.stringify(accounts),sources&&JSON.stringify(sources),draftVersion]);
 const events=a=>c.query('select * from opc_data_events where actor_id=$1 order by created_at',[a.actor]).then(r=>r.rows);
 const accounts=async(a,src)=>[{platform:src.platform,account:src.account,expectedRevision:(await c.query(
  'select revision from opc_accounts where actor_id=$1 and account_key=$2',[a.actor,src.account])).rows[0].revision}];

 return {source,read,pol,item,topicTurn,save,adopt,events,accounts};
}

export async function topicCases(t){
 const {c,one,refusal,report,balance,account,open,close}=t;
 const {source,read,pol,item,topicTurn,save,adopt,events,accounts}=helpers(t);
 // 1. topic_turn_source: what the old prepareTopicTurn checked, refused before anything is frozen.
 {
  const a=await account(1000),src=await source(a),got=await read(a,src);
  assert.equal(got.sessionId,src.topicSession);
  assert.deepEqual(got.resources,['report.md']);
  assert.equal(got.material.content.material,'CONFIRMED');
  assert.equal(got.sourceVersionId,src.version);
  const stranger=await account(1000);
  assert.match(await refusal(read(stranger,src)),/OPC_TOPIC_UNBOUND/);
  await c.query('update opc_businesses set archived_at=now() where id=$1',[src.business]);
  assert.match(await refusal(read(a,src)),/OPC_BUSINESS_ARCHIVED/);
  await c.query('update opc_businesses set archived_at=null where id=$1',[src.business]);
  await c.query('update runtime_scope_material set revoked=true where session_id=$1',[src.topicSession]);
  assert.match(await refusal(read(a,src)),/OPC_TOPIC_MATERIAL_MISSING/);
  await c.query('update runtime_scope_material set revoked=false where session_id=$1',[src.topicSession]);
  const old=randomUUID();
  await c.query(`insert into runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
   values($1,$2,$3,$4,'{}',0,'completed')`,[randomUUID(),a.actor,src.topicSession,old]);
  assert.match(await refusal(read(a,src,old)),/OPC_REQUEST_CONFLICT/);
  await c.query('update bill2_drafts set revoked=true where id=$1',[src.draft]);
  assert.match(await refusal(read(a,src)),/OPC_TOPIC_SOURCE_REVOKED/);
  assert.equal(await balance(a),1000);
  report.checks.push('topic source: bound workspace, writable, allowed source, frozen material; refused before anything is frozen');
 }
 // 2. A topic turn is one metered chat turn; the draft is saved from its reply, by its request id.
 {
  const a=await account(1000),src=await source(a),proposal=item(src);
  const reply='Here you go\n```json\n'+JSON.stringify([proposal])+'\n```';
  const {request,closed}=await topicTurn(a,src,reply);
  assert.equal(closed.chargedCredits,6,'by usage: ceil(q x n x m), once');
  assert.equal(await balance(a),994);
  const edited={...proposal,title:'USER_EDIT'};
  const first=await save(a,src,request,[edited]);
  assert.equal(first.version,1);
  assert.equal((await save(a,src,request,[edited])).version,1,'the same save again changes nothing');
  assert.equal(await balance(a),994,'saving charges nothing');
  const [event]=await events(a);
  assert.equal(event.execution_id,null);
  assert.equal(event.turn_actor_id,a.actor);
  assert.equal(event.original[0].title,'AI_TITLE');
  assert.equal(event.adopted[0].title,'USER_EDIT');
  // Not in the reply, or the same request id with other content: refused.
  assert.match(await refusal(save(a,src,request,[item(src)],{request:randomUUID(),version:1})),/OPC_TOPIC_SOURCE_INVALID/);
  assert.match(await refusal(save(a,src,request,[{...edited,title:'OTHER'}])),/OPC_REQUEST_CONFLICT/);
  // Adoption: from the frozen draft version, or naming its source; a repeat is one adoption.
  const list=await accounts(a,src),adoption=randomUUID();
  const done=await adopt(a,src,[edited],list,{request:adoption,draftVersion:first.draftVersionId});
  assert.ok(done.planId);
  assert.deepEqual(await adopt(a,src,[edited],list,{request:adoption,draftVersion:first.draftVersionId}),done);
  const adopted=(await events(a)).find(e=>e.action==='topic_adoption');
  assert.equal(adopted.turn_actor_id,a.actor);
  assert.equal(adopted.execution_id,null);
  assert.equal(adopted.original.title,'AI_TITLE');
  assert.ok(adopted.target_project_id);
  assert.equal((await events(a)).length,2,'a repeated adoption records nothing more');
  report.checks.push('topic: one metered turn; draft and adoption take its reply by request id; repeats change nothing and charge nothing');
 }
 // 3. Only a completed, delivered turn of this workspace is a source; another account never.
 {
  const a=await account(1000),src=await source(a),proposal=item(src);
  const failed=await topicTurn(a,src,JSON.stringify([proposal]),{kind:'failed'});
  assert.match(await refusal(save(a,src,failed.request,[proposal])),/OPC_DATA_SOURCE_DENIED/);
  const noPlan=await topicTurn(a,src,'just words');
  assert.match(await refusal(save(a,src,noPlan.request,[proposal])),/OPC_TOPIC_SOURCE_INVALID/);
  // A chat turn of another conversation of the same account.
  const elsewhere=randomUUID();
  const o=await open(a,{request:elsewhere,pol:pol()});
  await close(a,o.turnId,'completed',{messages:[{role:'assistant',content:JSON.stringify([proposal])}]});
  assert.match(await refusal(save(a,src,elsewhere,[proposal])),/OPC_DATA_SOURCE_DENIED|OPC_TOPIC_SOURCE_INVALID/);
  const b=await account(1000),other=await source(b);
  const good=await topicTurn(a,src,JSON.stringify([proposal]));
  assert.match(await refusal(one('select opc_topic_draft_from_execution($1,$2,$3,$4,$5,$6,$7) v',
   [b.actor,other.draft,good.request,0,other.version,good.request,JSON.stringify([proposal])])),/OPC_DATA_SOURCE_DENIED|OPC_TOPIC_SOURCE_INVALID/);
  await c.query('update opc_businesses set archived_at=now() where id=$1',[src.business]);
  assert.match(await refusal(save(a,src,good.request,[proposal])),/OPC_BUSINESS_ARCHIVED/);
  await c.query('update opc_businesses set archived_at=null where id=$1',[src.business]);
  report.checks.push('topic: a failed turn, a reply with no topics, another conversation, another account or an archived business is no source');
 }
 // 3c. One request id on one path, whichever came first, under the conversation's lock (never two charges while both paths exist).
 {
  const a=await account(1000),src=await source(a),old=randomUUID();
  await c.query(`insert into runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
   values($1,$2,$3,$4,'{}',0,'completed')`,[randomUUID(),a.actor,src.topicSession,old]);
  assert.match(await refusal(open(a,{kind:'chat',session:src.topicSession,request:old,pol:{...pol(),topic:true}})),/TURN_TOPIC_REQUEST_CONFLICT/);
  assert.equal(await balance(a),1000,'nothing frozen');
  const {request}=await topicTurn(a,src,'words');
  for(const name of ['runtime_admit_commit','runtime_admit']){
   const args=name==='runtime_admit'?'$1,$2,$3,$4,$5':'$1,$2,$3,$4,$5,null';
   assert.match(await refusal(one(`select ${name}(${args}) v`,[a.actor,src.topicSession,request,'{}','{}'])),/OPC_REQUEST_CONFLICT/,name);
  }
  // A chat that is no topic turn is unchanged.
  const free=await account(1000),o=await open(free,{pol:pol()});
  assert.equal(o.state,'running');
  report.checks.push('topic: a request id held by one path is refused by the other, both ways, before any charge');
 }
 // 3b. An old execution in the same workspace stays what it was: its event names the execution, no turn.
 {
  const a=await account(1000),src=await source(a),proposal=item(src),eid=randomUUID();
  await c.query(`insert into runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
   values($1,$2,$3,$4,'{}',0,'completed',$5)`,[eid,a.actor,src.topicSession,randomUUID(),{kind:'usable_result',body:JSON.stringify([proposal])}]);
  assert.equal(await one('select opc_data_source_turn($1,$2) v',[a.actor,eid]),null);
  report.checks.push('topic: a handle that is an old execution is never read as a turn');
 }
 // 4. The opening's handle; deleting the conversation erases its events and draft text like an execution's.
 {
  const a=await account(1000),src=await source(a),proposal=item(src),request=randomUUID();
  await c.query('insert into opc_topic_openings(draft_id,request_id,input) values($1,$2,$3)',[src.draft,request,'open']);
  const {closed}=await topicTurn(a,src,JSON.stringify([proposal]),{request});
  assert.equal(closed.closeKind,'completed');
  assert.equal((await one('select opc_topic_read($1,$2) v',[a.actor,src.draft])).opening.executionId,request);
  await save(a,src,request,[proposal]);
  assert.equal((await events(a)).length,1);
  // Another account's event of the same shape, untouched by everything below.
  const b=await account(1000),other=await source(b),theirs=item(other),their=await topicTurn(b,other,JSON.stringify([theirs]));
  await save(b,other,their.request,[theirs]);
  const scope=await one('select content_erasure_scope($1,$2,$3) v',[a.actor,'session',src.topicSession]);
  assert.equal(scope.dataEvents.length,1,'the preview names the event');
  await one('select content_erasure_mark_session($1,$2) v',[a.actor,src.topicSession]);
  assert.equal((await events(a)).length,0,'the event went with the conversation');
  assert.equal((await c.query('select body from opc_topic_draft_versions where request_id=$1',[request])).rows[0].body,null,'the draft text too');
  assert.match(await refusal(save(a,src,request,[proposal],{request:randomUUID(),version:1})),/OPC_DATA_SOURCE_DENIED/);
  assert.equal((await events(b)).length,1,'another account keeps its event');
  assert.equal((await c.query('select body from opc_topic_draft_versions where request_id=$1',[their.request])).rows[0].body!==null,true);
  report.checks.push('topic: the opening reads its turn; deleting the conversation erases its events and drafts, and only its own');
 }
}

// Runs after the relation lock count: an account scrub invalidates cached plans, which the count would read as locks of turn_open.
export async function topicAccountCases(t){
 const {c,one,account,report}=t,{source,item,topicTurn,save,adopt,events,accounts}=helpers(t);
 // 5. Account erasure: the proofs count an event that names a turn, the scrub removes it, another account keeps its own.
 {
  const a=await account(1000),src=await source(a),proposal=item(src),{request}=await topicTurn(a,src,JSON.stringify([proposal]));
  await save(a,src,request,[proposal]);
  const list=await accounts(a,src),first=await events(a);
  assert.equal(first.length,1);
  assert.ok(first[0].turn_id);
  await adopt(a,src,[proposal],list,{sources:[{itemId:proposal.id,executionId:request}]});
  assert.equal((await events(a)).filter(e=>e.turn_id).length,2,'both events name the turn');
  const b=await account(1000),other=await source(b),theirs=item(other),their=await topicTurn(b,other,JSON.stringify([theirs]));
  await save(b,other,their.request,[theirs]);
  // What each proof counts for these rows alone: the same proof with the rows gone, inside a transaction that is undone.
  const proofs=async()=>[Number(await one('select account_erasure_body_remaining($1) v',[a.actor])),
   Number(await one('select account_erasure_business_remaining($1) v',[a.actor]))];
  const held=await proofs();
  await c.query('begin');
  await c.query('delete from opc_data_events where actor_id=$1',[a.actor]);
  const without=await proofs();
  await c.query('rollback');
  assert.deepEqual(held.map((n,i)=>n-without[i]),[2,2],'each proof counts both rows');
  assert.equal((await events(a)).length,2);
  // As account_erasure_confirm leaves it (an earlier transaction): the profile closed, the request recorded.
  await c.query("update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1",[a.actor]);
  await c.query("insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now()-interval '1 minute')",[a.actor,randomUUID()]);
  const scrub=await one('select account_erasure_scrub_content($1) v',[a.actor]);
  assert.notEqual(scrub.retry,true);
  assert.equal(scrub.opc_data_events,2);
  assert.equal((await events(a)).length,0,'the scrub removed them');
  assert.ok(held[0]-(await proofs())[0]>=2,'the body proof fell with them');
  assert.equal((await events(b)).length,1,'another account keeps its event');
  assert.equal(await one('select count(*)::int v from turns where actor_id=$1',[a.actor]),1,'the billing record of the turn stays');
  report.checks.push('topic: account erasure proofs count events naming a turn, the scrub removes them, another account is untouched');
 }
}
