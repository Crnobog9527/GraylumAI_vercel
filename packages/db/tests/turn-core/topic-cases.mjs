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
 const {c,one,refusal,report,balance,account,open,close,peer}=t;
 const {source,read,pol,item,topicTurn,save,adopt,events,accounts}=helpers(t);
 // 1. topic_turn_source: what the old prepareTopicTurn checked, refused before anything is frozen.
 {
  const a=await account(1000),src=await source(a),got=await read(a,src);
  assert.equal(got.sessionId,src.topicSession);
  // V2-12: the narrowed runtime.view reads the session's scope only; a turn-path conversation is not legacy.
  const sc=await one('select runtime_session_scope($1,$2) v',[a.actor,src.topicSession]);
  assert.equal(sc.sessionId,src.topicSession);assert.equal(sc.legacy,false);assert.ok(sc.scope);
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
  await c.query('update bill2_drafts set revoked=true where id=$1',[src.draft]);
  assert.match(await refusal(read(a,src)),/OPC_TOPIC_SOURCE_REVOKED/);
  assert.equal(await balance(a),1000);
  report.checks.push('topic source: bound workspace, writable, allowed source, frozen material; refused before anything is frozen');
 }
 // CONTENT-CONVERSATION-2 (0532): the topic page's "绑定正式定位 v{n}" is the bound version's ordinal in the account strategy history,
 // the number the library rail shows, not the project's publish counter (staging validation batch 6: v10 against v9).
 {
  const a=await account(1000),src=await source(a);
  // The publish counter runs ahead of what the history counts (the case staging showed).
  await c.query('alter table artifact_versions disable trigger user');
  await c.query('update artifact_versions set version=10 where id=$1',[src.version]);
  await c.query('alter table artifact_versions enable trigger user');
  const project=await one('select project_id v from opc_accounts where actor_id=$1 and account_key=$2',[a.actor,src.account]);
  const history=await one('select opc_account_strategy_history($1,$2) v',[a.actor,project]);
  const entry=history.find(h=>h.id===src.version);
  assert.ok(entry,'the bound version is in the account history');
  const shown=(await one('select opc_topic_read($1,$2) v',[a.actor,src.draft])).sourceVersion;
  assert.equal(shown,entry.version,'the topic page shows the history ordinal');
  assert.notEqual(shown,10,'not the publish counter');
  report.checks.push('CONTENT-CONVERSATION-2 0532: the topic page shows the bound version as its strategy-history ordinal (the library rail number), not the publish counter');
 }
 // 2. A topic turn is one metered chat turn; the draft is saved from its reply, by its request id.
 {
  const a=await account(1000),src=await source(a),proposal=item(src);
  const reply='Here you go\n```json\n'+JSON.stringify([proposal])+'\n```';
  const {request,closed}=await topicTurn(a,src,reply);
  assert.equal(closed.chargedCredits,6,'by usage: ceil(q x n x m), once');
  const shown=await one('select turn_session_view($1,$2,0) v',[a.actor,src.topicSession]);
  assert.deepEqual(shown.messages.map(m=>m.requestId),[request,request],'each message names its handle');
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
 // 3b. A handle that is no turn is never read as one.
 {
  const a=await account(1000),eid=randomUUID();
  assert.equal(await one('select opc_data_source_turn($1,$2) v',[a.actor,eid]),null);
  report.checks.push('topic: a handle that is no turn (an old execution id) is never read as a turn');
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
 // Archive (V2-12 R1a, replaces the old "a dispatched BILL2 call blocks archive" case): a running turn of the business makes archive
 // BUSY, the owner retries after it closes, and an archived business refuses the next turn's source.
 {
  const {begin,identity,record}=t;
  const a=await account(1000),src=await source(a);
  const o=await open(a,{kind:'chat',session:src.topicSession,pol:pol()});
  await begin(a,o.turnId,1,{upper:0.05});
  assert.match(await refusal(one('select opc_business_archive($1,$2) v',[a.actor,src.business])),/OPC_BUSINESS_BUSY/);
  assert.equal((await c.query('select archived_at from opc_businesses where id=$1',[src.business])).rows[0].archived_at,null);
  await identity(a,o.turnId,1);await record(a,o.turnId,1,{n:0.01,actual:0.01});
  await close(a,o.turnId,'completed',{messages:[{role:'user',content:'topics please'},{role:'assistant',content:'words'}]});
  assert.equal((await one('select opc_business_archive($1,$2) v',[a.actor,src.business])).isArchived,true);
  assert.match(await refusal(read(a,src)),/OPC_BUSINESS_ARCHIVED/);
  report.checks.push('archive: a running turn of the business makes archive BUSY; after it closes archive succeeds and the next topic turn is refused as archived');
 }
}

// Owner 2026-11-02 (option A): after the positioning is updated the user starts the topic work again on the latest version. The binding row
// stays immutable except for the one re-bind update; the old conversation stays but is not sent to the model.
export async function topicRebindCases(t){
 const {c,one,refusal,account,peer,report}=t,{source,read,item,topicTurn,save,adopt,accounts}=helpers(t);
 const a=await account(1000),src=await source(a);
 const old=item(src),oldTurn=await topicTurn(a,src,'Old\n```json\n'+JSON.stringify([old])+'\n```');
 await save(a,src,oldTurn.request,[old]);
 assert.equal((await read(a,src)).historyFloor,0,'a workspace never re-bound sends its whole history');
 const workspace=()=>c.query('select * from opc_topic_workspaces where draft_id=$1',[src.draft]).then(r=>r.rows[0]);
 // The updated positioning: a second formal version of the same project.
 const round2=randomUUID(),version2=randomUUID();
 await c.query('create temp table round_copy as select * from artifact_rounds where id=$1',[src.round]);
 await c.query('update round_copy set id=$1',[round2]);
 await c.query('insert into artifact_rounds select * from round_copy');
 await c.query('drop table round_copy');
 const consent=(client=c,version=version2)=>client.query('select opc_topic_consent($1,$2,$3) v',[a.actor,src.draft,version]).then(r=>r.rows[0].v);
 // 1. Nothing newer is formal yet: no re-bind. The binding is untouched and its guard refuses every other change.
 assert.match(await refusal(consent()),/OPC_TOPIC_SOURCE_CHANGED|OPC_TOPIC_SOURCE_DENIED/);
 await c.query(`insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
  values($1,$2,$3,2,'{"body":"CONFIRMED2"}',repeat('d',64),'[]')`,[version2,src.project,round2]);
 await c.query('update artifact_projects set current_version=2 where id=$1',[src.project]);
 const refuseUpdate=async sql=>{await c.query('begin');try{return await refusal(c.query(sql,[src.draft]));}finally{await c.query('rollback');}};
 assert.match(await refuseUpdate('update opc_topic_workspaces set history_floor_seq=99 where draft_id=$1'),/artifact history immutable/,'no marker');
 await c.query('begin');
 await c.query("select set_config('graylum.topic_rebind','guess',true)");
 assert.match(await refusal(c.query('update opc_topic_workspaces set history_floor_seq=99 where draft_id=$1',[src.draft])),/immutable/,'a wrong marker');
 await c.query('rollback');
 await c.query('begin');
 await c.query("select set_config('graylum.topic_rebind',$1||':'||txid_current(),true)",[src.draft]);
 assert.match(await refusal(c.query("update opc_topic_workspaces set session_id=gen_random_uuid() where draft_id=$1",[src.draft])),/immutable/,'marker, other column');
 await c.query('rollback');
 await c.query('begin');
 await c.query("select set_config('graylum.topic_rebind',$1||':'||txid_current(),true)",[src.draft]);
 assert.match(await refusal(c.query("update opc_topic_workspaces set request_id=gen_random_uuid(),source_hash='x' where draft_id=$1",[src.draft])),/immutable/,'marker, one allowed and one other column');
 await c.query('rollback');
 assert.match(await refuseUpdate('delete from opc_topic_workspaces where draft_id=$1'),/immutable/,'delete');
 // The marker opens nothing else: the same marker on rows of other immutable tables changes nothing there.
 for(const [table,id,set] of [['artifact_versions',version2,"report_hash=repeat('0',64)"],['artifact_rounds',round2,"state='draft'"]]){
  await c.query('begin');
  await c.query("select set_config('graylum.topic_rebind',$1||':'||txid_current(),true)",[src.draft]);
  assert.match(await refusal(c.query(`update ${table} set ${set} where id=$1`,[id])),/immutable/,table+' stays immutable under the marker');
  await c.query('rollback');
 }
 assert.equal((await workspace()).source_version_id,src.version,'untouched');
 // 2. A turn opens only on the latest version: the workspace behind it is read-only.
 assert.match(await refusal(read(a,src)),/OPC_TOPIC_SOURCE_CHANGED/);
 // 3. The re-bind: the same conversation, a new material revision, the floor at the last message.
 const messages=Number(await one('select max(seq)::int v from session_messages where session_id=$1',[src.topicSession]));
 // A turn of the old conversation still running (another tab) blocks the re-bind: its messages would land after the floor.
 await c.query('update runtime_sessions set active_turn_id=(select id from turns where actor_id=$1 limit 1) where id=$2',[a.actor,src.topicSession]);
 assert.match(await refusal(consent()),/OPC_TOPIC_TURN_ACTIVE/);
 assert.equal((await workspace()).source_version_id,src.version,'refused: untouched');
 await c.query('update runtime_sessions set active_turn_id=null where id=$1',[src.topicSession]);
 const bound=await consent();
 assert.equal(bound.sourceVersionId,version2);assert.equal(bound.sessionId,src.topicSession);
 const after=await workspace();
 assert.equal(after.source_version_id,version2);assert.equal(Number(after.history_floor_seq),messages);assert.equal(Number(after.material_revision),2);
 const src2={...src,version:version2},got=await read(a,src2);
 assert.equal(got.historyFloor,messages);assert.equal(got.material.revision,2);assert.equal(got.sourceVersionId,version2);
 assert.equal(Number(await one('select count(*)::int v from runtime_scope_material where session_id=$1',[src.topicSession])),2);
 // 4. A second click changes nothing; two at once leave one outcome.
 assert.equal((await consent()).sourceVersionId,version2);
 assert.equal(Number(await one('select count(*)::int v from runtime_scope_material where session_id=$1',[src.topicSession])),2,'no second material');
 // 5. The old candidate cannot be adopted on the new version; a new one saved on it can be saved.
 assert.match(await refusal(save(a,src2,oldTurn.request,[old],{request:randomUUID(),version:1})),/OPC_TOPIC_SOURCE_INVALID/);
 const fresh=item(src2),newTurn=await topicTurn(a,src2,'New\n```json\n'+JSON.stringify([fresh])+'\n```');
 const original=await one('select opc_topic_original($1,$2,$3,$4) v',[a.actor,src.draft,version2,newTurn.request]);
 assert.equal(original[0].id,fresh.id,'a reply after the re-bind is a source on the new version');
 const list2=await accounts(a,src);
 // Saving and adopting both go through that gate; the transition behind them needs a really published version, which this fixture's
 // hand-made second version is not (that path is covered by the staging acceptance).
 assert.match(await refusal(adopt(a,src2,[old],list2,{sources:[{itemId:old.id,executionId:oldTurn.request}]})),/OPC_TOPIC_SOURCE_INVALID/,'an old candidate is not adopted');
 // 6. Concurrency: two accounts-worth of the same click at once on a second workspace.
 const b=await account(1000),other=await source(b);
 const r3=randomUUID(),v3=randomUUID();
 await c.query('create temp table round_copy as select * from artifact_rounds where id=$1',[other.round]);
 await c.query('update round_copy set id=$1',[r3]);await c.query('insert into artifact_rounds select * from round_copy');await c.query('drop table round_copy');
 await c.query(`insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) values($1,$2,$3,2,'{"body":"C2"}',repeat('d',64),'[]')`,[v3,other.project,r3]);
 await c.query('update artifact_projects set current_version=2 where id=$1',[other.project]);
 const p1=await peer(),p2=await peer();
 try{
  const go=client=>client.query('select opc_topic_consent($1,$2,$3) v',[b.actor,other.draft,v3]).then(r=>r.rows[0].v);
  const [x,y]=await Promise.all([go(p1),go(p2)]);
  assert.equal(x.sourceVersionId,v3);assert.equal(y.sourceVersionId,v3);
 } finally {await p1.end();await p2.end();}
 assert.equal(Number(await one('select count(*)::int v from runtime_scope_material where session_id=$1',[other.topicSession])),2,'one material for two clicks');
 report.checks.push('topic re-bind: guard refuses without or with a wrong marker, other columns and deletes; turns only on the latest version; floor, repeat and concurrent clicks');
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
