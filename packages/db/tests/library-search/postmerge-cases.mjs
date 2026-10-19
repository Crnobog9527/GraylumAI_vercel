/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
const read=(db,f,q)=>rpc(db,'runtime_library_read',f.actor,f.execution,q);
const items=(db,f)=>rpc(db,'runtime_work_items',f.actor,f.session);
let ranking,provenance,document,original,readOnlyResult,plans;

async function fixture(db) {
 const f=await runtimeFixture(db,{});
 await db.query(`UPDATE runtime_executions SET state='running',payload=payload||
  '{"tools":["read_source"],"maxToolCalls":8,"libraryRetrieval":true}'::jsonb WHERE id=$1`,[f.execution]);
 return f;
}
async function queryPlans(db,f) {
 const source=await one(db,"SELECT pg_get_functiondef('runtime_library_read(uuid,uuid,text)'::regprocedure) v");
 const queries=[...source.matchAll(/FOR hit IN ([\s\S]*?) LOOP/g)].map(m=>m[1])
  .filter(query=>query.includes('library_document_segments'));
 assert.equal(queries.length,2,'both complete ranking queries are explained');
 const result=[];
 for(const query of queries) {
  const sql=query.replaceAll('p_actor_id','$1::uuid').replaceAll('body_pats','$4::text[]')
   .replaceAll('pats','$3::text[]').replaceAll('terms','$2::text[]').replaceAll('picked','$5::uuid[]');
  const args=[f.actor,['zebrafinding'],['%zebrafinding%'],['%zebrafinding%']];
  if(query.includes('picked'))args.push(plans.documents);
  const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'];
  result.push(plan);
 }
 return result;
}
const hasIndexes=plan=>['library_segments_body_trgm','library_segments_title_trgm','library_documents_filename_trgm']
 .every(index=>JSON.stringify(plan).includes(index));

export async function beforeRepair({db,report}) {
 // Force the most relevant document to sort last by UUID, behind eight weaker equal-score matches.
 ranking=await fixture(db);
 for(let i=1;i<=9;i++) {
  const id=`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`;
  await db.query(`INSERT INTO library_documents(id,actor_id,request_id,kind,format,purpose,filename,status,content_version)
   VALUES($1,$2,gen_random_uuid(),'document','md','reference',$3,'ready',1)`,[id,ranking.actor,'Rank'+i+'.md']);
  await db.query(`INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,source)
   VALUES($1,$2,0,$3,$4,'extracted')`,[id,ranking.actor,i===9?'zebraranking':'unrelated',
   i===9?'zebraranking':'a long introduction '+('different filler '.repeat(80))+' zebraranking '+i]);
 }
 const old=await read(db,ranking,'search:zebraranking');
 assert.ok(!old.hits.some(h=>h.documentId.endsWith('000000000009')),'RED: UUID ordering drops the exact title match');
 report.checks.push('RED reproduced: eight weaker UUID-first results exclude exact-title similarity match');

 provenance=await fixture(db);
 document=await one(db,"SELECT lr_test.doc($1,'Historic.md',1) v",[provenance.actor]);
 await db.query("UPDATE library_document_segments SET title='historyfinding',body='historyfinding body' WHERE document_id=$1",[document]);
 original=await read(db,provenance,'search:historyfinding');
 readOnlyResult=await read(db,provenance,'doc-1/segment-1');
 for(const [id,value] of [['search',original],['segment',readOnlyResult]])
  await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
   VALUES($1,$2,'read_source','{}',$3)`,[provenance.execution,id,value]);
 await db.query("UPDATE runtime_executions SET state='completed' WHERE id=$1",[provenance.execution]);
 assert.equal((await items(db,provenance))[provenance.execution].length,2);
 await db.query('UPDATE library_documents SET content_version=2 WHERE id=$1',[document]);
 assert.equal((await items(db,provenance))[provenance.execution],undefined,'RED: ordinary revision loses provenance');
 report.checks.push('RED reproduced: completed search and segment work rows disappear after document revision');

 // One owner, 3,000 documents and 30,000 segments: sparse matches need all three independent indexes.
 plans=await fixture(db);
 await db.query(`INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename,status,content_version)
  SELECT $1,gen_random_uuid(),'document','md','reference','Plan-'||g||'.md','ready',1 FROM generate_series(1,3000) g`,[plans.actor]);
 await db.query(`INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,source)
  SELECT d.id,d.actor_id,g,'ordinary title',repeat(md5(d.id::text||g),16),'extracted'
  FROM library_documents d CROSS JOIN generate_series(0,9) g WHERE d.actor_id=$1`,[plans.actor]);
 plans.documents=(await db.query('SELECT id FROM library_documents WHERE actor_id=$1 ORDER BY id LIMIT 3',[plans.actor])).rows.map(r=>r.id);
 await db.query("UPDATE library_document_segments SET body='zebrafinding' WHERE document_id=$1 AND ordinal=0",[plans.documents[0]]);
 await db.query("UPDATE library_document_segments SET title='zebrafinding' WHERE document_id=$1 AND ordinal=0",[plans.documents[1]]);
 await db.query("UPDATE library_documents SET filename='zebrafinding.md' WHERE id=$1",[plans.documents[2]]);
 // Flush GIN's bulk-insert pending lists as a maintained library would, then collect normal planner statistics.
 await db.query('VACUUM (ANALYZE) library_documents');
 await db.query('VACUUM (ANALYZE) library_document_segments');
 const oldPlans=await queryPlans(db,plans);
 assert.ok(oldPlans.every(p=>!hasIndexes(p)),'RED: cross-table OR prevents independently indexed complete plans');
 report.explainBefore=oldPlans;
 report.checks.push('RED reproduced: both complete joined ranking queries scan owner segments without three trigram indexes');
}

export async function afterRepair({db,report}) {
 const found=await read(db,ranking,'search:zebraranking');
 assert.equal(found.hits.length,8);
 assert.equal(found.hits[0].documentId,'00000000-0000-0000-0000-000000000009');
 report.checks.push('GREEN: trigram similarity ranks exact title first before the 8-result limit in both queries');

 const view=(await items(db,provenance))[provenance.execution];
 assert.equal(view.length,2,'completed work facts survive a ready document revision');
 assert.ok(view.some(x=>x.detail==='Historic.md'));
 assert.equal(await rpc(db,'runtime_library_visible',provenance.actor,provenance.execution,original),false);
 assert.equal(await rpc(db,'runtime_library_visible',provenance.actor,provenance.execution,readOnlyResult),false);
 await db.query("UPDATE runtime_executions SET state='running' WHERE id=$1",[provenance.execution]);
 assert.equal((await read(db,provenance,'doc-1/segment-1')).reason,'source_changed');
 await db.query("UPDATE runtime_executions SET state='completed' WHERE id=$1",[provenance.execution]);
 await db.query("UPDATE library_documents SET status='processing' WHERE id=$1",[document]);
 assert.equal((await items(db,provenance))[provenance.execution],undefined,'unreadable source remains hidden');
 await db.query("UPDATE library_documents SET status='ready' WHERE id=$1",[document]);
 assert.equal((await items(db,provenance))[provenance.execution].length,2);
 await db.query('DELETE FROM runtime_library_references WHERE execution_id=$1',[provenance.execution]);
 assert.equal((await items(db,provenance))[provenance.execution],undefined,'revoked reference hides historical facts');
 report.checks.push('GREEN: ordinary revisions preserve facts; source replay remains version-strict; unreadable/revoked sources hide rows');

 const workDef=(await db.query("SELECT pg_get_functiondef('public.runtime_work_items(uuid,uuid)'::regprocedure) d")).rows[0].d;
 assert.ok(workDef.includes('B2 own-post work projection')&&workDef.includes('revision-stable library work rows'),'repair patches the current work projection and keeps my_posts rows');

 const greenPlans=await queryPlans(db,plans);
 report.explainAfter=greenPlans;
 assert.ok(greenPlans.every(hasIndexes),'complete initial and post-lock queries use all three trigram indexes');
 const search=await read(db,plans,'search:zebrafinding');
 assert.equal(new Set(search.hits.map(h=>h.documentId)).size,3,'body, title, file-name candidate arms all return results');
 assert.equal(search.hits.length,5,'three per document cap still applies');
 report.checks.push('GREEN: both complete EXPLAIN ANALYZE plans use body/title/file-name GIN indexes; all candidate arms and per-document limit hold');
}
