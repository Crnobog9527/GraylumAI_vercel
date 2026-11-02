/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-7a2: a turn's report is finalized into artifact_versions, registered by its turn in opc_result_links; deletion and
// erasure behave as on the old path (old rows: report-finalization and the erasure suites). Runs after the lock budget check: that count
// depends on what this connection has already cached, and these cases run first took it from 21 to 64 with turn_open unchanged.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

export async function reportFinalCases(t){
 const {c,one,open,begin,record,account,reportSource,reportPolicy,refusal,report}=t;
 const body='## One\nFirst part of the report.\n## Two\nSecond part.';
 const openReport=(a,src,extra={})=>open(a,{kind:'report',session:src.session,pol:reportPolicy(src),...extra});
 const closeReport=async(a,turn,src,text)=>{
  const source=await one('select report_source($1,$2,$3,$4) v',[a.actor,src.session,src.project,src.round]);
  return one("select turn_close($1,$2,'completed','[]',true,false,null,$3) v",[a.actor,turn,JSON.stringify({body:text,reportGeneration:{version:1,
   projectId:src.project,roundId:src.round,evidenceIds:[],snapshotHash:source.snapshotHash,packageHash:'b'.repeat(64),workflowHash:'c'.repeat(64),
   templateHash:'d'.repeat(64),sections:['One','Two'],maxCharacters:12000}})]);
 };
 const hash=text=>createHash('sha256').update(text).digest('hex');
 const doc=(a,id,action,request=null,revision=null,text=null,h=null)=>
  one('select report_document($1,$2,$3,$4,$5,$6,$7,null) v',[a.actor,id,action,request,revision,text,h]);
 const finished=async()=>{
  const a=await account(1000),src=await reportSource(a),request=randomUUID();
  const o=await openReport(a,src,{request});
  await begin(a,o.turnId,1,{upper:0.05});await record(a,o.turnId,1,{n:0.03});
  await closeReport(a,o.turnId,src,body);
  return {a,src,request,turn:o.turnId};
 };
 const links=src=>c.query('select l.* from opc_result_links l where l.round_id=$1',[src.round]).then(r=>r.rows);
 const stored=src=>one("select report v from artifact_versions where round_id=$1",[src.round]);
 const shown=(a,src)=>one("select artifact_transition($1,$2,$3,'report',$4,$5,null,'{}') v",[a.actor,src.module,src.skill,src.project,src.round]);
 const allowed=(a,version)=>one('select opc_source_allowed($1,$2) v',[a.actor,version]);
 const edited='## One\nR7_PRIVATE_EDIT\n## Two\nSecond part.';
 // Finalized once; the same request replays, another one is refused, one link and one evidence row.
 const f=await finished(),requestId=randomUUID();
 const done=await doc(f.a,f.request,'finalize',requestId,0,null,hash(body));
 assert.deepEqual([done.finalized,done.version],[true,1]);
 assert.equal((await doc(f.a,f.request,'finalize',requestId,0,null,hash(body))).versionId,done.versionId);
 assert.match(await refusal(doc(f.a,f.request,'finalize',randomUUID(),0,null,hash(body))),/REPORT_ALREADY_FINALIZED/);
 const [link,...more]=await links(f.src);
 assert.equal(more.length,0,'one link');
 assert.deepEqual([link.execution_id,link.turn_actor_id,Number(link.turn_id),link.step_id],[null,f.a.actor,Number(f.turn),'report-final']);
 assert.deepEqual(await one('select payload v from artifact_evidence where id=$1',[link.evidence_id]),{executionId:f.request,turnId:Number(f.turn)});
 assert.equal((await stored(f.src)).generatedReport.body,body);
 assert.equal(await allowed(f.a,done.versionId),true,'a usable source while its conversation lives');
 assert.equal((await shown(f.a,f.src)).available,true);
 // The link holds the billing row, and names exactly one source.
 await c.query('begin');
 await c.query('delete from turn_call_raw where turn_id=$1',[f.turn]);await c.query('delete from turn_calls where turn_id=$1',[f.turn]);
 assert.match(await refusal(c.query('delete from turns where actor_id=$1 and id=$2',[f.a.actor,f.turn])),/opc_result_links_turn_fkey/);
 await c.query('rollback');
 const evidenceId=randomUUID();
 await c.query('begin');
 await c.query(`insert into artifact_evidence(id,project_id,kind,payload,content_hash) values($1,$2,'user','{}',repeat('a',64))`,[evidenceId,f.src.project]);
 assert.match(await refusal(c.query(`insert into opc_result_links(evidence_id,round_id,step_id) values($1,$2,'x')`,[evidenceId,f.src.round])),/opc_result_links_one_source/);
 await c.query('rollback');
 // Deleting the conversation: the finalized report stays readable, stops being a source, the edits and the evidence copy go.
 const d=await finished(),other=await finished();
 await doc(d.a,d.request,'save',randomUUID(),0,edited);
 const kept=await doc(d.a,d.request,'finalize',randomUUID(),1,null,hash(edited));
 assert.equal((await one('select content_erasure_scope($1,$2,$3) v',[d.a.actor,'session',d.src.session])).preservedSavedVersions,1,'the preview counts the finalized report as kept');
 await one('select content_erasure_mark_session($1,$2) v',[d.a.actor,d.src.session]);
 const after=await shown(d.a,d.src);
 assert.deepEqual([after.available,after.sourceAvailable,after.report.generatedReport.body],[true,false,edited]);
 assert.equal(await allowed(d.a,kept.versionId),false);
 assert.match(await refusal(doc(d.a,d.request,'read')),/CONTENT_ERASED/);
 const [gone]=await links(d.src);
 assert.equal(Number(gone.turn_id),Number(d.turn),'the link stays, as the old path keeps its link');
 assert.ok(await one('select erased_at v from artifact_evidence where id=$1',[gone.evidence_id]),'the evidence copy is cleared');
 assert.doesNotMatch(JSON.stringify((await c.query('select payload,response from artifact_requests where project_id=$1',[d.src.project])).rows),/R7_PRIVATE_EDIT/);
 // Another account's report is untouched; it cannot read this one.
 const otherDone=await doc(other.a,other.request,'finalize',randomUUID(),0,null,hash(body));
 assert.equal(await allowed(other.a,otherDone.versionId),true);
 assert.equal((await shown(other.a,d.src).catch(()=>null))?.report?.generatedReport,undefined,'not readable by another account');
 // A conversation deleted first has nothing to finalize.
 const late=await finished();
 await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[late.src.session]);
 assert.match(await refusal(doc(late.a,late.request,'finalize',randomUUID(),0,null,hash(body))),/CONTENT_ERASED/);
 // Account erasure: the link goes with the rest of the business data, the billing turn stays.
 const e=await finished();
 await doc(e.a,e.request,'finalize',randomUUID(),0,null,hash(body));
 await c.query("update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1",[e.a.actor]);
 await c.query("insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now()-interval '1 minute')",[e.a.actor,randomUUID()]);
 assert.equal(await one('select opc_result_link_available(l) v from opc_result_links l where turn_actor_id=$1',[e.a.actor]),false,'an erasing account has no source');
 await one('select account_erasure_scrub_content($1) v',[e.a.actor]);
 await one('select account_erasure_scrub_turns($1) v',[e.a.actor]);
 await one('select account_erasure_scrub_runtime($1) v',[e.a.actor]);
 for(let i=0;i<8;i++)await one('select account_erasure_prune_business($1) v',[e.a.actor]);
 assert.equal((await links(e.src)).length,0,'the link is removed');
 assert.equal(await one('select count(*)::int v from turns where actor_id=$1 and id=$2',[e.a.actor,e.turn]),1,'the billing row stays');
 for(const role of ['anon','authenticated','service_role'])
  assert.equal(await one("select has_function_privilege($1,'public.opc_result_link_available(public.opc_result_links)','EXECUTE') v",[role]),false,role);
 report.checks.push('a turn report finalizes into artifact_versions once (replay, refusal), one link naming the turn, evidence payload with executionId and turnId; the link holds the turn row and names one source; deleting the conversation keeps the report readable, revokes its source, clears evidence and edits; a deleted conversation cannot finalize; account erasure removes the link and keeps the billing turn');
}
