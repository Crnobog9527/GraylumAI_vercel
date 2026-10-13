/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0231: one-click conversation deletion marks only the selected session, then cleans up later.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runtimeFixture} from './cases.mjs';
import {rpc,fixture,evidence,closeAccount,outcome} from '../erasure-b2a/cases.mjs';
const mark=(db,f,id=f.session)=>rpc(db,'content_erasure_mark_session',f.actor,id);
const cleanup=(db,f,id=f.session)=>rpc(db,'content_erasure_confirm',f.actor,'session',id,null);
const row=async(db,table,id)=>(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
async function bystander(db,f){
 const id=randomUUID();
 await db.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
  SELECT $1::uuid,actor_id,scope||jsonb_build_object('fixtureBystander',$1::text),gen_random_uuid(),'{}' FROM runtime_sessions WHERE id=$2`,[id,f.session]);
 return id;
}
// A positioning conversation whose answer was captured into a live work (same setup as capture-v3).
async function capturedIntoWork(db){
 const f=(await db.query('SELECT runtime_perf_test.seed(0,false) v')).rows[0].v;
 const art=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const project=randomUUID(),round=randomUUID();
 const workflow={steps:[{id:'s',information:[{id:'goal'}]}]};
 const steps={s:{version:7,valid:true,information:{goal:{value:'KEEP_CONFIRMED',status:'confirmed',nature:'fact'}},
  fieldMeta:{goal:{source:'manual'}}}};
 await db.query('INSERT INTO artifact_projects(id,actor_id,module_id,skill_id) VALUES($1,$2,$3,$4)',[project,f.actor,art.module,art.skill]);
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
  VALUES($1,$2,$3,$4,$5,$6,$6,$7)`,[round,project,art.revision,'b'.repeat(64),workflow,'c'.repeat(64),steps]);
 const registration=(await db.query('SELECT id FROM artifact_workflows WHERE skill_id=$1',[art.skill])).rows[0].id;
 await db.query(`INSERT INTO opc_drafts VALUES($1,$2,$3,$4,$5,$6,$7,'mentor')`,[f.draft,f.actor,project,round,f.session,randomUUID(),registration]);
 await db.query('UPDATE modules SET model_id=$2 WHERE id=$1',[art.module,f.model]);
 const material={roundId:round,work:{projectId:project,roundId:round,revisionId:art.revision,packageHash:'b'.repeat(64),source:null,steps}};
 const hash=(await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[material])).rows[0].h;
 await db.query(`INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
  VALUES($1,1,$2,'{}',$3,$4)`,[f.session,randomUUID(),material,hash]);
 const e={id:randomUUID(),request_id:randomUUID()},token=randomUUID();
 const suggestion={value:'COPIED_PRIVATE_SUGGESTION',nature:'fact',basis:'user_statement'};
 const input={captureFormat:'v2',userInput:'请更新目标',checklist:[{id:'s',fields:[{id:'goal'}]}]};
 const output={inputKind:'request',patches:[{stepId:'s',fieldId:'goal',status:'provisional',...suggestion}],notes:[]};
 const payload={...f.payload,role:'skill',request:{input:'Synthetic input',requestId:e.request_id},moduleId:art.module,revisionId:art.revision,
  opcTurnToken:token,scopeMaterial:{sessionId:f.session,revision:1,hash,content:material},attachedOrganizer:{input:JSON.stringify(input)}};
 await db.query(`INSERT INTO opc_turns(token,draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash)
  VALUES($1,$2,$3,$4,$5,'s','mentor',1,$6)`,[token,f.draft,f.session,e.request_id,round,'e'.repeat(64)]);
 const billing={...f.billing,moduleId:art.module,skillId:art.skill,revisionId:art.revision,input:payload};
 const run=await rpc(db,'bill2_prepare',f.actor,randomUUID(),billing);
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,billing_run_id,history_revision,state,result,created_at)
  VALUES($1,$2,$3,$4,$5,$6,0,'completed',$7,$8)`,[e.id,f.actor,f.session,e.request_id,payload,run.id,{...outcome,summary:JSON.stringify(output)},
  new Date(1767225600000)]);
 await db.query('UPDATE bill2_runs SET session_ref=$2 WHERE id=$1',[run.id,f.session]);
 await db.query('SELECT runtime_billing_allowed($1,$2,$3)',[f.actor,billing,run.id]);
 assert.equal((await rpc(db,'opc_capture_apply',f.actor,f.draft,e.id)).result,'suggested');
 return {...f,round,project};
}
export async function runInstant({db,Client,connectionString,report}){
 const locker=new Client({connectionString});await locker.connect();
 try{
  // Allow: the owner's mark commits only the marker, and every read, write and replay is refused at once.
  const f=await runtimeFixture(db,{settled:true});
  for(const role of ['anon','authenticated']){
   await db.query('SET ROLE '+role);
   await assert.rejects(mark(db,f),/permission denied/);
   await assert.rejects(rpc(db,'content_erasure_sweep_sessions',10,null,null),/permission denied/);
   await db.query('RESET ROLE');
  }
  const other=await fixture(db);
  await assert.rejects(mark(db,{...f,actor:other.actor}),/CONTENT_NOT_FOUND/);
  assert.equal((await row(db,'runtime_sessions',f.session)).content_deleted_at,null,'denied mark leaves the session');
  await db.query('SET ROLE service_role');
  assert.deepEqual(await mark(db,f),{kind:'session',id:f.session,status:'deleted',alreadyDeleted:false,
   preservedSavedVersions:0,financialReviewCount:0});
  await db.query('RESET ROLE');
  const marked=await row(db,'runtime_sessions',f.session);
  assert.ok(marked.content_deleted_at);assert.equal(marked.erased_at,null,'physical cleanup is not synchronous');
  await assert.rejects(rpc(db,'runtime_view',f.actor,f.session),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'runtime_execution',f.actor,f.execution,'read',null),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'content_erasure_visible',f.actor,f.execution),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'runtime_admission_replay',f.actor,(await row(db,'runtime_executions',f.execution)).request_id,{}),
   /CONTENT_ERASED/);
  await assert.rejects(db.query(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision)
   VALUES($1,$2,$3,'{}',0)`,[f.actor,f.session,randomUUID()]),/CONTENT_ERASED/);
  assert.equal((await mark(db,f)).alreadyDeleted,true,'repeat is a no-op');
  report.checks.push('mark: owner only, marker-only commit, read/write/replay refused at once, repeat no-op');

  // Cleanup runs the unchanged confirm on its already-deleted path (no client hash).
  await assert.rejects(rpc(db,'content_erasure_confirm',f.actor,'session',(await bystander(db,f)),null),/PREVIEW_CHANGED/,
   'an unmarked session still needs the preview hash');
  assert.equal((await cleanup(db,f)).alreadyDeleted,true);
  const cleaned=await row(db,'runtime_sessions',f.session);
  assert.ok(cleaned.erased_at);assert.equal(cleaned.scope,null);
  assert.equal((await row(db,'runtime_executions',f.execution)).payload,null);
  assert.equal((await cleanup(db,f)).alreadyDeleted,true,'repeat cleanup is a no-op');
  report.checks.push('cleanup: confirm without hash only for a marked session; body cleared; repeat no-op');

  // Another conversation of the same account is busy (a reply is generating there).
  const g=await runtimeFixture(db,{settled:true});
  const busyElsewhere=await bystander(db,g);
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[busyElsewhere]);
  assert.equal((await mark(db,g)).status,'deleted','another busy conversation does not block the mark');
  assert.equal((await cleanup(db,g)).status,'deleted','nor the cleanup of a marked session');
  await locker.query('ROLLBACK');
  report.checks.push('a busy other conversation of the same account blocks neither mark nor cleanup');

  // The same conversation is held by a committing reply: wait briefly, then busy without a marker.
  const h=await runtimeFixture(db,{settled:true});
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[h.session]);
  const started=Date.now();
  await assert.rejects(mark(db,h),/CONTENT_ERASURE_BUSY/);
  assert.ok(Date.now()-started<5000,'bounded wait');
  await locker.query('ROLLBACK');
  assert.equal((await row(db,'runtime_sessions',h.session)).content_deleted_at,null,'busy leaves no marker');
  report.checks.push('same conversation locked: bounded wait then busy, nothing marked');

  // Same conversation generating (dispatched, cost unknown): mark first, then the late result is refused
  // while the original money path still records the provider cost.
  const p=await runtimeFixture(db,{dispatched:true});
  const before=(await db.query('SELECT credits FROM profiles WHERE id=$1',[p.actor])).rows[0].credits;
  await mark(db,p);
  await assert.rejects(rpc(db,'runtime_execution',p.actor,p.execution,'complete',{text:'LATE_PRIVATE_RESULT'}),/CONTENT_ERASED/);
  await assert.rejects(db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
   VALUES($1,1,$2,'{"role":"assistant"}')`,[p.session,p.execution]),/CONTENT_ERASED/);
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[p.actor])).rows[0].credits,before,
   'mark neither charges nor refunds');
  await rpc(db,'bill2_record',p.actor,p.run,p.call.id,evidence(p.call));
  await cleanup(db,p);
  const late=(await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[p.call.id])).rows[0].payload;
  assert.doesNotMatch(JSON.stringify(late),/B2A_PRIVATE_CANARY|LATE_PRIVATE_RESULT|sdkResponse|rawBody/);
  assert.doesNotMatch(JSON.stringify(await row(db,'runtime_executions',p.execution)),/LATE_PRIVATE_RESULT/);
  report.checks.push('same conversation generating: late result and history refused after mark; money recorded on original run');

  // A copy lives in a live work: the same call runs the full cleanup, so the copy is gone on return,
  // while an unrelated busy conversation and an unrelated busy work of the account do not block it.
  const c=await capturedIntoWork(db);
  assert.match(JSON.stringify((await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[c.round])).rows[0].steps),
   /COPIED_PRIVATE_SUGGESTION/);
  const otherConversation=await bystander(db,{actor:c.actor,session:c.session});
  const otherWork=randomUUID();
  await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account)
   SELECT $1,actor_id,module_id,skill_id,'unrelated-work' FROM artifact_projects WHERE id=$2`,[otherWork,c.project]);
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[otherConversation]);
  await locker.query('SELECT id FROM artifact_projects WHERE id=$1 FOR UPDATE',[otherWork]);
  const full=await mark(db,c);
  await locker.query('ROLLBACK');
  assert.equal(full.alreadyDeleted,false);assert.ok(['deleted','review_required'].includes(full.status));
  assert.ok((await row(db,'runtime_sessions',c.session)).erased_at,'full cleanup ran in the same call');
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[c.round])).rows[0].steps),
   /COPIED_PRIVATE_SUGGESTION/,'the copy in the live work is unreadable when the call returns');
  report.checks.push('copy in a live work: full cleanup in the same call, copy gone on return; unrelated busy conversation/work do not block');

  // A local free conversation: only the marker, even with the account's other conversation and work locked.
  const l=await runtimeFixture(db,{settled:true});
  const lockedConversation=await bystander(db,l);
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[lockedConversation]);
  await locker.query('SELECT id FROM artifact_projects WHERE id=$1 FOR UPDATE',[otherWork]);
  assert.equal((await mark(db,l)).status,'deleted');
  await locker.query('ROLLBACK');
  assert.equal((await row(db,'runtime_sessions',l.session)).erased_at,null,'local deletion leaves cleanup to the background');
  await cleanup(db,l);
  report.checks.push('local conversation: marker only; read-only scope takes no account-wide locks');

  // A copy exists but its cleanup is busy: nothing is marked and the call reports busy.
  const b=await capturedIntoWork(db);
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_executions WHERE session_id=$1 FOR UPDATE',[b.session]);
  await assert.rejects(mark(db,b),/CONTENT_ERASURE_BUSY/);
  await locker.query('ROLLBACK');
  assert.equal((await row(db,'runtime_sessions',b.session)).content_deleted_at,null,'busy full cleanup rolls back the marker');
  report.checks.push('copy present and cleanup busy: marker rolled back, reported busy');

  // Sweep: the cron backstop pages through marked sessions, skips closed accounts, keeps busy ones pending
  // and counts any other failure as failed.
  const s1=await runtimeFixture(db,{settled:true}),s2=await runtimeFixture(db,{settled:true}),s3=await runtimeFixture(db,{settled:true});
  const s4=await runtimeFixture(db,{settled:true});
  for(const x of [s1,s2,s3,s4])await mark(db,x);
  await closeAccount(db,s3);
  const sweep=(lim,cursor)=>rpc(db,'content_erasure_sweep_sessions',lim,cursor?.afterAt??null,cursor?.afterId??null);
  await assert.rejects(sweep(0),/SWEEP_LIMIT/);
  await assert.rejects(rpc(db,'content_erasure_sweep_sessions',1,new Date().toISOString(),null),/SWEEP_CURSOR/);
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_executions WHERE id=$1 FOR UPDATE',[s2.execution]);
  // A permanent failure (not lock contention) in s4's cleanup.
  await db.query(`CREATE FUNCTION public.zz_fail_s4() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   IF NEW.id='${s4.session}' AND NEW.erased_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic permanent failure'; END IF;
   RETURN NEW;END$$`);
  await db.query('CREATE TRIGGER zz_fail_s4 BEFORE UPDATE ON runtime_sessions FOR EACH ROW EXECUTE FUNCTION public.zz_fail_s4()');
  let cursor=null;const totals={cleaned:0,pending:0,failed:0};let pages=0;
  do{const page=await sweep(1,cursor);pages++;for(const k of Object.keys(totals))totals[k]+=page[k];
   cursor=page.more?page:null;}while(cursor&&pages<1000);
  await locker.query('ROLLBACK');
  await db.query('DROP TRIGGER zz_fail_s4 ON runtime_sessions');await db.query('DROP FUNCTION public.zz_fail_s4()');
  assert.ok(totals.pending>=1,'lock contention stays pending');
  assert.ok(totals.failed>=1,'a permanent failure is reported, not hidden as pending');
  assert.ok((await row(db,'runtime_sessions',s1.session)).erased_at,'paging reached every page');
  assert.equal((await row(db,'runtime_sessions',s2.session)).erased_at,null);
  assert.equal((await row(db,'runtime_sessions',s4.session)).erased_at,null);
  cursor=null;do{const page=await sweep(200,cursor);cursor=page.more?page:null;}while(cursor);
  assert.ok((await row(db,'runtime_sessions',s2.session)).erased_at,'busy one retried on the next run');
  assert.ok((await row(db,'runtime_sessions',s4.session)).erased_at,'failed one retried once fixed');
  assert.equal((await row(db,'runtime_sessions',s3.session)).erased_at,null,'closed account left to account erasure');
  await rpc(db,'account_erasure_scrub_runtime',s3.actor);
  report.checks.push('sweep: pages by cursor, busy stays pending, permanent failures counted as failed, closed accounts skipped');
 }finally{await db.query('RESET ROLE');await locker.query('ROLLBACK');await locker.end();}
}
