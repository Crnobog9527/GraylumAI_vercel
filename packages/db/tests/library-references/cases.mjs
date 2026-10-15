/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc,closeAccount,outcome,evidence} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>String(error.message).includes(code),code);};
const doc=(db,a,name,n=3,status='ready',version=1,kind='document')=>
 one(db,'SELECT lr_test.doc($1,$2,$3,$4,$5,$6) v',[a,name,n,status,version,kind]);
const exec=(db,a,sid,refs=null,state='running')=>
 one(db,'SELECT lr_test.exec($1,$2,$3,$4) v',[a,sid,refs===null?null:JSON.stringify(refs),state]);
const read=(db,a,e,query='')=>rpc(db,'runtime_library_read',a,e,query);
const ref=(documentId,version=1)=>({documentId,version});
// Library entry points require the service role (library_actor); runtime functions take the actor explicitly.
const del=async(db,a,d)=>{await db.query('SET ROLE service_role');try{return await rpc(db,'library_delete',a,d,false,false,false);}finally{await db.query('RESET ROLE');}};
const money=async(db,a)=>(await db.query(`SELECT (SELECT credits FROM profiles WHERE id=$1) credits,
 (SELECT jsonb_agg(to_jsonb(x)-ARRAY['reason','metadata','content_erased_at'] ORDER BY id) FROM billing_history x WHERE user_id=$1) history,
 (SELECT jsonb_agg(to_jsonb(x)-ARRAY['description','metadata','content_erased_at'] ORDER BY id) FROM credit_transactions x WHERE user_id=$1) ledger,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'charged',to_jsonb(c)->'charged_credits','cost',to_jsonb(c)->'cost_usd') ORDER BY id)
  FROM bill2_calls c WHERE run_id IN (SELECT id FROM bill2_runs WHERE actor_id=$1)) calls`,[a])).rows[0];
const store=(db,e,callId,result)=>db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
 VALUES($1,$2,'read_source','{"query":"doc-1"}',$3)`,[e,callId,result]);

export async function runCases({db,Client,connectionString,report}) {
 const a=await one(db,'SELECT ws_test.actor() v'),sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 const guide=await doc(db,a,'Guide.md',30),notes=await doc(db,a,'Notes.md',2);

 // Freezing: rows in reference order, only for executions that carry references.
 const e=await exec(db,a,sid,[ref(guide),ref(notes)]);
 assert.deepEqual((await db.query('SELECT document_id,ordinal,content_version FROM runtime_library_references WHERE execution_id=$1 ORDER BY ordinal',[e]))
  .rows.map(r=>[r.document_id,r.ordinal,r.content_version]),[[guide,1,1],[notes,2,1]]);
 const plain=await exec(db,a,sid);
 assert.equal(await one(db,'SELECT count(*)::int v FROM runtime_library_references WHERE execution_id=$1',[plain]),0);
 report.checks.push('references freeze in order with the execution; an execution without references freezes nothing');

 // Without references the trigger function is never called (WHEN clause), and inserts take the same time.
 await db.query('BEGIN');await db.query("SET LOCAL track_functions='pl'");
 for(let i=0;i<50;i++)await exec(db,a,sid);
 const calls=await one(db,"SELECT coalesce(pg_stat_get_xact_function_calls('public.runtime_library_references_freeze()'::regprocedure),0)::int v");
 await db.query('ROLLBACK');
 assert.equal(calls,0,'no call for executions without references');
 const timed=async()=>{const t=process.hrtime.bigint();await db.query(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision,state)
  SELECT $1,$2,gen_random_uuid(),'{"role":"ordinary","input":"q"}',0,'completed' FROM generate_series(1,2000)`,[a,sid]);return Number(process.hrtime.bigint()-t)/1e6;};
 await timed();
 const withTrigger=Math.min(await timed(),await timed(),await timed());
 await db.query('ALTER TABLE runtime_executions DISABLE TRIGGER runtime_library_references_freeze');
 const withoutTrigger=Math.min(await timed(),await timed(),await timed());
 await db.query('ALTER TABLE runtime_executions ENABLE TRIGGER runtime_library_references_freeze');
 report.timing={insertsWithoutReferences:2000,withTriggerMs:Math.round(withTrigger),withoutTriggerMs:Math.round(withoutTrigger)};
 assert.ok(withTrigger<=withoutTrigger*1.25+50,JSON.stringify(report.timing));
 report.checks.push(`no-reference admissions: trigger never called; 2000 inserts ${report.timing.withTriggerMs} ms with vs ${report.timing.withoutTriggerMs} ms without`);

 // Refusals roll back the whole execution.
 const other=await one(db,'SELECT ws_test.actor() v'),otherDoc=await doc(db,other,'Private.md');
 const before=await one(db,'SELECT count(*)::int v FROM runtime_executions WHERE actor_id=$1',[a]);
 const pending=await doc(db,a,'Pending.md',1,'processing'),empty=await doc(db,a,'Empty.md',0),image=await doc(db,a,'pic.png',0,'ready',1,'image');
 const doomed=await doc(db,a,'Doomed.md');await del(db,a,doomed);
 for(const [refs,code] of [[[ref(otherDoc)],'LIB_REFERENCE_NOT_FOUND'],[[ref(doomed)],'LIB_REFERENCE_NOT_FOUND'],
  [[ref(image)],'LIB_REFERENCE_NOT_FOUND'],[[ref(pending)],'LIB_REFERENCE_NOT_READY'],[[ref(empty)],'LIB_REFERENCE_NOT_READY'],
  [[ref(guide,2)],'LIB_REFERENCE_STALE'],[[],'LIB_REFERENCE_INVALID'],[[ref(guide),ref(guide.toUpperCase())],'LIB_REFERENCE_INVALID'],
  [[{...ref(guide),filename:'x'}],'LIB_REFERENCE_INVALID'],[[{documentId:guide,version:'1'}],'LIB_REFERENCE_INVALID'],
  [Array.from({length:6},()=>ref(guide)),'LIB_REFERENCE_INVALID']])
  await denied(exec(db,a,sid,refs),code);
 assert.equal(await one(db,'SELECT count(*)::int v FROM runtime_executions WHERE actor_id=$1',[a]),before,'refused admissions leave no execution');
 report.checks.push('refused: another user\'s document, deleted, image, processing, no text, stale version, empty, duplicate, extra key, bad version, six references; nothing is created');

 // Reads: index, directory pages, one segment, unknown queries, limits, other users and finished executions.
 const index=await read(db,a,e);
 assert.deepEqual(index.documents.map(d=>[d.ref,d.title,d.available,d.segments]),[['doc-1','Guide.md',true,30],['doc-2','Notes.md',true,2]]);
 const page1=await read(db,a,e,'doc-1'),page2=await read(db,a,e,'doc-1/page-2');
 assert.equal(page1.kind,'library_directory');assert.equal(page1.pages,2);assert.equal(page1.entries.length,25);
 assert.deepEqual(page2.entries.map(x=>x.segment),[26,27,28,29,30]);
 assert.ok(!JSON.stringify(page1).includes('LR_CANARY'),'directory carries titles only');
 const seg=await read(db,a,e,'doc-2/segment-2');
 assert.deepEqual([seg.kind,seg.segment,seg.body,seg.truncated],['library_segment',2,'LR_CANARY Notes.md segment 2',false]);
 for(const query of ['doc-3','doc-2/segment-3','doc-6','doc-1/page-0','../etc','doc-1/segment-1;drop'])
  assert.equal((await read(db,a,e,query)).kind,'unavailable',query);
 await denied(read(db,other,e,'doc-1'),'LIB_REFERENCE_READ_DENIED');
 await denied(read(db,a,plain,'doc-1'),'LIB_REFERENCE_READ_DENIED');
 const finished=await exec(db,a,sid,[ref(guide)],'completed');
 await denied(read(db,a,finished,'doc-1'),'LIB_REFERENCE_READ_DENIED');
 report.checks.push('reads: index, 25-title pages, one segment; unknown or malformed queries unavailable; other users, executions without references and finished executions denied');

 const big=await doc(db,a,'Big.md',1);
 await db.query("UPDATE library_document_segments SET body=repeat('\"\\',4096) WHERE document_id=$1",[big]);
 const heavy=await exec(db,a,sid,[ref(big)]);
 const bounded=await read(db,a,heavy,'doc-1/segment-1');
 assert.equal(bounded.truncated,true);
 assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(bounded)))<=16384);
 const budget=await exec(db,a,sid,[ref(guide)]);
 for(let i=0;i<8;i++)await store(db,budget,'r'+i,await read(db,a,budget,'doc-1/segment-'+(i+1)));
 assert.deepEqual(await read(db,a,budget,'doc-1/segment-9'),{kind:'unavailable',reason:'read_limit'});
 report.checks.push('an escaped segment stays within 16,384 bytes; the ninth read of an execution is refused');
 let escapedReads=0;
 for(;escapedReads<8;escapedReads++){
  const value=await read(db,a,heavy,'doc-1/segment-1');
  if(value.reason==='read_limit')break;
  await store(db,heavy,'escaped-'+escapedReads,value);
 }
 const escapedBytes=Number(await one(db,`SELECT sum(octet_length(to_jsonb(result::text)::text)) v
  FROM runtime_tool_calls WHERE execution_id=$1`,[heavy]));
 assert.ok(escapedReads<8&&escapedBytes<=65536,'serialized byte budget stops before the read-count limit');
 assert.deepEqual(await read(db,a,heavy,'doc-1/segment-1'),{kind:'unavailable',reason:'read_limit'});
 report.checks.push('cumulative budget counts the same escaped representation as individual results');


 // Storing and replaying: the guard and the visibility check follow the document.
 const reader=await exec(db,a,sid,[ref(notes)]);
 const frozenIndex=await read(db,a,reader);
 assert.equal(await rpc(db,'runtime_library_visible',a,reader,frozenIndex),true);
 assert.equal(await rpc(db,'runtime_library_visible',other,reader,frozenIndex),false);
 await db.query('UPDATE library_documents SET content_version=2 WHERE id=$1',[notes]);
 assert.equal(await rpc(db,'runtime_library_visible',a,reader,frozenIndex),false,'version drift invalidates the frozen index');
 await db.query('UPDATE library_documents SET content_version=1 WHERE id=$1',[notes]);
 const copy=await read(db,a,reader,'doc-1/segment-1');
 await store(db,reader,'c1',copy);
 await store(db,reader,'index1',frozenIndex);
 assert.equal(await rpc(db,'runtime_library_visible',a,reader,copy),true);
 assert.equal(await rpc(db,'runtime_library_visible',other,reader,copy),false);
 await denied(store(db,reader,'forged',{...copy,documentId:guide}),'LIB_REFERENCE_REVOKED');
 report.checks.push('a frozen read is visible to its owner only; a read of an unreferenced document cannot be stored');

 // Deletion and reading or freezing are strictly ordered on the document row lock.
 const deleter=new Client({connectionString});await deleter.connect();
 try {
  await deleter.query('BEGIN');await deleter.query('SET LOCAL ROLE service_role');
  await deleter.query('SELECT public.library_delete($1,$2,false,false,false)',[a,notes]);
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
  await assert.rejects(read(db,a,reader,'doc-1/segment-2'),error=>error.code==='55P03');
  await db.query('ROLLBACK');
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
  await assert.rejects(exec(db,a,sid,[ref(notes)]),error=>error.code==='55P03');
  await db.query('ROLLBACK');
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
  await assert.rejects(db.query("UPDATE runtime_tool_calls SET result=$2 WHERE execution_id=$1 AND call_id='c1'",[reader,copy]),error=>error.code==='55P03');
  await db.query('ROLLBACK');
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
  await assert.rejects(read(db,a,reader),error=>error.code==='55P03');
  await db.query('ROLLBACK');
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
  await assert.rejects(store(db,reader,'index-race',frozenIndex),error=>error.code==='55P03');
  await db.query('ROLLBACK');
  await deleter.query('COMMIT');
 } finally {await deleter.end();}
 assert.deepEqual(await read(db,a,reader,'doc-1/segment-2'),{kind:'unavailable',reason:'source_deleted',ref:'doc-1'});
 await denied(exec(db,a,sid,[ref(notes)]),'LIB_REFERENCE_NOT_FOUND');
 await denied(store(db,reader,'late',copy),'LIB_REFERENCE_REVOKED');
 await denied(store(db,reader,'late-index',frozenIndex),'LIB_REFERENCE_REVOKED');
 assert.equal(await rpc(db,'runtime_library_visible',a,reader,copy),false);
 assert.equal(await rpc(db,'runtime_library_visible',a,reader,frozenIndex),false,'deleted index cannot replay its filename');
 assert.equal((await read(db,a,reader)).documents[0].available,false);
 report.checks.push('a deletion in progress blocks reads, new references and storing a read; after it commits every path answers deleted');

 // Cleanup: a settled execution keeps its answer and exact money; copies and receipt bodies are removed.
 const f=await runtimeFixture(db,{settled:true});
 const settledDoc=await doc(db,f.actor,'Settled.md');
 await db.query('INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal) VALUES($1,$2,$3,1,1)',[f.execution,f.actor,settledDoc]);
 await db.query("UPDATE runtime_executions SET state='running' WHERE id=$1",[f.execution]);
 const settledCopy=await read(db,f.actor,f.execution,'doc-1/segment-1');
 await store(db,f.execution,'s1',settledCopy);
 await db.query("UPDATE runtime_executions SET state='completed' WHERE id=$1",[f.execution]);
 const rev=await one(db,'SELECT coalesce(max(revision),0)::bigint v FROM runtime_session_history WHERE session_id=$1',[f.session]);
 await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item) VALUES
  ($1,$3+1,$2,'{"role":"user","content":"KEEP_USER_WORDS"}'),($1,$3+2,$2,'{"type":"function_call_result","output":"LR_CANARY copy"}')`,[f.session,f.execution,rev]);
 const live=await doc(db,a,'Live.md'),running=await exec(db,a,sid,[ref(live)]);
 await store(db,running,'l1',await read(db,a,running,'doc-1/segment-1'));
 const moneyBefore=await money(db,f.actor);
 await del(db,f.actor,settledDoc);
 await del(db,a,live);
 const result=await rpc(db,'runtime_library_propagate',null,100);
 assert.ok(result.processed>=1&&result.waiting>=1,JSON.stringify(result));
 assert.deepEqual(await money(db,f.actor),moneyBefore,'settled money unchanged');
 const row=(await db.query('SELECT result,state FROM runtime_executions WHERE id=$1',[f.execution])).rows[0];
 assert.deepEqual([row.result,row.state],[outcome,'completed'],'the shown answer stays (D7)');
 assert.equal(await one(db,"SELECT result IS NULL AND erased_at IS NOT NULL v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='s1'",[f.execution]),true);
 const history=(await db.query('SELECT item FROM runtime_session_history WHERE execution_id=$1 ORDER BY revision',[f.execution])).rows.map(r=>r.item);
 assert.ok(history.some(i=>i?.content==='KEEP_USER_WORDS'));assert.ok(!JSON.stringify(history).includes('LR_CANARY'));
 const receipts=(await db.query('SELECT r.payload FROM bill2_receipts r JOIN bill2_calls c ON c.id=r.call_id WHERE c.run_id=$1',[f.run])).rows;
 assert.ok(receipts.length>0);assert.ok(!JSON.stringify(receipts).includes('B2A_PRIVATE_CANARY'));
 assert.ok(await one(db,'SELECT propagated_at IS NOT NULL v FROM runtime_library_references WHERE execution_id=$1',[f.execution]));
 assert.equal(await one(db,"SELECT result IS NOT NULL v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='l1'",[running]),true);
 assert.ok(await one(db,'SELECT propagated_at IS NULL v FROM runtime_library_references WHERE execution_id=$1',[running]));
 assert.equal(await one(db,'SELECT unavailable_reason v FROM runtime_executions WHERE id=$1',[running]),'source_deleted');
 assert.equal((await rpc(db,'runtime_library_propagate',f.actor,10)).processed,0,'repeat finds nothing new');
 report.checks.push('after deletion: a settled execution keeps its answer and exact money; its frozen read, non-user history and receipt bodies are removed; a running execution is source-deleted while financial cleanup waits; repeat is a no-op');

 // Late completions must fail closed even if cleanup has not yet propagated the deletion.
 for(const propagate of [false,true]){
  const pending=await runtimeFixture(db,{dispatched:true});
  const deleted=await doc(db,pending.actor,'Late.md');
  await db.query('INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal) VALUES($1,$2,$3,1,1)',
   [pending.execution,pending.actor,deleted]);
  const deleting=new Client({connectionString});await deleting.connect();
  try{
   await deleting.query('BEGIN');await deleting.query('SET LOCAL ROLE service_role');
   await deleting.query('SELECT public.library_delete($1,$2,false,false,false)',[pending.actor,deleted]);
   await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
   await assert.rejects(rpc(db,'runtime_execution',pending.actor,pending.execution,'complete',outcome),error=>error.code==='55P03');
   await db.query('ROLLBACK');await deleting.query('COMMIT');
  }finally{await deleting.end();}
  if(propagate)await rpc(db,'runtime_library_propagate',pending.actor,10);
  const result=await rpc(db,'runtime_execution',pending.actor,pending.execution,'complete',outcome);
  assert.equal(result.state,'cost_pending','unknown provider cost remains pending, not refunded');
  assert.equal(await one(db,'SELECT result IS NULL v FROM runtime_executions WHERE id=$1',[pending.execution]),true);
  const view=await rpc(db,'runtime_execution',pending.actor,pending.execution,'read',null);
  assert.equal(view.unavailableReason,'source_deleted');assert.equal(view.result,null);
  await rpc(db,'bill2_record',pending.actor,pending.run,pending.call.id,evidence(pending.call));
  await rpc(db,'runtime_financial_recovery',pending.actor,pending.execution,true);
  assert.equal(await one(db,'SELECT state v FROM runtime_executions WHERE id=$1',[pending.execution]),'cancelled');
  assert.equal(await one(db,'SELECT result IS NULL v FROM runtime_executions WHERE id=$1',[pending.execution]),true);
  assert.equal(await one(db,'SELECT active_execution IS NULL v FROM runtime_sessions WHERE id=$1',[pending.session]),true);
 }
 report.checks.push('late completion never persists or shows an answer, before or after propagation; unknown cost waits then settles and releases session');

 // Account erasure owns and prunes the rows; only service_role reaches the functions; nobody reaches the table.
 assert.equal(await rpc(db,'erasure_business_owner','runtime_library_references',{actor_id:a}),a);
 await closeAccount(db,{actor:a});
 assert.ok(await one(db,'SELECT count(*)::int v FROM runtime_library_references WHERE actor_id=$1',[a])>0);
 await rpc(db,'account_erasure_prune_business',a,100);
 assert.equal(await one(db,'SELECT count(*)::int v FROM runtime_library_references WHERE actor_id=$1',[a]),0);
 report.checks.push('account erasure maps the table to its actor and prunes its rows');
 const grants=await db.query(`SELECT f||':'||r||':'||has_function_privilege(r,'public.'||f,'EXECUTE') v FROM
  unnest(ARRAY['runtime_library_read(uuid,uuid,text)','runtime_library_visible(uuid,uuid,jsonb)','runtime_library_propagate(uuid,integer)',
   'runtime_library_references_freeze()','runtime_library_tool_guard()']) f, unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY 1`);
 for(const g of grants.rows.map(x=>x.v)){
  const service=g.includes(':service_role:'),trigger=g.includes('_freeze()')||g.includes('_guard()');
  assert.equal(g.endsWith(':true'),service&&!trigger,g);
 }
 for(const role of ['anon','authenticated','service_role'])
  assert.equal(await one(db,"SELECT has_table_privilege($1,'public.runtime_library_references','SELECT,INSERT,UPDATE,DELETE') v",[role]),false,role);
 const paths=await db.query(`SELECT proname,proconfig FROM pg_proc WHERE proname LIKE 'runtime_library_%'`);
 for(const p of paths.rows)assert.ok(p.proconfig?.includes('search_path=public, pg_temp'),p.proname);
 report.checks.push('functions: service_role only for read/visible/propagate, triggers callable by nobody, fixed search_path; table: no role has access');
}
