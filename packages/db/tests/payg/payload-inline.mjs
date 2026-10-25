/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-100 C2: claim and dispatch fetch a large run payload once, without changing billing behavior.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

// About the size of a real frozen context: ~33 KB as text, ~20 KB after TOAST compression.
const words='的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自'.split('');
function text(length,seed) {
  let s='',x=seed;
  const next=()=>(x=(x*1103515245+12345)%2147483648)/2147483648;
  while (s.length<length) s+=Array.from({length:4+Math.floor(next()*12)},()=>words[Math.floor(next()*words.length)]).join('')
    +(next()<0.3?'。我们的账号定位与内容规划如下：':'，');
  return s.slice(0,length);
}

export async function payloadInlineCases({db,Client,connectionString,report,createFixture}) {
  let seed=7;
  async function setup(large,options={}) {
    const f=await createFixture(db,{credits:100000,threshold:1,...options});
    const session=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:f.payload.scope});
    seed+=1;
    const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:large?text(3500,seed):'synthetic input',
      instructions:large?text(4000,seed+100):'Answer',historyText:large?text(3500,seed+200):'',
      model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:1,historyItems:0,tools:[],sources:[],network:'deny'};
    const admitted=await rpc(db,'runtime_admit',f.actor,session.sessionId,randomUUID(),context,{...f.payload,input:context});
    await rpc(db,'runtime_execution',f.actor,admitted.executionId,'begin',null);
    return {...f,run:admitted.runId,execution:admitted.executionId,call:{...f.claimPayload,runtimeEpoch:1}};
  }
  const stored=async run=>(await db.query(`SELECT payload,pg_column_size(payload) bytes,
    pg_column_toast_chunk_id(payload) chunk FROM bill2_runs WHERE id=$1`,[run])).rows[0];
  const evidence=(f,c)=>({provider:f.claimPayload.provider,account:'sandbox',model:f.claimPayload.model,
    protocol:f.claimPayload.protocol,providerId:'generation-'+c,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.001',currency:'USD',
    usage:{inputTokens:1000,outputTokens:10}});

  // Shape: only claim and dispatch carry the single fetch; the anchor is right after the run lock.
  for (const [fn,count] of [['bill2_payg_claim',1],['bill2_dispatch',1],['bill2_record',0],['bill2_payg_finalize',0]]) {
    const src=(await db.query(`SELECT string_agg(pg_get_functiondef(oid),'') s FROM pg_proc
      WHERE proname=$1 AND pronamespace='public'::regnamespace`,[fn])).rows[0].s;
    assert.equal(src.split("r.payload:=r.payload||'{}'::jsonb;").length-1,count,fn);
    if (count) assert.match(src,/FOR UPDATE;\n -- DB-100 C2 payload read once/);
  }

  // Normal: a large-context round claims, dispatches, records and settles exactly as before,
  // and the stored run payload is not rewritten (same TOAST value, same content).
  const f=await setup(true);
  const before=await stored(f.run);
  assert.ok(before.bytes>8000&&before.chunk!==null,'large payload is stored out of line');
  const balance=async()=>(await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits;
  const start=await balance();
  const c=await rpc(db,'bill2_claim',f.actor,f.run,1,f.call);
  assert.ok(c.dispatchToken);
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken,false,null)).dispatch,true);
  await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(f,c.id));
  const call=(await db.query('SELECT state,settled_at,reserved_credits FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.ok(call.settled_at,'final receipt settles the call');
  assert.equal(start-(await balance()),1,'0.001 USD at 1000 credits/USD charges exactly one credit');
  const after=await stored(f.run);
  assert.deepEqual(after.payload,before.payload);
  assert.equal(after.chunk,before.chunk,'run payload TOAST value is never rewritten');
  report.checks.push('DB-100 C2 large-context claim/dispatch/record settle exactly; run payload TOAST value unchanged');

  // Repeat: the same claim returns the same call without a new grant; a used grant cannot dispatch again.
  const repeated=await rpc(db,'bill2_claim',f.actor,f.run,1,f.call);
  assert.equal(repeated.id,c.id);assert.equal(repeated.dispatchToken,null);
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken,false,null)).dispatch,false);
  await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,1,{...f.call,requestHash:'d'.repeat(64)}),/BILL2_CALL_CONFLICT/);
  assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n,1);
  report.checks.push('DB-100 C2 repeated claim/dispatch on a large-context run stays idempotent');

  // Concurrent: two connections claim the same first call; one reservation exists afterwards.
  const g=await setup(true);
  const other=new Client({connectionString});await other.connect();
  try {
    const outcomes=await Promise.allSettled([db,other].map(client=>rpc(client,'bill2_claim',g.actor,g.run,1,g.call)));
    assert.ok(outcomes.every(x=>x.status==='fulfilled'),JSON.stringify(outcomes.map(x=>String(x.reason??''))));
    const ids=new Set(outcomes.map(x=>x.value.id));
    assert.equal(ids.size,1);
    assert.equal(outcomes.filter(x=>x.value.dispatchToken).length,1,'exactly one dispatch grant');
  } finally {await other.end();}
  assert.equal((await db.query(`SELECT count(*)::int n FROM credit_transactions
    WHERE bill2_run_id=$1 AND reason_code='bill2_reserve'`,[g.run])).rows[0].n,1);
  report.checks.push('DB-100 C2 concurrent claims on a large-context run create one call and one reservation');

  // Failure: refusals are unchanged (closed dispatch window, stopped run, foreign actor without a run row).
  const h=await setup(true);
  await db.query("UPDATE bill2_runs SET runtime_dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[h.run]);
  await assert.rejects(rpc(db,'bill2_claim',h.actor,h.run,1,h.call),/BILL2_DISPATCH_CLOSED/);
  await assert.rejects(rpc(db,'bill2_claim',randomUUID(),h.run,1,h.call),/BILL2_RUN_DENIED|BILL2_ACTOR_DENIED|42501/);
  const k=await setup(true);
  const kc=await rpc(db,'bill2_claim',k.actor,k.run,1,k.call);
  await db.query("UPDATE bill2_runs SET paused_reason='user_stop' WHERE id=$1",[k.run]);
  assert.equal((await rpc(db,'bill2_dispatch',k.actor,k.run,kc.id,kc.dispatchToken,false,null)).dispatch,false);
  assert.equal((await db.query('SELECT dispatched_at FROM bill2_calls WHERE id=$1',[kc.id])).rows[0].dispatched_at,null);
  report.checks.push('DB-100 C2 large-context refusals unchanged: closed window, foreign actor, user stop');

  // Reads: the extra pages a large context costs claim and dispatch stay small (before C2: ~160 / ~130 pages).
  const pages=async(sql,args)=>{
    const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0].Plan;
    return plan['Shared Hit Blocks']+plan['Shared Read Blocks'];
  };
  const samples={claim:{true:[],false:[]},dispatch:{true:[],false:[]}};
  for (let i=0;i<7;i++) for (const large of [false,true]) {
    const r=await setup(large);
    samples.claim[large].push(await pages('SELECT bill2_claim($1,$2,1,$3)',[r.actor,r.run,r.call]));
    const x=(await db.query('SELECT id,token FROM bill2_calls WHERE run_id=$1',[r.run])).rows[0];
    samples.dispatch[large].push(await pages('SELECT bill2_dispatch($1,$2,$3,$4,false,null)',[r.actor,r.run,x.id,x.token]));
  }
  const median=a=>[...a].sort((x,y)=>x-y)[a.length>>1];
  const extra=Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,median(v.true)-median(v.false)]));
  assert.ok(extra.claim<100&&extra.dispatch<100,JSON.stringify(extra));
  report.checks.push(`DB-100 C2 large-context extra pages: claim ${extra.claim}, dispatch ${extra.dispatch} (limit 100)`);
}
