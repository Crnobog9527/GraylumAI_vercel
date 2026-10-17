/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT A2b: runtime_work_items, the read-only projection of what the coach read before each answer.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>{if(!String(error.message).includes(code))throw error;return true;},code);};
const doc=(db,a,name,n=3)=>one(db,'SELECT lr_test.doc($1,$2,$3) v',[a,name,n]);
const setBody=(db,d,ordinal,title,body)=>db.query('UPDATE library_document_segments SET title=$3,body=$4 WHERE document_id=$1 AND ordinal=$2',[d,ordinal,title,body]);
const exec=async(db,a,sid,state='running')=>{
 const e=await one(db,'SELECT lr_test.exec($1,$2,NULL,$3) v',[a,sid,state]);
 await db.query(`UPDATE runtime_executions SET payload=payload||'{"libraryRetrieval":true}'::jsonb WHERE id=$1`,[e]);
 return e;
};
const read=(db,a,e,query)=>rpc(db,'runtime_library_read',a,e,query);
const store=(db,e,callId,query,result)=>db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,$2,'read_source',$3,$4)`,
 [e,callId,{query},result]);
const items=async(db,a,sid)=>rpc(db,'runtime_work_items',a,sid);
const del=async(db,a,d)=>{await db.query('SET ROLE service_role');try{return await rpc(db,'library_delete',a,d,false,false,false);}finally{await db.query('RESET ROLE');}};

export async function runCases({db,report}) {
 const a=await one(db,'SELECT ws_test.actor() v'),sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 assert.deepEqual(await items(db,a,sid),{},'a conversation without reads has no rows');
 const menu=await doc(db,a,'Menu.md',3),notes=await doc(db,a,'Notes.md',2);
 await setBody(db,menu,0,'开场','苹果派的做法 SECRET_BODY_CANARY');
 await setBody(db,notes,0,'笔记','苹果派 的另一篇');
 const pos=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Tea studio','POSITIONING_CANARY']);

 // One answer: the positioning read, a search with two documents, a segment read.
 const e=await exec(db,a,sid);
 const index=await rpc(db,'runtime_workspace_source',a,sid,'');
 await store(db,e,'c0','',index); // a directory listing is not a work row
 await store(db,e,'c1',pos.business,await rpc(db,'runtime_workspace_source',a,sid,pos.business));
 const found=await read(db,a,e,'search:苹果派');
 await store(db,e,'c2','search:苹果派',found);
 const segment=await read(db,a,e,'doc-1/segment-1');
 await store(db,e,'c3','doc-1/segment-1',segment);
 let view=await items(db,a,sid);
 const rows=view[e];
 assert.deepEqual(rows.map(r=>[r.kind,r.state,r.label,r.id]),[
  ['positioning','done','读了你确认的定位','c1'],
  ['library_search','done','在资料库里找到 2 篇相关内容','c2'],
  ['library_read','done','读了一段资料','c3']]);
 assert.equal(rows[0].detail,'Tea studio');
 assert.ok(rows[1].detail.includes('Menu.md')&&rows[1].detail.includes('Notes.md'));
 assert.equal(rows[2].detail,segment.title);
 for(const secret of ['SECRET_BODY_CANARY','POSITIONING_CANARY'])assert.ok(!JSON.stringify(view).includes(secret),secret+' must not leave the database');
 report.checks.push('positioning read, search (distinct documents, file names) and segment read become rows in a fixed order; bodies never leave');

 // A search with nothing found, and a claimed call still running.
 const e2=await exec(db,a,sid);
 await store(db,e2,'n1','search:根本没有这个词xyz',await read(db,a,e2,'search:根本没有这个词xyz'));
 await store(db,e2,'r1','search:定位 选题',null);
 view=await items(db,a,sid);
 assert.deepEqual(view[e2].map(r=>[r.kind,r.state]),[['library_search','missing'],['library_search','running']]);
 assert.ok(view[e2][0].detail.startsWith('搜索词：'));
 // A running row is not shown once the execution is no longer running.
 await db.query("UPDATE runtime_executions SET state='interrupted' WHERE id=$1",[e2]);
 assert.deepEqual((await items(db,a,sid))[e2].map(r=>r.state),['missing']);
 report.checks.push('a search without hits and a claimed call that is still running are rows; a stale running row is dropped');

 // Deleting a document hides every row that came from it at once (before any cleanup).
 const temp=await doc(db,a,'Temp.md',1);await setBody(db,temp,0,'x','tempword content');
 const e3=await exec(db,a,sid);
 await store(db,e3,'t1','search:tempword',await read(db,a,e3,'search:tempword'));
 assert.equal((await items(db,a,sid))[e3][0].label,'在资料库里找到 1 篇相关内容');
 await del(db,a,temp);
 assert.equal((await items(db,a,sid))[e3],undefined,'rows of a deleted document disappear at once');
 report.checks.push('deleting a document removes the rows that came from it immediately');

 // Erased or deleted answers and conversations return nothing; other users are refused.
 const e4=await exec(db,a,sid);
 await store(db,e4,'x1','search:苹果派',await read(db,a,e4,'search:苹果派'));
 assert.ok((await items(db,a,sid))[e4]);
 await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');
 await db.query('UPDATE runtime_executions SET content_deleted_at=now() WHERE id=$1',[e4]);await db.query('COMMIT');
 assert.equal((await items(db,a,sid))[e4],undefined);
 const other=await one(db,'SELECT ws_test.actor() v');
 await denied(items(db,other,sid),'RUNTIME_SCOPE_DENIED');
 report.checks.push('deleted answers return no rows and another user is refused');

 // At most 12 rows per answer.
 const e5=await exec(db,a,sid);
 for(let i=0;i<15;i++)await store(db,e5,'m'+String(i).padStart(2,'0'),'search:苹果派',null);
 assert.equal((await items(db,a,sid))[e5].length,12);
 report.checks.push('at most 12 rows per answer');

 // A closed account is refused too, and the owner's other session never shows these rows.
 const closing=await one(db,'SELECT ws_test.actor() v');
 const closingSid=await one(db,'SELECT ws_test.free_session($1) v',[closing]);
 await closeAccount(db,{actor:closing});
 await denied(items(db,closing,closingSid),'BILL2_ACTOR_DENIED');
 const sid2=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 assert.deepEqual(await items(db,a,sid2),{});
 report.checks.push('a closed account is refused; rows belong to their own conversation only');

 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_work_items(uuid,uuid)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('execute stays service_role only');
}
