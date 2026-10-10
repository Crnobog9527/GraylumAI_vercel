/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createFixture,claim} from '../payg/fixture.mjs';
import {rpc,evidence,outcome} from '../erasure-b2a/cases.mjs';
import {erase} from './cases.mjs';
export async function runPayg(db,report){
 for(const settled of [true,false]){
  const f=await createFixture(db,{lookupSupported:true});
  f.execution=(await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
  const c=await claim(db,f);
  const receipt=evidence(c,'0.0001',{model:f.claimPayload.model,usage:{inputTokens:10,outputTokens:0}});
  if(settled){
   await rpc(db,'bill2_record',f.actor,f.run,c.id,receipt);
   await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
   await db.query("UPDATE runtime_executions SET state='completed',result=$2 WHERE id=$1",[f.execution,outcome]);
  }
  if(!settled)await rpc(db,'bill2_record',f.actor,f.run,c.id,{...receipt,cost:null,final:false});
  const before=(await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits;
  await erase(db,f);
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits,before);
  const view=await rpc(db,'bill2_read',f.actor,f.run);
  assert.equal(view.accountClosed,false);assert.equal(view.contentDeleted,true);
  await assert.rejects(rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken),/CONTENT_ERASED/);
  if(!settled){
   const inventory=await rpc(db,'runtime_pending_financial_batch',f.actor,20);
   assert.equal(inventory[0].runId,f.run);assert.equal(inventory[0].finishAllowed,true);
   await rpc(db,'bill2_record',f.actor,f.run,c.id,receipt);
  }
  await rpc(db,'runtime_financial_recovery',f.actor,f.execution,true);
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[c.id])).rows),/PRIVATE_CANARY|sdkResponse|rawBody/);
  await assert.rejects(rpc(db,'account_erasure_detach_runtime',f.actor,f.run),/ACCOUNT_ERASURE_NOT_CLOSED/);
 }
 report.checks.push('PAYG v2 settled and pending deletion: original call identity/credit preserved, late financial receipt accepted, redispatch and account-only detach denied');
}
