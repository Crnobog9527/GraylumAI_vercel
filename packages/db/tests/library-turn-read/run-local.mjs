/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The library read a chat turn uses (library_turn_read, 0427/0483): the index, directory paging, the segment size bounds, the reference checks and
// the search (word rules, literal % and _, ranking before the result limit, per-document limit, trigram indexes). It replaces what the retired suites
// library-references (0262) and library-search (0302) tested on the old runtime_library_read path (retirement proposal, docs/validation/
// nightly-db-suites-0505-retirement-proposal.md). Deletion and ownership after library_delete stay in turn-erasure (block 14).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const refusal=async promise=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
async function account(){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,1000)',[actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session,docs:[]};
}
// A ready document with the given segments ({title,body}); its reference is doc-N in the order they are made.
async function doc(a,filename,segments){
 const id=randomUUID();
 await c.query(`insert into library_documents(id,actor_id,request_id,kind,format,purpose,filename,status,original_bytes,text_bytes)
  values($1,$2,$3,'document','md','reference',$4,'ready',10,10)`,[id,a.actor,randomUUID(),filename]);
 for(const [i,s] of segments.entries())
  await c.query("insert into library_document_segments(document_id,actor_id,ordinal,title,body,source) values($1,$2,$3,$4,$5,'extracted')",
   [id,a.actor,i,s.title??'',s.body]);
 a.docs.push(id);
 return id;
}
const refs=(a,version=1)=>JSON.stringify(a.docs.slice(0,30).map((documentId,i)=>({ref:'doc-'+(i+1),documentId,version})));
const read=(a,q,r=refs(a))=>one('select library_turn_read($1,$2,$3,$4::jsonb) v',[a.actor,a.session,q,r]);
const hits=async(a,q)=>(await read(a,'search:'+q)).hits;
try{
 // 1. The index lists up to 10 documents, in name order, and says so.
 {
  const a=await account();
  for(let i=0;i<12;i++)await doc(a,'idx-'+String(i).padStart(2,'0')+'.md',[{body:'x'}]);
  const index=await read(a,'library');
  assert.equal(index.kind,'library_index');assert.equal(index.documents.length,10);
  assert.deepEqual(index.documents.map(d=>d.title),Array.from({length:10},(_,i)=>'idx-'+String(i).padStart(2,'0')+'.md'));
  assert.match(index.hint,/search:/);
  assert.equal((await read(a,'')).kind,'library_index','an empty query is the index too');
  report.checks.push('index: at most 10 documents in name order, with the hint to search');
 }
 // 2. A document of 26 segments is read in directory pages of 25.
 {
  const a=await account();
  await doc(a,'long.md',Array.from({length:26},(_,i)=>({title:'S'+(i+1),body:'body '+(i+1)})));
  const p1=await read(a,'doc-1'),p2=await read(a,'doc-1/page-2');
  assert.deepEqual([p1.kind,p1.page,p1.pages,p1.total,p1.entries.length],['library_directory',1,2,26,25]);
  assert.deepEqual([p2.page,p2.entries.length,p2.entries[0].segment],[2,1,26]);
  assert.equal((await read(a,'doc-1/segment-26')).body,'body 26');
  report.checks.push('directory paging: 26 segments are 2 pages of 25, the last segment is readable');
 }
 // 3. A segment's size is bounded: plain text up to 8192 bytes whole, heavily escaped text shortened so the serialised result stays within 16384 bytes.
 {
  const a=await account();
  await doc(a,'bounds.md',[{title:'plain',body:'a'.repeat(8192)},{title:'escaped',body:'"'.repeat(8192)}]);
  const plain=await read(a,'doc-1/segment-1');
  assert.deepEqual([plain.body.length,plain.truncated],[8192,false]);
  const escaped=await read(a,'doc-1/segment-2');
  assert.equal(escaped.truncated,true);assert.ok(escaped.body.length<8192);
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(escaped)))<=16384,'the escaped result stays within 16384 bytes');
  report.checks.push('segment bounds: 8192 plain bytes whole; heavily escaped text is shortened and marked truncated, the result stays within 16384 bytes');
 }
 // 4. The reference checks: unknown or malformed ones, a changed version, too many references, too long a query.
 {
  const a=await account();
  await doc(a,'refs.md',[{body:'one'}]);
  for(const q of ['doc-2','doc-31','doc-1/segment-0','doc-1/segment-2','doc-1/segment-x','nonsense'])
   assert.deepEqual(await read(a,q),{kind:'unavailable',reason:'unknown_query'},'refused: '+q);
  assert.deepEqual(await read(a,'doc-1',refs(a,2)),{kind:'unavailable',reason:'source_changed',ref:'doc-1'},'a changed version is said, not read');
  const many=JSON.stringify(Array.from({length:31},(_,i)=>({ref:'doc-'+(i+1),documentId:randomUUID(),version:1})));
  assert.match(await refusal(c.query('select library_turn_read($1,$2,$3,$4::jsonb)',[a.actor,a.session,'doc-1',many])),/LIBRARY_TURN_READ_INVALID/);
  assert.match(await refusal(c.query('select library_turn_read($1,$2,$3,$4::jsonb)',[a.actor,a.session,'search:'+'x'.repeat(401),refs(a)])),/LIBRARY_TURN_READ_INVALID/);
  report.checks.push('reference checks: unknown/malformed refs and segments refused, a changed version said, more than 30 refs or a query over 400 bytes invalid');
 }
 // 5. Search words: Chinese and English hits, 1-character words match titles and file names but not bodies, literal % and _, word-count and length rules.
 {
  const a=await account();
  await doc(a,'plan.md',[{title:'选址',body:'咖啡店的选址与定价'},{title:'other',body:'ux_tok marks one'},{title:'other2',body:'uxztok marks the other'}]);
  await doc(a,'rates.md',[{title:'r1',body:'the rate is 100% done'},{title:'r2',body:'the rate is 100x done'},{title:'Qtitle',body:'plain'},{title:'t',body:'a lone Q inside the body'}]);
  assert.equal((await hits(a,'选址')).length>=1,true,'a Chinese word is found');
  assert.equal((await hits(a,'选址'))[0].segmentTitle,'选址');
  assert.deepEqual((await hits(a,'ux_tok')).map(h=>h.segmentTitle),['other'],'an underscore is literal');
  assert.deepEqual((await hits(a,'100%')).map(h=>h.segmentTitle),['r1'],'a percent sign is literal');
  assert.deepEqual((await hits(a,'Q')).map(h=>h.segmentTitle),['Qtitle'],'a 1-character word matches a title, not a body');
  for(const q of ['','a b c d e f','y'.repeat(41)])assert.deepEqual(await read(a,'search:'+q),{kind:'unavailable',reason:'unknown_query'},'refused: '+q);
  assert.equal((await read(a,'search:a b c d e')).kind,'library_search','five words are allowed');
  report.checks.push('search words: Chinese found; _ and % literal; a 1-character word matches titles only; no words, six words or a word over 40 characters refused');
 }
 // 6. Result limits and order: at most 8 hits and 3 per document; the segment matching the most words is first, also when it was written last.
 {
  const a=await account();
  for(let i=0;i<12;i++)await doc(a,'many-'+i+'.md',[{title:'m'+i,body:'common word number '+i}]);
  assert.equal((await hits(a,'common')).length,8,'at most 8 hits');
  const b=await account();
  await doc(b,'five.md',Array.from({length:5},(_,i)=>({title:'f'+i,body:'shared term '+i})));
  assert.equal((await hits(b,'shared')).length,3,'at most 3 hits per document');
  const r=await account();
  for(let i=0;i<9;i++)await doc(r,'ranked-'+i+'.md',[{title:'p'+i,body:'alpha only '+i}]);
  const best=await doc(r,'ranked-best.md',[{title:'best',body:'alpha and beta together'}]);
  const ordered=await hits(r,'alpha beta');
  assert.equal(ordered[0].documentId,best,'the segment with both words ranks first, before the 8-hit limit cuts');
  report.checks.push('search limits: at most 8 hits, 3 per document; the best match is first before the limit applies');
 }
 // 7. Another account never finds or reads it, and the trigram indexes the search uses exist.
 {
  const a=await account(),other=await account();
  await doc(a,'mine.md',[{title:'mine',body:'ISOLATION_CANARY text'}]);
  assert.deepEqual((await hits(other,'ISOLATION_CANARY')),[],'another account finds nothing');
  assert.deepEqual(await one('select library_turn_read($1,$2,$3,$4::jsonb) v',[other.actor,other.session,'doc-1/segment-1',refs(a)]),{kind:'unavailable',reason:'source_deleted',ref:'doc-1'},'another account never reads it');
  const names=(await c.query("select indexname from pg_indexes where indexname in ('library_segments_body_trgm','library_segments_title_trgm','library_documents_filename_trgm')")).rows.map(r=>r.indexname).sort();
  assert.deepEqual(names,['library_documents_filename_trgm','library_segments_body_trgm','library_segments_title_trgm'],'the three trigram indexes exist');
  report.checks.push('isolation: another account finds and reads nothing; the three trigram indexes (body, title, file name) exist');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
