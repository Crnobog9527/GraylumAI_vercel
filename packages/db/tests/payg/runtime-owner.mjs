/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
export async function runtimeOwnerCases({db,Client,connectionString,report,setup}) {
  const f=await setup({tools:['read_source'],maxToolCalls:2});
  const oldOwner=new Client({connectionString});await oldOwner.connect();
  const write=(client,action,value,epoch=1)=>rpc(client,'runtime_execution',f.actor,f.execution,action,{epoch,value});
  const items=[{role:'assistant',content:'synthetic owner result'}];
  const tool={callId:'owner-tool',name:'read_source',arguments:{},action:'claim',result:null};
  try {
    await db.query("UPDATE bill2_runs SET runtime_dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run]);
    const wait=await rpc(db,'runtime_execution',f.actor,f.execution,'read',null);
    assert.equal(wait.state,'waiting_resume');
    // Losing ownership also fences writes before a replacement owner exists.
    await assert.rejects(write(oldOwner,'interrupt',null),/RUNTIME_RESUME_CONFLICT/);
    await rpc(db,'runtime_execution',f.actor,f.execution,'payg_resume',{epoch:1,cursor:1});
    assert.deepEqual(await write(db,'owner_session',{action:'freeze',items:[]},2),[]);
    await write(db,'owner_session',{action:'append',items,batch:0},2);
    assert.equal((await write(db,'owner_tool',tool,2)).execute,true);
    await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[f.actor]);
    const claimed=await rpc(db,'bill2_claim',f.actor,f.run,1,{...f.claimPayload,runtimeEpoch:2});
    assert.ok(claimed.dispatchToken);
    const snapshot=async()=>{
      const result={};
      for(const [table,key,value] of [['runtime_sessions','id',f.session],['runtime_executions','id',f.execution],
        ['bill2_runs','id',f.run],['bill2_calls','run_id',f.run],['runtime_tool_calls','execution_id',f.execution],
        ['runtime_session_batches','execution_id',f.execution],['runtime_session_history','execution_id',f.execution]])
        result[table]=(await db.query(`SELECT * FROM ${table} WHERE ${key}=$1`,[value])).rows;
      return result;
    };
    const before=await snapshot();
    const writes=[['fail_before_dispatch',null],['interrupt',null],['checkpoint_match',{key:null}],
      ['checkpoint_primary',{body:'late',lastSequence:1}],['check_latest',null],
      ['complete',{kind:'usable_result',body:'late'}],['owner_cancel',null],
      ['owner_session',{action:'freeze',items:[]}],['owner_session',{action:'append',items:[],batch:1}],
      ['owner_tool',tool],['owner_tool',{...tool,action:'complete',result:{body:'late'}}]];
    for(const [action,value] of writes)await assert.rejects(write(oldOwner,action,value),/RUNTIME_RESUME_CONFLICT/);
    await assert.rejects(rpc(oldOwner,'runtime_execution',f.actor,f.execution,'fail_before_dispatch',null),/RUNTIME_RESUME_CONFLICT/);
    assert.deepEqual(await snapshot(),before);
    assert.equal(before.bill2_calls[0].state,'prepared');
    assert.ok(before.bill2_calls[0].pre_deduct_id);
    assert.equal(before.runtime_sessions[0].active_execution,f.execution);
    assert.equal(before.runtime_executions[0].state,'running');
    assert.equal((await write(db,'owner_tool',{...tool,action:'complete',result:{body:'current'}},2)).result.body,'current');
    // Current owner still has dispatch rights after every rejected late write.
    assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,claimed.id,claimed.dispatchToken,false,null)).dispatch,true);
    // User cancellation is independently authorized and deliberately has no epoch token.
    await rpc(db,'runtime_cancel',f.actor,f.execution);
    assert.equal((await db.query('SELECT cancel_requested FROM bill2_runs WHERE id=$1',[f.run])).rows[0].cancel_requested,true);
  }finally{await oldOwner.end();}
  report.checks.push('late prior epoch cannot fail/interrupt/checkpoint/complete/cancel/freeze/append/tool-write: state, holds, Session and authority unchanged');
  report.checks.push('current epoch Session/tool writes and dispatch accepted; explicit user cancellation remains independent');
}
