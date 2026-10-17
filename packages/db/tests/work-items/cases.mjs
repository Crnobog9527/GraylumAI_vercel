/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT A2b: runtime_work_items, the read-only projection of what the coach read before each answer.
// Every scenario uses its own billed execution (runtimeFixture): the projection applies runtime_view's availability fence.
import assert from 'node:assert/strict';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>{if(!String(error.message).includes(code))throw error;return true;},code);};
const doc=(db,a,name,n=3)=>one(db,'SELECT lr_test.doc($1,$2,$3) v',[a,name,n]);
const setBody=(db,d,ordinal,title,body)=>db.query('UPDATE library_document_segments SET title=$3,body=$4 WHERE document_id=$1 AND ordinal=$2',[d,ordinal,title,body]);
/** A running, billed execution that may search (the fixture's own payload is replaced by a retrieval payload). */
const scenario=async(db,state='running')=>{
 const f=await runtimeFixture(db,{});
 await db.query(`UPDATE runtime_executions SET state=$2,payload=payload||'{"tools":["read_source"],"maxToolCalls":8,"libraryRetrieval":true}'::jsonb WHERE id=$1`,[f.execution,state]);
 return f;
};
const read=(db,f,query)=>rpc(db,'runtime_library_read',f.actor,f.execution,query);
const store=(db,f,callId,query,result)=>db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,$2,'read_source',$3,$4)`,
 [f.execution,callId,{query},result]);
const items=(db,f)=>rpc(db,'runtime_work_items',f.actor,f.session);
const del=async(db,a,d)=>{await db.query('SET ROLE service_role');try{return await rpc(db,'library_delete',a,d,false,false,false);}finally{await db.query('RESET ROLE');}};
const quietly=async(db,statement,args)=>{await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');
 try{await db.query(statement,args);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}};
const available=async(db,f)=>one(db,'SELECT available v FROM runtime_history_availability(ARRAY[$1::uuid])',[f.execution]);

export async function runCases({db,report}) {
 // A conversation without reads has no rows.
 const empty=await scenario(db);
 assert.deepEqual(await items(db,empty),{});

 // One answer: the positioning read, a search with two documents, a segment read.
 const f=await scenario(db);
 const menu=await doc(db,f.actor,'Menu.md',3),notes=await doc(db,f.actor,'Notes.md',2);
 await setBody(db,menu,0,'开场','苹果派的做法 SECRET_BODY_CANARY');
 await setBody(db,notes,0,'笔记','苹果派 的另一篇');
 await store(db,f,'c0','',{kind:'workspace_index',entries:[{id:'x',kind:'positioning',name:'INDEX_NAME_CANARY'}],dependencies:[]}); // a listing is no row
 await store(db,f,'c1','pos-id',{kind:'workspace_source',identity:{id:'x',kind:'positioning',name:'Tea studio'},body:'POSITIONING_CANARY',dependencies:[]});
 const found=await read(db,f,'search:苹果派');
 await store(db,f,'c2','search:苹果派',found);
 const segment=await read(db,f,'doc-1/segment-1');
 await store(db,f,'c3','doc-1/segment-1',segment);
 let view=await items(db,f);
 const rows=view[f.execution];
 assert.deepEqual(rows.map(r=>[r.kind,r.state,r.label,r.id]),[
  ['positioning','done','读了你确认的定位','c1'],
  ['library_search','done','在资料库里找到 2 篇相关内容','c2'],
  ['library_read','done','读了一段资料','c3']]);
 assert.equal(rows[0].detail,'Tea studio');
 assert.ok(rows[1].detail.includes('Menu.md')&&rows[1].detail.includes('Notes.md'));
 assert.equal(rows[2].detail,segment.title);
 for(const secret of ['SECRET_BODY_CANARY','POSITIONING_CANARY','INDEX_NAME_CANARY'])assert.ok(!JSON.stringify(view).includes(secret),secret+' must not leave the database');
 report.checks.push('positioning read, search (distinct documents, file names) and segment read become rows in a fixed order; bodies and listings never leave');

 // A search with nothing found, and a claimed call that is still running.
 const g=await scenario(db);
 await store(db,g,'n1','search:根本没有这个词xyz',await read(db,g,'search:根本没有这个词xyz'));
 await store(db,g,'r1','search:定位 选题',null);
 view=await items(db,g);
 assert.deepEqual(view[g.execution].map(r=>[r.kind,r.state]),[['library_search','missing'],['library_search','running']]);
 assert.ok(view[g.execution][0].detail.startsWith('搜索词：'));
 await db.query("UPDATE runtime_executions SET state='interrupted' WHERE id=$1",[g.execution]);
 assert.deepEqual((await items(db,g))[g.execution].map(r=>r.state),['missing'],'a stale running row is dropped');
 report.checks.push('a search without hits and a claimed call that is still running are rows; a stale running row is dropped');

 // Deleting a document hides every row that came from it at once (before any cleanup).
 const h=await scenario(db);
 const temp=await doc(db,h.actor,'Temp.md',1);await setBody(db,temp,0,'x','tempword content');
 await store(db,h,'t1','search:tempword',await read(db,h,'search:tempword'));
 assert.equal((await items(db,h))[h.execution][0].label,'在资料库里找到 1 篇相关内容');
 await del(db,h.actor,temp);
 assert.equal((await items(db,h))[h.execution],undefined,'rows of a deleted document disappear at once');
 report.checks.push('deleting a document removes the rows that came from it immediately');

 // runtime_view's fence: an answer it hides (unavailable_reason, failed availability) shows no rows either.
 const u=await scenario(db);
 await store(db,u,'u1','pos-id',{kind:'workspace_source',identity:{id:'x',kind:'positioning',name:'FENCED_NAME'},body:'b',dependencies:[]});
 assert.equal(await available(db,u),true);
 assert.equal((await items(db,u))[u.execution].length,1);
 await db.query("UPDATE runtime_executions SET unavailable_reason='source_deleted' WHERE id=$1",[u.execution]);
 assert.equal((await items(db,u))[u.execution],undefined,'an answer with an unavailable_reason shows no rows');
 await db.query('UPDATE runtime_executions SET unavailable_reason=NULL WHERE id=$1',[u.execution]);
 assert.equal((await items(db,u))[u.execution].length,1);
 // A history dependency on another account's answer is a denied edge: the availability check now refuses this answer.
 const foreign=await runtimeFixture(db,{});
 await db.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[u.execution,foreign.execution]);
 assert.equal(await available(db,u),false,'precondition: runtime_history_availability now refuses this answer');
 assert.equal((await items(db,u))[u.execution],undefined,'an answer that fails the availability check shows no rows');
 report.checks.push('answers runtime_view hides (unavailable_reason, failed runtime_history_availability) show no rows');

 // Deleted answers return nothing; other users are refused.
 const d=await scenario(db);
 await store(db,d,'x1','pos-id',{kind:'workspace_source',identity:{id:'x',kind:'positioning',name:'N'},body:'b',dependencies:[]});
 assert.ok((await items(db,d))[d.execution]);
 await quietly(db,'UPDATE runtime_executions SET content_deleted_at=now() WHERE id=$1',[d.execution]);
 assert.equal((await items(db,d))[d.execution],undefined);
 const stranger=await runtimeFixture(db,{});
 await denied(rpc(db,'runtime_work_items',stranger.actor,d.session),'RUNTIME_SCOPE_DENIED');
 report.checks.push('deleted answers return no rows and another user is refused');

 // At most 12 rows per answer.
 const m=await scenario(db);
 for(let i=0;i<15;i++)await store(db,m,'m'+String(i).padStart(2,'0'),'search:苹果派',null);
 assert.equal((await items(db,m))[m.execution].length,12);
 report.checks.push('at most 12 rows per answer');

 // A closed account is refused too.
 const closing=await scenario(db);
 await closeAccount(db,closing);
 await denied(items(db,closing),'BILL2_ACTOR_DENIED');
 report.checks.push('a closed account is refused');

 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_work_items(uuid,uuid)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('execute stays service_role only');
}
