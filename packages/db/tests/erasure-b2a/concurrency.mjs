/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {fixture,call,evidence,rpc,closeAccount} from './cases.mjs';
export async function concurrency({client,Client,connectionString,report}){
 const f=await fixture(client),c=await call(client,f);
 const closer=new Client({connectionString}),writer=new Client({connectionString});
 await closer.connect();await writer.connect();
 try {
  const closePid=(await closer.query('SELECT pg_backend_pid() id')).rows[0].id;
  const writePid=(await writer.query('SELECT pg_backend_pid() id')).rows[0].id;
  assert.notEqual(closePid,writePid);
  await closer.query('BEGIN');await closeAccount(closer,f);
  const pending=rpc(writer,'bill2_record',f.actor,f.run,c.id,evidence(c));
  let blocked=false;
  for(let i=0;i<100&&!blocked;i++){
   blocked=(await client.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked',[closePid,writePid])).rows[0].blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(blocked,'receipt waits on the actual confirming transaction');
  await closer.query('COMMIT');assert.equal((await pending).accountClosed,true);
  const payload=(await client.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[c.id])).rows[0].payload;
  assert.doesNotMatch(JSON.stringify(payload),/B2A_PRIVATE_CANARY|rawBody|sdkResponse/);
  report.checks.push(`two-backend confirmation/receipt overlap verified (${closePid}, ${writePid}); post-commit projection`);
 }finally{await closer.query('ROLLBACK');await closer.end();await writer.end();}
}
