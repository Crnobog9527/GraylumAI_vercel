/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture as v1Fixture,call as v1Call} from '../erasure-b2a/cases.mjs';
import {createFixture,claim,receipt} from './fixture.mjs';

export async function meteringReviewCases({db,Client,connectionString,report}) {
  const administrator=randomUUID();
  await db.query("INSERT INTO profiles(id,role,status,credits) VALUES($1,'admin','active',0)",[administrator]);
  const snapshot=(client,c,actor=administrator)=>rpc(client,'bill2_payg_metering_review_snapshot',actor,c.id);
  const review=(client,c,input,id=randomUUID(),actor=administrator)=>
    rpc(client,'bill2_payg_review_metering',actor,c.id,id,input);
  const inputFor=async c=>{
    const state=await snapshot(db,c);
    return {expectedEvidenceHash:state.evidenceHash,profileVersion:state.profileVersion,
      evidenceVersion:state.evidenceVersion,reviewReference:'Synthetic manual profile revalidation',humanReviewed:true};
  };
  const anomaly=async()=>{
    const f=await createFixture(db,{lookupSupported:false});
    const c=await claim(db,f);
    await receipt(db,f,c,'0.001',{});
    await rpc(db,'bill2_finalize',f.actor,f.run);
    const s=await snapshot(db,c);
    assert.equal(s.meteringMissing,true);assert.equal(s.reviewable,true);
    return {f,c,input:await inputFor(c)};
  };
  const lateReceipt=(client,f,c)=>rpc(client,'bill2_record',f.actor,f.run,c.id,{
    provider:f.claimPayload.provider,account:'sandbox',model:f.claimPayload.model,protocol:f.claimPayload.protocol,
    providerId:'generation-'+c.id,source:'lookup',sourceHash:randomUUID().replaceAll('-','').repeat(2),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.001',currency:'USD',usage:{},
  });
  const newRun=async f=>({...f,run:(await rpc(db,'bill2_prepare',f.actor,randomUUID(),f.payload)).id});
  const facts=async(f,c)=>(await db.query(`SELECT
    (SELECT to_jsonb(x)-'metering_review_audit_id' FROM bill2_calls x WHERE x.id=$1) call,
    (SELECT to_jsonb(r) FROM bill2_runs r WHERE r.id=$2) run,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM bill2_receipts e WHERE e.call_id=$1) receipts`,[c.id,f.run])).rows[0];

  const first=await anomaly();
  for(const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    try {
      await assert.rejects(snapshot(db,first.c),/permission denied/);
      await assert.rejects(review(db,first.c,first.input),/permission denied/);
      await assert.rejects(db.query("INSERT INTO user_activity_logs(action) VALUES('bill2_metering_review')"),/permission denied/);
    } finally {await db.query('RESET ROLE');}
  }
  for(const actor of [first.f.actor,randomUUID()]) {
    await assert.rejects(snapshot(db,first.c,actor),/REVIEW_DENIED/);
    await assert.rejects(review(db,first.c,first.input,randomUUID(),actor),/REVIEW_DENIED/);
  }
  for(const change of ["status='disabled'","is_deleted='true'"]) {
    await db.query('BEGIN');
    try {
      await db.query(`UPDATE profiles SET ${change} WHERE id=$1`,[administrator]);
      await assert.rejects(review(db,first.c,first.input),/REVIEW_DENIED/);
    } finally {await db.query('ROLLBACK');}
  }
  for(const patch of [{humanReviewed:false},{reviewReference:' '},{expectedEvidenceHash:'bad'},
    {extra:true},{profileVersion:''},{evidenceVersion:''}]) {
    await assert.rejects(review(db,first.c,{...first.input,...patch}),/REVIEW_DENIED/);
  }
  for(const patch of [{expectedEvidenceHash:'f'.repeat(64)},{profileVersion:'other'},{evidenceVersion:'other'}]) {
    await assert.rejects(review(db,first.c,{...first.input,...patch}),/REVIEW_CONFLICT/);
  }
  const pending=await createFixture(db);
  const pc=await claim(db,pending);
  assert.equal((await snapshot(db,pc)).reviewable,false);
  await assert.rejects(review(db,pc,await inputFor(pc)),/REVIEW_NOT_READY/);
  // Conflicting authoritative receipt must be appended through the immutable evidence writer.
  const conflicted=await anomaly();
  await receipt(db,conflicted.f,conflicted.c,'0.002',{});
  assert.equal((await snapshot(db,conflicted.c)).reviewable,false);
  assert.equal((await db.query('SELECT conflict FROM bill2_runs WHERE id=$1',[conflicted.f.run])).rows[0].conflict,true);
  assert.ok((await db.query('SELECT count(*)::int n FROM bill2_receipts WHERE call_id=$1 AND conflict',
    [conflicted.c.id])).rows[0].n>0);
  await assert.rejects(review(db,conflicted.c,await inputFor(conflicted.c)),/REVIEW_NOT_READY/);
  report.checks.push('metering review: real SQL roles, inactive/deleted admin, human/version/hash and unsettled/conflict rejection');

  // Inject the actual audit write failure: pointer and audit must commit together.
  const failedAudit=randomUUID();
  await db.query('BEGIN');
  try {
    await db.query(`CREATE FUNCTION public.payg_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN RAISE EXCEPTION 'synthetic audit failure';END$$`);
    await db.query(`CREATE TRIGGER payg_test_audit_failure BEFORE INSERT ON user_activity_logs
      FOR EACH ROW EXECUTE FUNCTION public.payg_test_audit_failure()`);
    await db.query('SAVEPOINT attempted_review');
    await assert.rejects(review(db,first.c,first.input,failedAudit),/synthetic audit failure/);
    await db.query('ROLLBACK TO SAVEPOINT attempted_review');
    assert.equal((await snapshot(db,first.c)).auditId,null);
    assert.equal((await db.query('SELECT count(*)::int n FROM user_activity_logs WHERE id=$1',[failedAudit])).rows[0].n,0);
  } finally {await db.query('ROLLBACK');}
  const target=await newRun(first.f);
  await assert.rejects(claim(db,target,1,false),/METERING_BLOCKED/);
  const before=await facts(first.f,first.c);
  const requestId=randomUUID();
  await db.query('SET ROLE service_role');
  let approved;
  try {approved=await review(db,first.c,first.input,requestId);} finally {await db.query('RESET ROLE');}
  assert.deepEqual(approved,{callId:first.c.id,auditId:requestId,reviewed:true});
  assert.deepEqual(await facts(first.f,first.c),before);
  assert.deepEqual(await review(db,first.c,first.input,requestId),approved);
  await assert.rejects(review(db,first.c,{...first.input,reviewReference:'changed'},requestId),/REVIEW_CONFLICT/);
  await assert.rejects(review(db,first.c,first.input),/REVIEW_CONFLICT/);
  const log=(await db.query('SELECT * FROM user_activity_logs WHERE id=$1',[requestId])).rows[0];
  assert.equal(log.admin_id,administrator);assert.equal(log.user_id,first.f.actor);
  assert.equal(log.details.evidenceHash,first.input.expectedEvidenceHash);
  assert.deepEqual(log.details.review,first.input);
  assert.ok((await claim(db,target,1,false)).id);
  const blockedOriginal=await claim(db,first.f,2,false);
  assert.equal((await rpc(db,'bill2_dispatch',first.f.actor,first.f.run,blockedOriginal.id,blockedOriginal.dispatchToken)).dispatch,false);
  report.checks.push('metering review: audit failure rolls back; service role success, exact idempotency, immutable financial facts and old-run dispatch denial');

  const originalReceipt=(await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1 ORDER BY id LIMIT 1',
    [first.c.id])).rows[0].payload;
  await rpc(db,'bill2_record',first.f.actor,first.f.run,first.c.id,originalReceipt);
  assert.equal((await snapshot(db,first.c)).auditId,requestId,'exact receipt replay retains review');
  assert.deepEqual((await db.query('SELECT * FROM user_activity_logs WHERE id=$1',[requestId])).rows[0],log);
  await db.query('BEGIN');
  try {
    const hashes=[];
    for(const zone of ['UTC','Asia/Shanghai','America/Los_Angeles']) {
      await db.query('SELECT set_config($1,$2,true)',['TimeZone',zone]);
      hashes.push((await snapshot(db,first.c)).evidenceHash);
    }
    assert.equal(new Set(hashes).size,1,'settledAt hashes the instant independently of session timezone');
  } finally {await db.query('ROLLBACK');}
  await db.query('BEGIN');
  try {
    await db.query('UPDATE bill2_calls SET metering_exit=true WHERE id=$1',[first.c.id]);
    assert.equal((await snapshot(db,first.c)).auditId,null,'changed call abnormality invalidates review');
    assert.deepEqual((await db.query('SELECT * FROM user_activity_logs WHERE id=$1',[requestId])).rows[0],log);
  } finally {await db.query('ROLLBACK');}
  report.checks.push('review pointer: exact evidence replay preserves it; changed call facts clear it without rewriting audit; timezone invariant hash');

  // A newly appended receipt invalidates the exact review, even with the same total cost.
  await lateReceipt(db,first.f,first.c);
  assert.notEqual((await snapshot(db,first.c)).evidenceHash,first.input.expectedEvidenceHash);
  assert.equal((await snapshot(db,first.c)).auditId,null,'new immutable receipt clears review pointer');
  await assert.rejects(review(db,first.c,first.input,requestId),/REVIEW_CONFLICT/);
  assert.deepEqual((await db.query('SELECT * FROM user_activity_logs WHERE id=$1',[requestId])).rows[0],log);
  const afterLate=await newRun(first.f);
  await assert.rejects(claim(db,afterLate,1,false),/METERING_BLOCKED/);
  const freshReview=await inputFor(first.c);
  await review(db,first.c,freshReview);
  const newCall=await claim(db,afterLate);
  await receipt(db,afterLate,newCall,'0.001',{});
  await rpc(db,'bill2_finalize',afterLate.actor,afterLate.run);
  const afterNew=await newRun(first.f);
  await assert.rejects(claim(db,afterNew,1,false),/METERING_BLOCKED/);
  report.checks.push('metering review: late evidence and later call anomalies re-block the model; no model-wide temporal waiver');

  // Keep several genuinely settled/reviewed anomalous calls with large immutable receipts.
  const historical=await createFixture(db,{lookupSupported:false});
  for(let i=0;i<6;i++) {
    const run=i===0?historical:await newRun(historical);
    const c=await claim(db,run);
    await rpc(db,'bill2_record',run.actor,run.run,c.id,{
      provider:run.claimPayload.provider,account:'sandbox',model:run.claimPayload.model,
      protocol:run.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',
      sourceHash:randomUUID().replaceAll('-','').repeat(2),observedAt:new Date().toISOString(),
      coverage:'request_total',final:true,cost:'0.001',currency:'USD',usage:{},rawBody:'S'.repeat(48000),
    });
    await rpc(db,'bill2_finalize',run.actor,run.run);
    await review(db,c,await inputFor(c));
  }
  const historicalCount=(await db.query(`SELECT count(*)::int n FROM bill2_calls
    WHERE model=$1 AND metering_missing AND metering_review_audit_id IS NOT NULL`,[historical.claimPayload.model])).rows[0].n;
  assert.equal(historicalCount,6);
  const fresh=await newRun(historical);
  await db.query('BEGIN');
  try {
    // Any historical evidence hashing during claim now causes a deterministic failure.
    await db.query(`CREATE OR REPLACE FUNCTION public.bill2_payg_metering_hash(c bill2_calls) RETURNS text
      LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS
      $$BEGIN RAISE EXCEPTION 'test_claim_must_not_hash_history';END$$`);
    assert.ok((await claim(db,fresh,1,false)).id);
    await db.query('SET LOCAL enable_seqscan=off');
    const plan=(await db.query(`EXPLAIN (ANALYZE,FORMAT JSON) SELECT 1 FROM bill2_calls
      WHERE model=$1 AND (budget_conflict OR metering_missing OR metering_exit)
      AND metering_review_audit_id IS NULL LIMIT 1`,[historical.claimPayload.model])).rows[0]['QUERY PLAN'][0].Plan;
    const nodes=[];
    const collect=node=>{nodes.push(node);for(const child of node.Plans??[])collect(child);};
    collect(plan);
    assert.ok(nodes.some(n=>n['Index Name']==='bill2_payg_unreviewed_model'));
    assert.ok(!nodes.some(n=>n['Node Type']==='Seq Scan'));
    assert.equal(plan['Actual Rows'],0,'reviewed anomalous history is absent from the unresolved index result');
  } finally {await db.query('ROLLBACK');}
  report.checks.push('claim skips six reviewed anomalies with large receipts without any evidence hash call; unresolved gate uses partial index');

  const legacy=await v1Fixture(db);
  const legacyCall=await v1Call(db,legacy,1,false);
  const legacyBefore=await facts(legacy,legacyCall);
  await assert.rejects(snapshot(db,legacyCall),/REVIEW_DENIED/);
  await assert.rejects(review(db,legacyCall,first.input),/REVIEW_DENIED/);
  assert.deepEqual(await facts(legacy,legacyCall),legacyBefore);
  assert.equal((await rpc(db,'bill2_dispatch',legacy.actor,legacy.run,legacyCall.id,legacyCall.dispatchToken)).dispatch,true);
  report.checks.push('v1 call review is rejected without changing legacy financial or dispatch behavior');

  const writers=[new Client({connectionString}),new Client({connectionString})];
  await Promise.all(writers.map(w=>w.connect()));
  try {
    await Promise.all(writers.map(w=>w.query("SET statement_timeout='10s'")));
    const raced=await anomaly();
    const sameRequest=randomUUID();
    const same=await Promise.all(writers.map(w=>review(w,raced.c,raced.input,sameRequest)));
    assert.deepEqual(same[0],same[1]);
    assert.equal((await db.query('SELECT count(*)::int n FROM user_activity_logs WHERE id=$1',[sameRequest])).rows[0].n,1);
    const competing=await anomaly();
    const results=await Promise.allSettled(writers.map(w=>review(w,competing.c,competing.input)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.match(String(results.find(r=>r.status==='rejected').reason),/REVIEW_CONFLICT/);
    const gate=await anomaly();
    const waiting=await newRun(gate.f);
    const race=await Promise.allSettled([
      review(writers[0],gate.c,gate.input),claim(writers[1],waiting,1,false),
    ]);
    assert.equal(race[0].status,'fulfilled');
    if(race[1].status==='rejected')assert.match(String(race[1].reason),/METERING_BLOCKED/);
    assert.ok((await claim(db,waiting,1,false)).id);
    const late=await anomaly();
    const lateRace=await Promise.allSettled([
      review(writers[0],late.c,late.input),lateReceipt(writers[1],late.f,late.c),
    ]);
    assert.equal(lateRace[1].status,'fulfilled');
    if(lateRace[0].status==='rejected')assert.match(String(lateRace[0].reason),/REVIEW_CONFLICT/);
    const latest=await newRun(late.f);
    await assert.rejects(claim(db,latest,1,false),/METERING_BLOCKED/);
  } finally {await Promise.all(writers.map(w=>w.end()));}
  report.checks.push('metering review: two-backend same-request/different-request review, claim and late-receipt races are serialized');
}
