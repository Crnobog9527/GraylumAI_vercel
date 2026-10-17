/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT A1: 'search:<words>' through runtime_library_read, its freezing, limits, guard and cleanup.
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>{if(!String(error.message).includes(code))throw error;return true;},code);};
const doc=(db,a,name,n=3,status='ready',version=1,kind='document')=>
 one(db,'SELECT lr_test.doc($1,$2,$3,$4,$5,$6) v',[a,name,n,status,version,kind]);
const exec=async(db,a,sid,{refs=null,retrieval=true,state='running'}={})=>{
 const e=await one(db,'SELECT lr_test.exec($1,$2,$3,$4) v',[a,sid,refs===null?null:JSON.stringify(refs),state]);
 if(retrieval)await db.query(`UPDATE runtime_executions SET payload=payload||'{"libraryRetrieval":true}'::jsonb WHERE id=$1`,[e]);
 return e;
};
const read=(db,a,e,query='')=>rpc(db,'runtime_library_read',a,e,query);
const setBody=(db,d,ordinal,title,body)=>db.query('UPDATE library_document_segments SET title=$3,body=$4 WHERE document_id=$1 AND ordinal=$2',[d,ordinal,title,body]);
const del=async(db,a,d)=>{await db.query('SET ROLE service_role');try{return await rpc(db,'library_delete',a,d,false,false,false);}finally{await db.query('RESET ROLE');}};

export async function runCases({db,report}) {
 const a=await one(db,'SELECT ws_test.actor() v'),sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 const apple=await doc(db,a,'Menu.md',3),bread=await doc(db,a,'Notes.md',2);
 await setBody(db,apple,0,'开场','今天讲苹果派的做法：黄油要冷，面团要醒二十分钟。');
 await setBody(db,apple,1,'烤制','烤箱预热到 180 度，烤四十分钟。');
 await setBody(db,apple,2,'收尾','苹果派放凉再切。');
 await setBody(db,bread,0,'Banana','Banana bread recipe: ripe bananas, brown sugar.');
 await setBody(db,bread,1,'Other','Nothing about fruit here.');

 // Only an execution frozen with libraryRetrieval (or @ references) may search.
 const plain=await exec(db,a,sid,{retrieval:false});
 await denied(read(db,a,plain,'search:苹果派'),'LIB_REFERENCE_READ_DENIED');
 report.checks.push('search is refused for an execution that froze neither @ references nor libraryRetrieval');

 // Chinese and English words match; hits are frozen as doc-N with origin retrieved and readable.
 const e=await exec(db,a,sid);
 const found=await read(db,a,e,'search:苹果派');
 assert.equal(found.kind,'library_search');
 assert.deepEqual(found.hits.map(h=>[h.ref,h.title,h.segment]),[['doc-1','Menu.md',1],['doc-1','Menu.md',3]]);
 assert.ok(found.hits[0].excerpt.includes('苹果派')&&found.hits[0].version===1);
 assert.ok(!JSON.stringify(found).includes('Banana'));
 assert.deepEqual((await db.query('SELECT document_id,ordinal,origin FROM runtime_library_references WHERE execution_id=$1',[e])).rows,
  [{document_id:apple,ordinal:1,origin:'retrieved'}]);
 const segment=await read(db,a,e,'doc-1/segment-2');
 assert.equal(segment.kind,'library_segment');assert.ok(segment.body.includes('180'));
 const english=await read(db,a,e,'search: banana');
 assert.deepEqual(english.hits.map(h=>[h.ref,h.title]),[['doc-2','Notes.md']]);
 assert.equal((await read(db,a,e,'doc-2/segment-1')).kind,'library_segment');
 // The same document found again keeps its number.
 assert.equal((await read(db,a,e,'search:黄油 苹果派')).hits[0].ref,'doc-1');
 report.checks.push('Chinese and English words find their documents; hits freeze as retrieved doc-N and read like @ references');

 // A 2-character word (very common in Chinese) matches bodies; a 1-character word matches only titles and file names.
 const shortWord=await exec(db,a,sid);
 assert.ok((await read(db,a,shortWord,'search:黄油')).hits.length>0,'a 2-character word matches bodies');
 assert.deepEqual((await read(db,a,shortWord,'search:黄')).hits,[],'a 1-character word does not scan bodies');
 assert.equal((await read(db,a,shortWord,'search:开')).hits[0].title,'Menu.md');
 report.checks.push('2-character words match bodies; 1-character words match titles and file names only');

 // Never found: other users, deleted, not ready, non-text documents, other user'"'"'s numbers.
 const other=await one(db,'SELECT ws_test.actor() v');
 const foreign=await doc(db,other,'Foreign.md',1);await setBody(db,foreign,0,'x','苹果派 FOREIGN_CANARY');
 const failed=await doc(db,a,'Failed.md',1,'failed');await setBody(db,failed,0,'x','苹果派 FAILED_CANARY');
 const image=await doc(db,a,'Photo.png',1,'ready',1,'image');await setBody(db,image,0,'x','苹果派 IMAGE_CANARY');
 const gone=await doc(db,a,'Gone.md',1);await setBody(db,gone,0,'x','苹果派 GONE_CANARY');await del(db,a,gone);
 const hidden=await exec(db,a,sid);
 const visible=JSON.stringify(await read(db,a,hidden,'search:苹果派'));
 for(const canary of ['FOREIGN_CANARY','FAILED_CANARY','IMAGE_CANARY','GONE_CANARY'])assert.ok(!visible.includes(canary),canary);
 report.checks.push('other users, failed, non-text and deleted documents are never found');

 // Bad queries and limits.
 const limits=await exec(db,a,sid);
 for(const q of ['search:','search:   ','search:a b c d e f','search:'+'x'.repeat(41)])
  assert.deepEqual(await read(db,a,limits,q),{kind:'unavailable',reason:'unknown_query'},q);
 // Special characters are matched literally, not as patterns.
 assert.deepEqual((await read(db,a,limits,'search:%%%')).hits,[]);
 assert.deepEqual((await read(db,a,limits,'search:___')).hits,[]);
 report.checks.push('empty, too many or too long words are refused; % and _ match literally');

 // Three searches per execution; the stored results count toward them.
 const three=await exec(db,a,sid);
 for(let i=0;i<3;i++){
  const result=await read(db,a,three,'search:苹果派');
  await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,$2,'read_source',$3,$4)`,
   [three,'s'+i,{query:'search:苹果派'},result]);
 }
 assert.deepEqual((await db.query("SELECT result->>'kind' k FROM runtime_tool_calls WHERE execution_id=$1 ORDER BY call_id",[three])).rows.map(r=>r.k),['library_search','library_search','library_search']);
 assert.deepEqual(await read(db,a,three,'search:苹果派'),{kind:'unavailable',reason:'read_limit'});
 report.checks.push('a fourth search in one execution answers read_limit');

 // doc-1 … doc-29: five @ references plus 24 retrieved documents; doc-30 does not exist.
 const refs=[];for(let i=0;i<5;i++)refs.push({documentId:await doc(db,a,`Ref${i}.md`,1),version:1});
 const big=await exec(db,a,sid,{refs});
 for(const [n,word] of [[1,'alphaword'],[2,'betaword'],[3,'gammaword']])
  for(let i=0;i<8;i++){const d=await doc(db,a,`Bulk${n}-${i}.md`,1);await setBody(db,d,0,'t',`${word} content ${i}`);}
 for(const word of ['alphaword','betaword','gammaword']){
  const result=await read(db,a,big,'search:'+word);assert.equal(result.hits.length,8);
  await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,$2,'read_source',$3,$4)`,
   [big,'b'+word,{query:'search:'+word},result]);
 }
 assert.equal(await one(db,'SELECT max(ordinal)::int v FROM runtime_library_references WHERE execution_id=$1',[big]),29);
 // Reads count too: only 3 of the 8 are used by the searches above.
 assert.equal((await read(db,a,big,'doc-29/segment-1')).kind,'library_segment');
 assert.deepEqual(await read(db,a,big,'doc-30'),{kind:'unavailable',reason:'unknown_query'});
 report.checks.push('five @ references plus 24 retrieved documents reach doc-29; doc-30 is unknown');

 // The execution without @ references lists what its searches found.
 const listing=await read(db,a,e,'');
 assert.deepEqual(listing.documents.map(d=>[d.ref,d.title]),[['doc-1','Menu.md'],['doc-2','Notes.md']]);
 report.checks.push('library index lists retrieved documents of an execution without @ references');

 // Trigram indexes are used by the ILIKE patterns (index scans forced so a tiny table cannot hide a missing index).
 await db.query('BEGIN');await db.query('SET LOCAL enable_seqscan=off');
 try{
  for(const [table,column,pattern] of [['library_document_segments','body','%苹果派%'],['library_document_segments','title','%开场%'],
   ['library_documents','filename','%Menu%']]){
   const plan=(await db.query(`EXPLAIN SELECT 1 FROM ${table} WHERE ${column} ILIKE $1`.replace('$1',`'${pattern}'`))).rows.map(r=>r['QUERY PLAN']).join('\n');
   assert.ok(/trgm/.test(plan),`${table}.${column}: ${plan}`);
  }
 }finally{await db.query('ROLLBACK');}
 report.checks.push('trigram indexes serve ILIKE on segment body, segment title and file name');

 // Replay: a stored search result is visible only while all its documents are live at their frozen version.
 const replay=await exec(db,a,sid);
 const stored=await read(db,a,replay,'search:苹果派');
 assert.equal(await rpc(db,'runtime_library_visible',a,replay,stored),true);
 const temp=await doc(db,a,'Temp.md',1);await setBody(db,temp,0,'x','tempword content');
 const tempResult=await read(db,a,replay,'search:tempword');
 assert.equal(await rpc(db,'runtime_library_visible',a,replay,tempResult),true);
 await del(db,a,temp);
 assert.equal(await rpc(db,'runtime_library_visible',a,replay,tempResult),false);
 assert.equal(await rpc(db,'runtime_library_visible',a,replay,stored),true);
 report.checks.push('a replayed search result is visible only while its documents are live');

 // Deletion race: the search result is stored after its document was deleted -> unavailable, no excerpt.
 const f=await runtimeFixture(db,{});
 const racy=await doc(db,f.actor,'RACE_NAME.md',1);await setBody(db,racy,0,'x','racyword RACE_CANARY');
 await db.query(`UPDATE runtime_executions SET state='running',payload=payload||'{"tools":["read_source"],"maxToolCalls":8,"libraryRetrieval":true}'::jsonb WHERE id=$1`,[f.execution]);
 await rpc(db,'runtime_tool',f.actor,f.execution,'race','read_source',{query:'search:racyword'},'claim',null);
 const racyValue=await read(db,f.actor,f.execution,'search:racyword');
 assert.ok(JSON.stringify(racyValue).includes('RACE_CANARY'));
 await del(db,f.actor,racy);
 const completed=await rpc(db,'runtime_tool',f.actor,f.execution,'race','read_source',{query:'search:racyword'},'complete',racyValue);
 assert.deepEqual(completed.result,{kind:'unavailable',reason:'source_deleted'});
 assert.ok(!JSON.stringify(await one(db,"SELECT result v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='race'",[f.execution])).includes('RACE_CANARY'));
 report.checks.push('a search result stored after its document was deleted becomes source_deleted without the excerpt');

 // Cleanup: after the deletion, finished executions lose the stored search result like other library reads.
 const g=await runtimeFixture(db,{settled:true});
 const cleanup=await doc(db,g.actor,'CLEANUP_NAME.md',1);await setBody(db,cleanup,0,'x','cleanupword CLEANUP_CANARY');
 await db.query(`UPDATE runtime_executions SET payload=payload||'{"tools":["read_source"],"maxToolCalls":8,"libraryRetrieval":true}'::jsonb WHERE id=$1`,[g.execution]);
 const cleanupValue=await read(db,g.actor,g.execution,'search:cleanupword').catch(async()=>null);
 if(cleanupValue===null){ // the settled fixture is not 'running': freeze the reference and result by hand
  await db.query(`INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal,origin) VALUES($1,$2,$3,1,1,'retrieved')`,
   [g.execution,g.actor,cleanup]);
 }
 await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,'clean','read_source','{"query":"search:cleanupword"}',$2)`,
  [g.execution,{kind:'library_search',terms:['cleanupword'],hits:[{ref:'doc-1',documentId:cleanup,version:1,title:'CLEANUP_NAME.md',segment:1,excerpt:'CLEANUP_CANARY'}]}]);
 await del(db,g.actor,cleanup);
 await rpc(db,'runtime_library_propagate',g.actor,20);
 assert.equal(await one(db,"SELECT result IS NULL v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='clean'",[g.execution]),true);
 report.checks.push('the deletion cleanup removes stored search results with the other library reads');
}
