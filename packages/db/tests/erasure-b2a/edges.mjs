/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,call,evidence,rpc,closeAccount,outcome} from './cases.mjs';
export async function edges(db,report){
 const probes=[['bill2_read',randomUUID(),randomUUID()],['bill2_record',randomUUID(),randomUUID(),randomUUID(),{}],
  ['bill2_close',randomUUID(),randomUUID(),'cancelled',null],['runtime_financial_recovery',randomUUID(),randomUUID(),true],
  ['bill2_revoke_unstarted_dispatch',randomUUID(),randomUUID(),randomUUID(),randomUUID(),'b'.repeat(64),false]];
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  for(const [name,...args] of probes)await assert.rejects(rpc(db,name,...args),/permission denied/);
  await db.query('RESET ROLE');
 }
 const prepared=await fixture(db);
 const eid=(await db.query('SELECT b2a_test.bind($1) v',[prepared])).rows[0].v;
 await closeAccount(db,prepared);
 await assert.rejects(rpc(db,'runtime_financial_recovery',randomUUID(),eid,true),/EXECUTION_DENIED/);
 for(let i=0;i<2;i++)assert.equal((await rpc(db,'runtime_financial_recovery',prepared.actor,eid,true)).state,'cancelled');
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[prepared.actor])).rows[0].credits,100);
 const f=await fixture(db),c=await call(db,f);await closeAccount(db,f);
 await assert.rejects(rpc(db,'bill2_record',prepared.actor,f.run,c.id,evidence(c)),/RUN_DENIED/);
 await assert.rejects(rpc(db,'bill2_record',prepared.actor,prepared.run,c.id,evidence(c)),/NOT_DISPATCHED/);
 await assert.rejects(rpc(db,'bill2_close',prepared.actor,f.run,'delivered',outcome),/RUN_DENIED/);
 await db.query('BEGIN');
 await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c));
 await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);await rpc(db,'bill2_finalize',f.actor,f.run);
 await assert.rejects(db.query('SELECT 1/0'),/division by zero/);await db.query('ROLLBACK');
 assert.equal((await db.query('SELECT count(*)::int n FROM bill2_receipts WHERE call_id=$1',[c.id])).rows[0].n,0);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits,70);
 assert.equal((await rpc(db,'bill2_read',f.actor,f.run)).closed,false);
 await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c,null));
 await db.query("UPDATE bill2_runs SET deadline=clock_timestamp()-interval '25 hours' WHERE id=$1",[f.run]);
 assert.equal(await rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id),null);
 const mismatch=await fixture(db),mc=await call(db,mismatch);await closeAccount(db,mismatch);
 assert.equal((await rpc(db,'bill2_record',mismatch.actor,mismatch.run,mc.id,evidence(mc,'0.0001',
  {model:'B2A_PRIVATE_CANARY'}))).conflict,true);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[mc.id])).rows),/B2A_PRIVATE_CANARY/);
 report.checks.push('five RPCs deny both client roles; prepared recovery refunds once; cross-identity denied; fault rollback atomic; lookup deadline; model mismatch strips text and latches conflict');
}
