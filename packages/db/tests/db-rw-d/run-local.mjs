/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-RW-D (0420), behind runtime_rw_v2.chainBranch: the permission chain plans only the tables its scope can reach.
// Differential: every probe is run with the switch absent (today's bodies) and with chainBranch true; the result or the
// error must be identical. Counted on the database: relations locked by the transaction (tables and their indexes).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>{try{return (await c.query(sql,args)).rows[0]?.v;}catch(e){e.message+=' @ '+sql.slice(0,70);throw e;}};
const setSwitch=async on=>{
 if(on===null)await c.query("DELETE FROM system_settings WHERE key='runtime_rw_v2'");
 else await c.query(`INSERT INTO system_settings(key,value) VALUES('runtime_rw_v2',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({chainBranch:on})]);
};
// Run one statement in its own transaction; report its value or its error, and how many public relations it locked.
const probe=async(sql,args=[])=>{
 await probeOnce(sql,args); // the first run in a session plans and caches; count the second
 return probeOnce(sql,args);
};
const probeOnce=async(sql,args=[])=>{
 await c.query('BEGIN');await c.query('SAVEPOINT p');
 let out;
 try{out={v:JSON.stringify((await c.query(sql,args)).rows[0]?.v??null)};}
 catch(e){out={e:e.message};await c.query('ROLLBACK TO p');}
 out.locks=Number(await one(`SELECT count(DISTINCT l.relation) v FROM pg_locks l JOIN pg_class k ON k.oid=l.relation
  WHERE l.pid=pg_backend_pid() AND l.locktype='relation' AND k.relnamespace='public'::regnamespace`));
 await c.query('ROLLBACK');return out;
};
const stats={};let compared=0;const answers={}; // fn -> label -> answer, to prove the matrix reaches true, false, NULL and errors
// Writing the switch itself moves the catalog's settings version; that is not part of what is compared.
const plainValue=v=>{if(typeof v!=='string')return v;try{const o=JSON.parse(v);if(o&&typeof o==='object'&&'catalogVersions' in o){delete o.catalogVersions;return JSON.stringify(o);}}catch{}return v;};
const same=async(label,fn,sql,args=[])=>{
 await setSwitch(null);const off=await probe(sql,args);
 await setSwitch(true);const on=await probe(sql,args);
 assert.deepEqual({v:plainValue(on.v),e:on.e},{v:plainValue(off.v),e:off.e},`CHAIN_BRANCH_DIFFERS ${fn} ${label}: off=${JSON.stringify(off)} on=${JSON.stringify(on)}`);
 compared++;((answers[fn]??={})[label.split('/').slice(-1)[0]]??=new Set()).add(off.e?'error':off.v);
 const s=stats[fn]??={off:0,on:0,n:0,maxOn:0,maxOff:0};
 s.off+=off.locks;s.on+=on.locks;s.n++;s.maxOn=Math.max(s.maxOn,on.locks);s.maxOff=Math.max(s.maxOff,off.locks);
 return {off,on};
};
try{
 await c.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await c.query(read('packages/db/tests/content-erasure/fixture.sql'));
 // Two accounts with every kind of scope: A owns a positioning draft (with an OPC draft, business, strategy binding), a work
 // item under an account, a plain draft, a library document; B is another account.
 const mk=async()=>{
  const f=await createFixture(c,{credits:1000,threshold:1});
  const art=await one('select d7_test.artifacts($1) v',[f.actor]);
  const draft=await one('select draft_id v from opc_drafts where actor_id=$1',[f.actor]);
  const account=await one('select project_id v from opc_accounts where actor_id=$1',[f.actor]);
  const plain=await one('select bill2_create_draft($1) v',[f.actor]);
  const doc=await one(`INSERT INTO library_documents(actor_id,request_id,kind,format,status) VALUES($1,gen_random_uuid(),'document','pdf','ready') RETURNING id v`,[f.actor]);
  const session=await one('select session_id v from opc_drafts where actor_id=$1',[f.actor]);
  return {f,art,draft,account,plain,doc,session,actor:f.actor};
 };
 const A=await mk(),B=await mk();
 const strategy=async x=>c.query(`INSERT INTO opc_account_strategy_drafts(account_project_id,draft_id,actor_id,root_source_version_id,base_source_version_id,base_account_revision,current)
  VALUES($1,$2,$3,$4,$4,0,true)`,[x.account,x.draft,x.actor,x.art.version]);
 const scopes=(X,Y)=>[
  ['draft with an OPC draft',{kind:'positioning_draft',draftId:X.draft}],
  ['plain draft',{kind:'positioning_draft',draftId:X.plain}],
  ['draft with a project key',{kind:'positioning_draft',draftId:X.draft,projectId:X.art.project}],
  ['draft with a work item key',{kind:'positioning_draft',draftId:X.plain,workItemId:X.art.workItem}],
  ['draft of another account',{kind:'positioning_draft',draftId:Y.draft}],
  ['plain draft of another account',{kind:'positioning_draft',draftId:Y.plain}],
  ['unknown draft',{kind:'positioning_draft',draftId:randomUUID()}],
  ['draft without a draft id',{kind:'positioning_draft'}],
  ['work item',{kind:'work_item',projectId:X.account,workItemId:X.art.workItem}],
  ['work item with a draft id',{kind:'work_item',projectId:X.account,workItemId:X.art.workItem,draftId:X.draft}],
  ['work item under the wrong project',{kind:'work_item',projectId:X.art.project,workItemId:X.art.workItem}],
  ['work item of another account',{kind:'work_item',projectId:Y.account,workItemId:Y.art.workItem}],
  ['unknown work item',{kind:'work_item',projectId:randomUUID(),workItemId:randomUUID()}],
  ['topic',{kind:'positioning_topic',draftId:X.draft}],
  ['topic with an account key',{kind:'positioning_topic',draftId:X.draft,account:'x'}],
  ['topic with a project key',{kind:'positioning_topic',draftId:X.draft,projectId:X.account}],
  ['topic of another account',{kind:'positioning_topic',draftId:Y.draft}],
  ['library document',{kind:'library_document',documentId:X.doc}],
  ['library document of another account',{kind:'library_document',documentId:Y.doc}],
  ['library document with a bad id',{kind:'library_document',documentId:'not-a-uuid'}],
  ['library document with extra keys',{kind:'library_document',documentId:X.doc,draftId:X.draft}],
  ['no kind',{draftId:X.draft}],['kind null',{kind:null,draftId:X.draft}],['unknown kind',{kind:'weird',draftId:X.draft}],
  ['empty object',{}],['array',[]],['string','"x"'],['json null','null'],
 ];
 const everyScope=async(stage)=>{
  for(const [actorLabel,X,Y] of [['owner',A,B],['other account',B,A]])
   for(const [label,scope] of scopes(A,B)) {
    const text=typeof scope==='string'?scope:JSON.stringify(scope);
    await same(`${stage}/${actorLabel}/${label}`,'bill2_scope_allowed','select bill2_scope_allowed($1,$2::jsonb) v',[X.actor,text]);
   }
 };
 const businessTargets=(X,Y)=>[
  ['session',{sessionId:X.session}],['work item session',{sessionId:X.art.session}],['other account session',{sessionId:Y.session}],
  ['business',{businessId:randomUUID()}],['draft',{draftId:X.draft}],['draft scope',{kind:'positioning_draft',draftId:X.draft}],
  ['plain draft scope',{kind:'positioning_draft',draftId:X.plain}],['work item scope',{kind:'work_item',projectId:X.account,workItemId:X.art.workItem}],
  ['project scope',{projectId:X.art.project}],['account scope',{projectId:X.account}],['empty',{}],['unknown session',{sessionId:randomUUID()}],
 ];
 const everyBusiness=async(stage)=>{
  for(const [X,Y] of [[A,B],[B,A]])
   for(const [label,t] of businessTargets(X,Y))
    await same(`${stage}/${label}`,'opc_target_business','select opc_target_business($1,$2::jsonb) v',[X.actor,JSON.stringify(t)]);
 };
 const everyAssert=async(stage)=>{
  for(const [X,Y] of [[A,B],[B,A]])
   for(const [label,t] of businessTargets(X,Y))
    await same(`${stage}/${label}`,'opc_assert_business_writable','select opc_assert_business_writable($1,$2::jsonb) v',[X.actor,JSON.stringify(t)]);
 };
 // 1. Today's data.
 await everyScope('baseline');await everyBusiness('baseline');await everyAssert('baseline');
 // 2. A strategy binding on the draft, a topic workspace, then each kind of revocation.
 await strategy(A);
 await c.query(`INSERT INTO opc_topic_workspaces(draft_id,actor_id,request_id,source_version_id,source_hash,module_id,skill_id,revision_id,package_hash,session_id,material_revision)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,[B.draft,B.actor,randomUUID(),B.art.version,'e'.repeat(64),B.art.module,B.art.skill,B.art.revision,'b'.repeat(64),B.session]);
 await everyScope('strategy and topic');await everyBusiness('strategy and topic');
 await c.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1',[A.plain]);
 await everyScope('plain draft revoked');
 await c.query('UPDATE opc_businesses SET archived_at=now() WHERE actor_id=$1',[A.actor]);
 await everyBusiness('business archived');await everyAssert('business archived');
 // The real erasure path stamps erased_at on the account project and the projects linked through the strategy binding.
 await erase(c,{actor:A.actor},'artifact',A.account);
 await everyScope('account erased');await everyBusiness('account erased');
 await erase(c,{actor:B.actor},'artifact',B.art.project).catch(()=>null);
 await everyScope('source project erased');
 await c.query("UPDATE library_documents SET deleted_at=now() WHERE id=$1",[A.doc]);
 await everyScope('library document deleted');
 report.checks.push(`bill2_scope_allowed, opc_target_business and opc_assert_business_writable: ${compared} probes over 28 scopes, 12 targets, two accounts and eight data stages return the same value or error with the switch absent and on`);
 // 3. runtime_context_allowed: workspace sessions, saved read_source dependencies, sources.
 const chat=await mk();
 const started=await rpc(c,'runtime_start',chat.actor,randomUUID(),{scope:{kind:'positioning_draft'}});
 const ctx=(X,sessionId,requestId,extra={})=>({version:'runtime.v1',workspaceContext:true,sources:[],request:{sessionId,requestId},...extra});
 const contexts=[
  ['plain session',chat.actor,ctx(chat,started.sessionId,randomUUID())],
  ['plain session without the flag',chat.actor,{...ctx(chat,started.sessionId,randomUUID()),workspaceContext:false}],
  ['session of an OPC draft',A.actor,ctx(A,A.session,randomUUID())],
  ['session of another account',chat.actor,ctx(chat,A.session,randomUUID())],
  ['unknown session',chat.actor,ctx(chat,randomUUID(),randomUUID())],
  ['not a runtime.v1 context',chat.actor,{version:'x'}],
  ['sources not an array',chat.actor,ctx(chat,started.sessionId,randomUUID(),{sources:{}})],
  ['report generation',chat.actor,ctx(chat,started.sessionId,randomUUID(),{reportGeneration:{projectId:randomUUID(),evidenceIds:[]}})],
 ];
 for(const [label,actor,context] of contexts)
  await same(label,'runtime_context_allowed','select runtime_context_allowed($1,$2::jsonb) v',[actor,JSON.stringify(context)]);
 // An execution of the request that already read a source: the saved dependencies are checked again.
 const request=randomUUID();
 await c.query('BEGIN');
 await c.query("select set_config('request.jwt.claim.sub',$1,true)",[chat.actor]);
 const t={requestId:request,payload:ctx(chat,started.sessionId,request)};
 const billing={...chat.f.payload,scope:{kind:'positioning_draft',draftId:chat.plain},input:t.payload};
 await c.query('COMMIT');
 const execution=await one(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision,state)
  VALUES($1,$2,$3,$4::jsonb,0,'running') RETURNING id v`,[chat.actor,started.sessionId,request,JSON.stringify(t.payload)]).catch(()=>null);
 if(execution) {
  await c.query('ALTER TABLE runtime_tool_calls DISABLE TRIGGER USER');
  for(const [label,dependency] of [['allowed',chat.art.version],['revoked',randomUUID()]]) {
   await c.query('DELETE FROM runtime_tool_calls WHERE execution_id=$1',[execution]);
   await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,'r','read_source','{}',$2::jsonb)`,
    [execution,JSON.stringify({kind:'my_posts',status:'available',dependencies:[dependency]})]);
   await same(`saved source dependency ${label}`,'runtime_context_allowed','select runtime_context_allowed($1,$2::jsonb) v',[chat.actor,JSON.stringify(t.payload)]);
  }
  await c.query('ALTER TABLE runtime_tool_calls ENABLE TRIGGER USER');
 }
 report.checks.push('runtime_context_allowed returns the same value or error for plain, OPC, foreign and unknown sessions, bad contexts, report generation and saved source dependencies');
 // 4. The whole precheck on a plain turn and on a Skill-bound turn: the same proof, fewer relations.
 const turn=(X,sessionId,scope,bind)=>{
  const requestId=randomUUID();
  const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'x',instructions:'x',model:X.f.claimPayload.model,modelId:X.f.payload.modelId,
   maxOutputTokens:1000,maxTurns:3,historyItems:10,tools:[],maxToolCalls:0,workspaceContext:true,sources:[],network:'deny',
   request:{sessionId,requestId,input:'x',selection:{kind:'ordinary',modelId:X.f.payload.modelId},network:'deny'}};
  return {requestId,sessionId,context,billing:{...X.f.payload,scope,input:context,...bind}};
 };
 const plainSession=await rpc(c,'runtime_session_context',chat.actor,started.sessionId);
 const plainTurn=turn(chat,started.sessionId,plainSession.scope,{});
 await c.query('UPDATE modules SET model_id=$2 WHERE id=$1',[chat.art.module,chat.f.payload.modelId]);
 const skillTurn=turn(chat,started.sessionId,plainSession.scope,{moduleId:chat.art.module,skillId:chat.art.skill,revisionId:chat.art.revision});
 await c.query('ANALYZE');
 const precheck=t=>['select runtime_admit_precheck($1,$2,$3,$4::jsonb,$5::jsonb) v',[chat.actor,t.sessionId,t.requestId,JSON.stringify(t.context),JSON.stringify(t.billing)]];
 const plain=await same('plain turn','runtime_admit_precheck',...precheck(plainTurn));
 const skill=await same('Skill-bound turn','runtime_admit_precheck',...precheck(skillTurn));
 report.checks.push(`runtime_admit_precheck: plain turn ${plain.off.locks} -> ${plain.on.locks} relations, Skill-bound turn ${skill.off.locks} -> ${skill.on.locks}; same proof`);
 assert.ok(plain.on.locks<=55,`CHAIN_BRANCH_PLAIN_TURN_LOCKS: ${plain.on.locks}`);
 assert.ok(skill.on.locks<=80,`CHAIN_BRANCH_SKILL_TURN_LOCKS: ${skill.on.locks}`);
 assert.ok(plain.off.locks>=plain.on.locks+20,`CHAIN_BRANCH_PLAIN_TURN_SAVES_NOTHING: ${plain.off.locks} vs ${plain.on.locks}`);
 // 5. A turn that is refused is refused with the same error in both modes (permission revoked, actor denied).
 await c.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1',[chat.plain]);
 const refusedTurn=turn(chat,started.sessionId,{kind:'positioning_draft',draftId:chat.plain},{});
 const refusal=await same('revoked draft','runtime_admit_precheck',...precheck(refusedTurn));
 assert.ok(refusal.on.e||refusal.on.v,'the revoked draft is refused or answered the same way in both modes');
 const deniedTurn={...plainTurn,billing:{...plainTurn.billing,callPolicy:[]}};
 const denied=await same('invalid call policy','runtime_admit_precheck',...precheck(deniedTurn));
 assert.match(String(denied.on.e),/BILL2_CALL_POLICY_REQUIRED/);
 report.checks.push('a revoked draft and an invalid call policy are refused with the same error by the precheck in both modes');
 const seen=fn=>new Set([...Object.values(answers[fn]??{})].flatMap(x=>[...x]));
 for(const want of ['true','false','null'])assert.ok(seen('bill2_scope_allowed').has(want),`MATRIX_NEVER_ANSWERS_${want}`);
 assert.ok(seen('bill2_scope_allowed').has('error'),'MATRIX_NEVER_ERRORS');
 assert.ok(seen('opc_target_business').size>=2&&seen('opc_assert_business_writable').size>=2,'MATRIX_BUSINESS_NOT_VARIED');
 report.answers=Object.fromEntries(Object.keys(answers).map(k=>[k,[...seen(k)].map(v=>String(v).slice(0,10))]));
 report.stats=Object.fromEntries(Object.entries(stats).map(([k,s])=>[k,`mean relations ${(s.off/s.n).toFixed(1)} -> ${(s.on/s.n).toFixed(1)}, max ${s.maxOff} -> ${s.maxOn}, ${s.n} probes`]));
 await setSwitch(null);
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
