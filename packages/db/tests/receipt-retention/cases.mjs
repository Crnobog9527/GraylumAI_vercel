/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX G2: receipt raw output kept 30 days on finished runs; billing fields and hashes kept.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {createFixture,claim} from '../payg/fixture.mjs';

const CANARY='RETENTION_PRIVATE_CANARY';
const hash=value=>createHash('sha256').update(value).digest('hex');
function evidence(f,c){
 const rawBody=JSON.stringify({id:'generation-'+c.id,model:f.claimPayload.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:CANARY}}]});
 return {provider:f.claimPayload.provider,account:'sandbox',model:f.claimPayload.model,protocol:f.claimPayload.protocol,
  providerId:'generation-'+c.id,source:'response',sourceHash:hash(rawBody),observedAt:new Date().toISOString(),
  coverage:'request_total',final:true,cost:'0.001',currency:'USD',rawBody,
  transport:{rawBody,rawBodyBase64:Buffer.from(rawBody).toString('base64'),sourceHash:hash(rawBody),httpStatus:200,complete:true,transportIssue:null},
  usage:{inputTokens:1000,outputTokens:3,sdkResponse:JSON.parse(rawBody)}};
}
const receiptOf=async(db,c)=>(await db.query('SELECT * FROM bill2_receipts WHERE call_id=$1 ORDER BY id',[c.id])).rows;
const age=async(db,c,days)=>{
 // Test-only backdating: the immutable-evidence trigger is bypassed for this one update.
 await db.query('SET session_replication_role=replica');
 await db.query(`UPDATE bill2_receipts SET created_at=now()-make_interval(days=>$2) WHERE call_id=$1`,[c.id,days]);
 await db.query('SET session_replication_role=DEFAULT');
};
const scrub=async(db,limit=1000)=>{
 await db.query('SET ROLE service_role');
 try {return (await db.query('SELECT public.bill2_receipts_scrub_raw($1) v',[limit])).rows[0].v;}
 finally {await db.query('RESET ROLE');}
};
const meteringHash=async(db,c)=>(await db.query('SELECT bill2_payg_metering_hash(c) h FROM bill2_calls c WHERE id=$1',[c.id])).rows[0].h;
const balance=async(db,f)=>(await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits;
async function finished(db,days){
 const f=await createFixture(db),c=await claim(db,f);
 await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(f,c));
 assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).state,'settled');
 await age(db,c,days);
 return {f,c};
}

export async function runCases({db,report}) {
 // Clear any receipts the shared fixtures left behind, so counts below are this file's own.
 await scrub(db);
 const old=await finished(db,31),recent=await finished(db,29);
 const [before]=await receiptOf(db,old.c),[recentBefore]=await receiptOf(db,recent.c);
 const metering=await meteringHash(db,old.c),projection=await rpc(db,'bill2_financial_projection',before.payload);
 const credits=await balance(db,old.f);
 assert.ok(JSON.stringify(before.payload).includes(CANARY));

 // (1) 30-day boundary: only the 31-day receipt changes.
 assert.deepEqual(await scrub(db),{scrubbed:1,more:false});
 const [after]=await receiptOf(db,old.c);
 assert.ok(after.raw_scrubbed_at);assert.ok(!JSON.stringify(after.payload).includes(CANARY),'raw output removed');
 assert.deepEqual((await receiptOf(db,recent.c))[0],recentBefore,'29-day receipt untouched');
 report.checks.push('30-day boundary: a 31-day receipt loses raw output, a 29-day receipt is byte-identical');

 // (2) Billing fields, hashes and ids stay; only rawBody, transport raw copies and usage.sdkResponse go.
 const {rawBody:_r,transport,usage,...kept}=before.payload;void _r;
 const {rawBody:_t,rawBodyBase64:_b,...transportKept}=transport;void _t;void _b;
 const {sdkResponse:_s,...usageKept}=usage;void _s;
 assert.deepEqual(after.payload,{...kept,transport:transportKept,usage:usageKept});
 for(const column of ['id','call_id','payload_hash','conflict','created_at','financial_projection_hash','financial_projection_version','financial_projected_at'])
  assert.deepEqual(after[column],before[column],column);
 assert.equal(after.financial_projection_version,null);
 assert.equal(await meteringHash(db,old.c),metering,'metering review hash unchanged');
 assert.deepEqual(await rpc(db,'bill2_financial_projection',after.payload),projection,'financial projection unchanged (later erasure unaffected)');
 assert.equal(await balance(db,old.f),credits);
 report.checks.push('kept: cost, usage tokens, providerId, sourceHash, transport status/hash, payload_hash; metering hash and erasure projection unchanged; balance unchanged');

 // (3) Repeat is a no-op; an identical late receipt is still recognised without conflict or charge.
 assert.deepEqual(await scrub(db),{scrubbed:0,more:false});
 assert.deepEqual((await receiptOf(db,old.c))[0],after);
 await rpc(db,'bill2_record',old.f.actor,old.f.run,old.c.id,{...evidence(old.f,old.c),observedAt:before.payload.observedAt});
 const rows=await receiptOf(db,old.c);
 assert.ok(rows.every(row=>!row.conflict),'no conflict from the identical late receipt');
 assert.equal(await balance(db,old.f),credits);
 assert.equal((await db.query('SELECT conflict FROM bill2_runs WHERE id=$1',[old.f.run])).rows[0].conflict,false);
 report.checks.push('second run scrubs nothing; identical late receipt after scrub raises no conflict and no charge');

 // (4) Not due: open run, conflicting receipt. Their raw output stays for recovery and review.
 const open=await createFixture(db),oc=await claim(db,open);
 await rpc(db,'bill2_record',open.actor,open.run,oc.id,evidence(open,oc));await age(db,oc,40);
 const conflicted=await finished(db,40);
 await rpc(db,'bill2_record',conflicted.f.actor,conflicted.f.run,conflicted.c.id,{...evidence(conflicted.f,conflicted.c),cost:'0.002'});
 const conflictRows=(await receiptOf(db,conflicted.c)).filter(row=>row.conflict);
 if(conflictRows.length){
  await db.query('SET session_replication_role=replica');
  await db.query(`UPDATE bill2_receipts SET created_at=now()-interval '40 days' WHERE call_id=$1`,[conflicted.c.id]);
  await db.query('SET session_replication_role=DEFAULT');
 }
 const result=await scrub(db);
 assert.ok(JSON.stringify(await receiptOf(db,oc)).includes(CANARY),'open run keeps raw output');
 for(const row of conflictRows)assert.ok(JSON.stringify((await receiptOf(db,conflicted.c)).find(r=>r.id===row.id).payload).includes(CANARY),'conflicting receipt keeps raw output');
 report.checks.push(`not due: unfinished run keeps raw output; conflicting receipts (${conflictRows.length}) keep raw output; batch ${JSON.stringify(result)}`);

 // (5) The narrow exception cannot be used for anything else.
 const denied=async(sql,args)=>assert.rejects(db.query(sql,args),/BILL2_IMMUTABLE_EVIDENCE|permission denied/);
 await denied(`UPDATE bill2_receipts SET payload=payload||'{"cost":"9"}',raw_scrubbed_at=now() WHERE id=$1`,[recentBefore.id]);
 await denied(`UPDATE bill2_receipts SET raw_scrubbed_at=now(),payload=bill2_receipt_raw_scrub(payload) WHERE id=$1`,[recentBefore.id]);
 await denied(`UPDATE bill2_receipts SET raw_scrubbed_at=NULL WHERE id=$1`,[after.id]);
 await denied(`UPDATE bill2_receipts SET payload_hash='x' WHERE id=$1`,[after.id]);
 await denied(`DELETE FROM bill2_receipts WHERE id=$1`,[after.id]);
 for(const role of ['anon','authenticated']){
  await db.query(`SET ROLE ${role}`);
  await assert.rejects(db.query('SELECT public.bill2_receipts_scrub_raw(10)'),/permission denied/);
  await db.query('RESET ROLE');
 }
 await assert.rejects(scrub(db,0),/RECEIPT_RETENTION_LIMIT_INVALID/);
 report.checks.push('trigger refuses: changing billing fields, scrubbing a 29-day receipt, unsetting the marker, changing payload_hash, DELETE; anon/authenticated cannot execute; limit validated');
}
