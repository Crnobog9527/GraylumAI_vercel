/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Owner 2026-10-12: after a revision the earlier report stays viewable and exportable;
// deletion, account erasure and source withdrawal still make it unreadable.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
import {seed} from '../report-finalization/cases.mjs';
const original='## One\nOriginal confirmed facts.\n## Two\nKnown limitations.';
const hash=body=>createHash('sha256').update(body).digest('hex');

/** A finalized report, then a new round opened from it (the manual "go back and edit" path). */
async function revised(db,evidenceCount=0) {
 const f=await seed(db,'complete',evidenceCount);
 const formal=await rpc(db,'report_document',f.actor,f.execution,'finalize',randomUUID(),0,null,hash(original));
 const next=randomUUID();
 await rpc(db,'opc_revise',f.actor,f.draft,next,f.round);
 return {...f,versionId:formal.versionId,next};
}
const readable=(db,f)=>rpc(db,'content_erasure_artifact_readable',f.actor,f.versionId);
const savedReport=(db,f)=>rpc(db,'artifact_transition',f.actor,f.module,f.skill,'report',f.project,f.round,null,{});

export async function runCases({db,report}) {
 await db.query('SET ROLE service_role');
 await assert.rejects(db.query('SELECT report_source_for_read($1,$2,$3,$4)',[randomUUID(),randomUUID(),randomUUID(),randomUUID()]),/permission denied/);
 await db.query('RESET ROLE');
 report.checks.push('the read helper is private');

 const f=await revised(db);
 assert.equal(await rpc(db,'runtime_history_available',f.execution),true,'the report execution stays readable');
 assert.equal(await readable(db,f),true);
 const saved=await savedReport(db,f);
 assert.equal(saved.available,true);assert.equal(saved.report.generatedReport.body,original,'viewable and exportable body');
 assert.equal(saved.sourceAvailable,true);
 // Generating or billing a report for the earlier round still requires the current round.
 await assert.rejects(rpc(db,'report_source',f.actor,f.session,f.project,f.round),/REPORT_SOURCE_CONFLICT/);
 report.checks.push('after a revision the earlier report is readable and exportable; generation stays bound to the current round');

 const withdrawn=await revised(db,1);
 assert.equal(await readable(db,withdrawn),true);
 await db.query(`UPDATE artifact_evidence_restrictions SET expires_at=clock_timestamp() WHERE evidence_id IN
  (SELECT jsonb_array_elements_text(evidence_ids)::uuid FROM artifact_versions WHERE id=$1)
  AND evidence_id NOT IN (SELECT evidence_id FROM opc_result_links)`,[withdrawn.versionId]);
 assert.equal(await readable(db,withdrawn),false,'a withdrawn source makes it unreadable');
 assert.notEqual((await savedReport(db,withdrawn)).available,true);
 report.checks.push('source withdrawal still makes the earlier report unreadable');

 await erase(db,f,'artifact',f.project);
 assert.equal(await readable(db,f),false);
 await assert.rejects(savedReport(db,f),/CONTENT_ERASED/);
 report.checks.push('artifact deletion still makes the earlier report unreadable');

 const answer=await revised(db);
 await erase(db,answer,'answer',answer.execution);
 assert.equal(await rpc(db,'runtime_history_available',answer.execution),false,'a deleted report execution is unreadable');
 const kept=await savedReport(db,answer);
 assert.equal(kept.available,true);assert.equal(kept.sourceAvailable,false,'unchanged R5 rule: formal text kept, source revoked');
 report.checks.push('deleting the report execution still revokes it as a source (R5 rule unchanged)');

 const closed=await revised(db);
 await closeAccount(db,closed.base);
 await rpc(db,'account_erasure_scrub_content',closed.actor);
 assert.equal(await readable(db,closed),false);
 assert.equal((await db.query('SELECT report FROM artifact_versions WHERE id=$1',[closed.versionId])).rows[0].report,null);
 report.checks.push('account erasure still makes the earlier report unreadable and scrubs it');
}
