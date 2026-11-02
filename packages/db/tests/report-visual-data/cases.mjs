/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REPORT-VISUAL 0300: the report text vs its strategy data block; data stored at 定稿; erasure. No model call.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture,rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
import {seed} from '../report-finalization/cases.mjs';
const hash=body=>createHash('sha256').update(body).digest('hex');
const block=(summary='先做小红书')=>['```graylum-report-data',JSON.stringify({v:1,field:'summary',value:summary}),'```'].join('\n');
const text=(fill='')=>`## One\nVISUAL_PRIVATE_TEXT${fill}\n## Two\nKnown limitations.`;
const withData=(t=text(),b=block())=>`${t}\n\n${b}`;
const stored=(body,extra={})=>({dataVersion:1,validatedAt:'2026-10-20T00:00:00.000Z',dropped:[],textEdited:[],
 data:{summary:'VISUAL_PRIVATE_DATA'},bodyHash:hash(body),...extra});

/** A completed report turn whose generated body is `body`. */
async function seedBody(db,body) {
 const f=await seed(db);
 await db.query(`UPDATE session_messages SET content=$2,content_hash=encode(sha256(convert_to($2,'utf8')),'hex') WHERE session_id=$1`,[f.session,body]);
 return f;
}
const doc=(db,f,action,{request=randomUUID(),revision=0,body=null,bodyHash=null,data=null}={})=>
 rpc(db,'report_document',f.actor,f.execution,action,request,revision,body,bodyHash,data);
const read=(db,f)=>rpc(db,'report_document',f.actor,f.execution,'read',null,null,null,null);
const versionReport=async(db,id)=>(await db.query('SELECT report FROM artifact_versions WHERE id=$1',[id])).rows[0]?.report;

export async function runCases({db,report,before0300}) {
 for(const role of ['anon','authenticated']) {
  await db.query('SET ROLE '+role);
  await assert.rejects(rpc(db,'report_document_data_source',randomUUID(),randomUUID()),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 for(const helper of ['report_body_parts($1)','report_final_data($1::jsonb)'])
  await assert.rejects(db.query(`SELECT ${helper}`,[helper.startsWith('report_body')?'x':'{}']),/permission denied/);
 await db.query('RESET ROLE');
 report.checks.push('public roles denied the data source; service_role cannot call the private helpers');

 // 1. The text alone is counted and checked (Owner's choice B); the same rules as the TS splitReportBody.
 const parts=b=>db.query('SELECT report_body_parts($1) v',[b]).then(r=>r.rows[0].v);
 assert.deepEqual(await parts(withData()),{text:text(),block:block()});
 assert.deepEqual(await parts(`${text()}\n\n\`\`\`graylum-report-data\n{"v":1`),{text:text(),block:null});
 assert.deepEqual(await parts(text()),{text:text(),block:null});
 assert.deepEqual(await parts(withData(withData(),block('生成的'))),{text:withData(),block:block('生成的')},'the last block is the data');
 const long=withData(text('字'.repeat(12000-text().length)),block('数'.repeat(5000)));
 const big=await seedBody(db,long);
 await db.query('BEGIN');
 try {
  await db.query(before0300);
  assert.equal((await read(db,big)).candidate,false);
  report.checks.push('before fix (0206): a 12000-character text plus a data block is judged incomplete');
 } finally {await db.query('ROLLBACK');}
 assert.equal((await read(db,big)).candidate,true,'12000-character text plus a data block is complete');
 const over=await seedBody(db,withData(text('字'.repeat(12001-text().length))));
 assert.equal((await read(db,over)).candidate,false,'the text alone over 12000 is not complete');
 report.checks.push('completeness counts the text only: 12000 + 5000-character block complete, 12001-character text not');

 // 2. Hand edits keep the generated block exactly.
 const f=await seedBody(db,withData());
 const edited=withData(text(' edited'));
 await assert.rejects(doc(db,f,'save',{body:text(' edited')}),/REPORT_BODY_INVALID/,'block removed');
 await assert.rejects(doc(db,f,'save',{body:withData(text(' edited'),block('改了数据'))}),/REPORT_BODY_INVALID/,'block changed');
 await assert.rejects(doc(db,f,'save',{body:withData(text('字'.repeat(12001)))}),/REPORT_BODY_INVALID/,'text too long');
 const legacy=await seed(db);
 await assert.rejects(doc(db,legacy,'save',{body:withData()}),/REPORT_BODY_INVALID/,'no block can be added to an old report');
 assert.equal((await doc(db,f,'save',{body:edited})).revision,1);
 report.checks.push('a save must carry exactly the generated block; text-only limit; no block injected into old reports');

 // 3. 定稿 stores the host-checked data only for the very body being finalized.
 await assert.rejects(doc(db,f,'finalize',{revision:1,bodyHash:hash(edited),data:stored(withData())}),/REPORT_DATA_INVALID/);
 await assert.rejects(doc(db,f,'finalize',{revision:1,bodyHash:hash(edited),data:{...stored(edited),dataVersion:2}}),/REPORT_DATA_INVALID/);
 assert.equal((await db.query('SELECT count(*) n FROM artifact_versions WHERE project_id=$1',[f.project])).rows[0].n,'0');
 const emptyTable=(await db.query('SELECT research_benchmark_table($1,$2)->>\'hash\' v',[f.actor,f.session])).rows[0].v;
 await assert.rejects(doc(db,f,'finalize',{revision:1,bodyHash:hash(edited),data:stored(edited,{benchmarkHash:'0'.repeat(64)})}),
  /REPORT_DATA_INVALID/,'numbers from a benchmark table that is no longer current');
 const request=randomUUID();
 const done=await doc(db,f,'finalize',{request,revision:1,bodyHash:hash(edited),data:stored(edited,{textEdited:['summary'],benchmarkHash:emptyTable})});
 assert.equal(done.finalized,true);
 const formal=await versionReport(db,done.versionId);
 assert.equal(formal.generatedReport.body,edited);
 assert.deepEqual(formal.generatedReport.data,{dataVersion:1,validatedAt:'2026-10-20T00:00:00.000Z',dropped:[],
  textEdited:['summary'],data:{summary:'VISUAL_PRIVATE_DATA'}});
 assert.equal((await doc(db,f,'finalize',{request,revision:1,bodyHash:hash(edited),data:stored(edited)})).versionId,done.versionId,
  'replay with recomputed data returns the same version');
 const source=await rpc(db,'report_document_data_source',f.actor,f.execution);
 assert.equal(source.generatedBody,withData());assert.equal(source.sessionId,f.session);
 assert.deepEqual(source.storedData,formal.generatedReport.data);
 const foreign=await fixture(db);
 await assert.rejects(rpc(db,'report_document_data_source',foreign.actor,f.execution),/REPORT_EXECUTION_REQUIRED/);
 report.checks.push('data bound to the finalized body hash and the current benchmark table; stale ones refused atomically; replay stable; owner-only');

 // 3b. A report written with benchmark numbers: the table hash is recomputed from the report turn's conversation (the turn path
 // has no old execution row; an empty-table hash used to be compared against the frozen one and refused every such 定稿).
 const bench=await seedBody(db,withData());
 const benchTurn=(await db.query('SELECT id FROM turns WHERE actor_id=$1 AND request_id=$2',[bench.actor,bench.execution])).rows[0].id;
 const fetched=(await db.query(`INSERT INTO research_account_fetches(actor_id,session_id,platform,account,account_key,state)
  VALUES($1,$2,'tiktok','benchmark_a',encode(sha256(convert_to($2::text||':benchmark_a','utf8')),'hex'),'succeeded') RETURNING id`,
  [bench.actor,bench.session])).rows[0].id;
 await db.query(`INSERT INTO research_benchmarks(fetch_id,actor_id,session_id,turn_actor_id,turn_id,platform,account,followers,
  posts_analyzed,last_published_at,category,qualified,refs,operation_ids,missing,fetched_at)
  VALUES($1,$2,$3,$2,$4,'tiktok','benchmark_a',50000,20,now(),'imitable',true,'{}','{}','{}',now())`,[fetched,bench.actor,bench.session,benchTurn]);
 const benchTable=(await db.query('SELECT research_benchmark_table($1,$2)->>\'hash\' v',[bench.actor,bench.session])).rows[0].v;
 assert.notEqual(benchTable,emptyTable,'the fixture table is not empty');
 await assert.rejects(doc(db,bench,'finalize',{revision:0,bodyHash:hash(withData()),data:stored(withData(),{benchmarkHash:emptyTable})}),
  /REPORT_DATA_INVALID/,'the hash of an empty table is not the current table');
 const benchDone=await doc(db,bench,'finalize',{revision:0,bodyHash:hash(withData()),data:stored(withData(),{benchmarkHash:benchTable})});
 assert.equal(benchDone.finalized,true);
 report.checks.push('a turn-path report finalizes with numbers from its conversation\'s benchmark table; a stale hash is refused');

 const plain=await seed(db);
 const old=await doc(db,plain,'finalize',{bodyHash:hash('## One\nOriginal confirmed facts.\n## Two\nKnown limitations.')});
 assert.equal(Object.hasOwn((await versionReport(db,old.versionId)).generatedReport,'data'),false);
 const noBlock=await seed(db);
 const original='## One\nOriginal confirmed facts.\n## Two\nKnown limitations.';
 await assert.rejects(doc(db,noBlock,'finalize',{bodyHash:hash(original),data:stored(original)}),/REPORT_DATA_INVALID/);
 report.checks.push('a report without a block publishes exactly as before; data is refused for a body without a block');

 // 4. Erasure: deleting the positioning or closing the account leaves no data behind.
 await erase(db,f,'artifact',f.project);
 assert.equal(await versionReport(db,done.versionId),null);
 await assert.rejects(rpc(db,'report_document_data_source',f.actor,f.execution),/CONTENT_ERASED/);
 const rows=JSON.stringify((await db.query('SELECT payload,response FROM artifact_requests WHERE project_id=$1',[f.project])).rows);
 assert.doesNotMatch(rows,/VISUAL_PRIVATE/);
 const closed=await seedBody(db,withData());
 const closedFinal=await doc(db,closed,'finalize',{bodyHash:hash(withData()),data:stored(withData())});
 await closeAccount(db,closed.base);
 await rpc(db,'account_erasure_scrub_content',closed.actor);
 await rpc(db,'account_erasure_scrub_turns',closed.actor);
 await rpc(db,'account_erasure_scrub_runtime',closed.actor);
 assert.equal(await versionReport(db,closedFinal.versionId),null);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT content FROM session_messages WHERE session_id=$1',[closed.session])).rows),
  /VISUAL_PRIVATE/);
 report.checks.push('content deletion and account erasure clear the stored data, the block and the edit copies');
}
