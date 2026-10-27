/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-PERF: bill2_payg_stuck_calls (daily reconciliation, admin page) must only look at calls that can still be stuck.
// Counted by sequential tuples read on bill2_calls, not time, so a slow or fast machine gives the same answer.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const RUNS=5000,PER=4;
try{
 await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
 const actor=await one('SELECT ws_test.actor() v');
 const run=async(n,state,extra={})=>{
  const id=randomUUID();
  await c.query(`INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline,
    state,closed,outcome,charged,actual_restore,contract_version,conflict)
   VALUES($1,$2,$3,'{"kind":"fixture"}','{"contractVersion":"bill2.v2"}',$9,0.01,100,1,9,now()+interval '1 hour',$4,$5,$6,1,0,$7,$8)`,
   [id,actor,randomUUID(),state,state==='settled',state==='settled'?'delivered':null,extra.version??'bill2.v2',extra.conflict??false,(extra.version??'bill2.v2')==='bill2.v2'?0:1]);
  return id;
 };
 let seq=0;
 const call=async(runId,extra={})=>{
  const id=randomUUID();
  await c.query(`INSERT INTO bill2_calls(id,run_id,sequence,payload,provider,account_namespace,model,upper_usd,state,call_kind,dispatched_at,settled_at,
    selected_cost_usd,provider_rejected,recovery_deadline,created_at)
   VALUES($1,$2,$3,'{"phase":"reply"}','fixture','sandbox','fixture-model',0.01,'responded',$4,$5,$6,$7,$8,$9,$10)`,
   [id,runId,++seq,extra.kind??'model','dispatched' in extra?extra.dispatched:new Date(Date.now()-3*86400000),
    'settled' in extra?extra.settled:null,extra.cost??null,extra.rejected??false,extra.deadline??new Date(Date.now()-2*86400000),new Date(Date.now()-3*86400000)]);
  return id;
 };
 // Background: many finished runs and calls, the normal state of an old account base.
 const hist=[];
 for(let i=0;i<RUNS;i++)hist.push([randomUUID(),randomUUID()]);
 await c.query(`INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline,state,closed,outcome,charged,actual_restore,contract_version)
  SELECT id,$1,rq,'{"kind":"fixture"}','{"contractVersion":"bill2.v2"}',0,0.01,100,1,9,now()+interval '1 hour','settled',true,'delivered',1,0,'bill2.v2'
  FROM unnest($2::uuid[],$3::uuid[]) t(id,rq)`,[actor,hist.map(h=>h[0]),hist.map(h=>h[1])]);
 await c.query(`INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd,state,call_kind,dispatched_at,settled_at,selected_cost_usd,created_at)
  SELECT r.id,s,'{"phase":"reply"}','fixture','sandbox','fixture-model',0.01,'responded','model',now()-interval '5 days',now()-interval '5 days',0.001,now()-interval '5 days'
  FROM unnest($1::uuid[]) r(id) CROSS JOIN generate_series(1,${PER}) s`,[hist.map(h=>h[0])]);
 // Calls that are stuck, and each way a call can fail one condition of bill2_payg_call_stuck.
 const stuckRun=async(opts={},callOpts={})=>call(await run(0,opts.state??'cost_pending',opts),callOpts);
 const want=new Set();
 for(let i=0;i<5;i++)want.add(await stuckRun({},{dispatched:new Date(Date.now()-(5+i)*86400000),deadline:new Date(Date.now()-(4+i)*86400000)}));
 want.add(await stuckRun({},{deadline:null}));
 await stuckRun({},{deadline:new Date(Date.now()-5*60000)});             // deadline passed less than ten minutes ago
 await stuckRun({conflict:true});await stuckRun({version:'bill2.v1'});await stuckRun({state:'settled'});await stuckRun({state:'dispatched'});
 await stuckRun({},{kind:'tool'});await stuckRun({},{dispatched:null});await stuckRun({},{settled:new Date()});
 await stuckRun({},{cost:0.002});await stuckRun({},{rejected:true});
 await c.query('ANALYZE bill2_calls');await c.query('ANALYZE bill2_runs');
 // Reference: the function as it was (every call of every run, then the predicate).
 await c.query(`CREATE FUNCTION pg_temp.old_stuck_calls(p_limit integer) RETURNS jsonb LANGUAGE plpgsql AS $f$
  DECLARE total bigint;calls jsonb;
  BEGIN
   SELECT count(*) INTO total FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE bill2_payg_call_stuck(c,r);
   SELECT coalesce(jsonb_agg(x ORDER BY x->>'dispatchedAt'),'[]') INTO calls FROM (
    SELECT jsonb_build_object('callId',c.id,'runId',r.id,'actorId',r.actor_id,'model',c.model,'phase',c.payload->>'phase',
     'upperUsd',c.upper_usd,'reservedCredits',c.reserved_credits,'dispatchedAt',c.dispatched_at,
     'recoveryDeadline',c.recovery_deadline,'recoveryAttempts',c.recovery_attempts,'fusionVerdict',c.fusion_verdict,
     'receipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('source',rc.payload->>'source') ORDER BY rc.created_at),'[]')
      FROM bill2_receipts rc WHERE rc.call_id=c.id)) x
    FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE bill2_payg_call_stuck(c,r)
    ORDER BY c.dispatched_at LIMIT p_limit) s;
   RETURN jsonb_build_object('total',total,'calls',calls);
  END $f$`);
 const ids=r=>r.calls.map(x=>x.callId);
 const got=await one('SELECT bill2_payg_stuck_calls(100) v');
 for(const id of want)assert.ok(ids(got).includes(id),'a call that is stuck is listed');
 assert.ok(got.total>=want.size&&got.total<=want.size+4,`only a handful of the ${RUNS*PER} calls are stuck (${got.total})`);
 // Same list and total as the previous definition for every limit; limit 3 returns the three oldest.
 for(const limit of [1,3,100]){
  const now=await one('SELECT bill2_payg_stuck_calls($1) v',[limit]),before=await one('SELECT pg_temp.old_stuck_calls($1) v',[limit]);
  assert.equal(now.total,before.total);
  assert.deepEqual(ids(now),ids(before));
 }
 report.checks.push(`the stuck list (${got.total} calls, in ${RUNS*PER} others) equals the previous definition for limits 1, 3, 100; each failing condition is excluded`);
 // Structural: sequential tuples read on bill2_calls during one call.
 await c.query('BEGIN');
 const seqRead=async()=>{await c.query('SELECT pg_stat_force_next_flush()');
  return Number(await one("SELECT coalesce(seq_tup_read,0) v FROM pg_stat_xact_user_tables WHERE relname='bill2_calls'")??0);};
 const b0=await seqRead();await c.query('SELECT bill2_payg_stuck_calls(100)');const used=await seqRead()-b0;
 const b1=await seqRead();await c.query('SELECT pg_temp.old_stuck_calls(100)');const old=await seqRead()-b1;
 await c.query('ROLLBACK');
 report.checks.push(`rows read sequentially from bill2_calls: ${used} (previous definition ${old}) with ${RUNS*PER} settled calls`);
 assert.ok(old>=RUNS*PER,`reference must read every call (${old})`);
 assert.ok(used<=1000,`BILL2_STUCK_CALLS_SCAN_TOO_WIDE: ${used}`);
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
