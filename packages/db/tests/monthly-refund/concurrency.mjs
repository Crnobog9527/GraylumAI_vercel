/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function runConcurrency({db,Client,connectionString,report}) {
 const other=new Client({connectionString});await other.connect();
 const make=async()=>{
  const f=(await db.query('select monthly_test.fixture() f')).rows[0].f;
  const q=(await db.query('select pay_common_monthly_refund_approve($1,$2,$3,$4) q',[f.actor,f.order,f.terms,'a'.repeat(64)])).rows[0].q;
  const i=(await db.query('select pay_common_monthly_refund_approve($1,$2,$3,$4,$5) i',
   [f.actor,f.order,f.terms,'a'.repeat(64),q.localVersion])).rows[0].i;
  return {f,i};
 };
 const claim=(c,f,i)=>c.query('select pay_common_monthly_refund_claim($1,$2,$3,$4) i',[f.actor,f.order,i.id,f.terms]);
 try {
  const {f,i}=await make();
  const raced=await Promise.allSettled([claim(db,f,i),claim(other,f,i)]);
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.query('select credits from profiles where id=$1',[f.user])).rows[0].credits,400);
  assert.equal((await db.query("select count(*)::int n from credit_transactions where source_order_id=$1 and ledger_type='refund_clawback'",[f.order])).rows[0].n,1);
  const next=await make();await other.query('begin');
  await other.query('select id from profiles where id=$1 for update',[next.f.user]);
  const waiting=claim(db,next.f,next.i).then(()=>({ok:true}),error=>({error}));
  // Observe a real lock wait rather than assuming that a timer demonstrates concurrency.
  const pid=db.processID;let locked=false;
  for(let n=0;n<100&&!locked;n++){
   locked=(await other.query("select wait_event_type='Lock' locked from pg_stat_activity where pid=$1",[pid])).rows[0]?.locked;
   if(!locked)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(locked,true);
  await other.query("insert into credit_transactions(user_id,amount,type,ledger_type,counts_as_spend) values($1,-1,'deduction','spend',true)",[next.f.user]);
  await other.query('update profiles set credits=credits-1 where id=$1',[next.f.user]);await other.query('commit');
  const blocked=await waiting;assert.match(blocked.error?.message??'',/CONSUMPTION/);
  // Closure wins the same profile lock; approved financial identity must remain pending.
  const closed=await make();
  await db.query("update user_subscriptions set cancel_at_period_end='true' where id=$1",[closed.f.subscription]);
  await db.query('select account_erasure_confirm($1,$2)',[closed.f.user,randomUUID()]);
  await assert.rejects(()=>claim(other,closed.f,closed.i),/SCOPE_OR_STATE/);
  const kept=(await db.query('select refund_approval from payment_orders where id=$1',[closed.f.order])).rows[0].refund_approval;
  assert.deepEqual(kept,closed.i);
  const proof=(await db.query('select account_erasure_financial_proof($1) p',[closed.f.user])).rows[0].p;
  assert.ok(proof.financialPending>0);
  // DB permissions: no authenticated or anonymous execution of monthly financial RPCs.
  const permissions=(await db.query(`select count(*)::int n from pg_proc where pronamespace='public'::regnamespace
   and proname like 'pay_common_monthly_refund_%' and
   (has_function_privilege('authenticated',oid,'execute') or has_function_privilege('anon',oid,'execute'))`)).rows[0].n;
  assert.equal(permissions,0);
 } finally {await other.query('rollback').catch(()=>{});await other.end();}
 report.checks.push('two actual connections: single claim winner; spend locks before claim; closed approval retains identity and blocks completion; RPC permissions');
}
