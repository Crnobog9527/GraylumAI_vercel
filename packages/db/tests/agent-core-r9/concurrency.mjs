/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {runtimeFixture,erase} from '../content-erasure/cases.mjs';
export async function runConcurrency({db,Client,connectionString,report}){
 const one=new Client({connectionString}),two=new Client({connectionString});
 await one.connect();await two.connect();
 try {
  const f=await runtimeFixture(db,{settled:true}),request=randomUUID();
  await db.query('BEGIN');await db.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[f.actor]);
  const write=c=>rpc(c,'opc_content_reaction',f.actor,request,f.execution,'rewrite','ONE_EVENT');
  const a=write(one),b=write(two);
  let blocked=false;
  for(let i=0;i<100;i++){
   const n=(await db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock'
    AND query LIKE 'SELECT public.opc_content_reaction%'`)).rows[0].n;
   if(n===2){blocked=true;break;}await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(blocked,true,'both real connections are waiting at the actor barrier');
  await db.query('COMMIT');
  const results=await Promise.all([a,b]);assert.deepEqual(results[0],results[1]);
  assert.equal((await db.query('SELECT count(*)::int n FROM opc_data_events WHERE actor_id=$1',[f.actor])).rows[0].n,1);
  await one.query('BEGIN');
  await rpc(one,'opc_content_reaction',f.actor,randomUUID(),f.execution,'abandon',null);
  await assert.rejects(erase(two,f),/CONTENT_ERASURE_BUSY|could not obtain lock/);
  await one.query('COMMIT');await erase(two,f);
  await assert.rejects(write(one),/OPC_DATA_SOURCE_DENIED/);
  report.checks.push('real two-connection replay stores one event; D7 rejects concurrent writer then deletes after commit; late write denied');
 } finally {
  await db.query('ROLLBACK');await one.query('ROLLBACK');await two.query('ROLLBACK');
  await one.end();await two.end();
 }
}
