/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
export async function runConcurrency({db,Client,connectionString,report}){
 const f={actor:randomUUID()},other={actor:randomUUID()};
 for(const user of [f,other])await db.query('INSERT INTO profiles(id,credits) VALUES($1,10)',[user.actor]);
 const ticket=(await db.query("INSERT INTO tickets(user_id,title,attachments) VALUES($1,'PRIVATE',$2) RETURNING id",
  [f.actor,JSON.stringify([`${other.actor}/shared.png`])])).rows[0].id;
 await closeAccount(db,f);
 const parallel=new Client({connectionString});await parallel.connect();
 try{
  await parallel.query('BEGIN');await parallel.query('SELECT 1');
  assert.deepEqual(await rpc(db,'account_erasure_storage_ready',f.actor),{ready:false});
  const pending=await rpc(db,'account_erasure_local_cleanup',f.actor,true);
  assert.deepEqual(pending.errors,['ERASURE_TRANSACTIONS_PENDING']);
  assert.equal((await db.query('SELECT count(*)::int n FROM tickets WHERE id=$1',[ticket])).rows[0].n,1);
  await parallel.query('ROLLBACK');
  assert.deepEqual(await rpc(db,'account_erasure_storage_ready',f.actor),{ready:true});
  await assert.rejects(db.query("INSERT INTO tickets(user_id,title,attachments) VALUES($1,'PRIVATE',$2)",
   [other.actor,JSON.stringify([`${other.actor}/shared.png`])]),/ACCOUNT_ERASURE_ATTACHMENT_CLOSED/);
  await assert.rejects(db.query("INSERT INTO ticket_replies(ticket_id,user_id,content) VALUES($1,$2,'PRIVATE')",
   [ticket,other.actor]),/ACCOUNT_ERASURE_TICKET_CLOSED/);
  // The barrier prevents cleanup rather than cancelling another transaction or assuming a busy row is absent.
  await parallel.query('BEGIN');await parallel.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE',[ticket]);
  assert.deepEqual(await rpc(db,'account_erasure_storage_ready',f.actor),{ready:false});
  await parallel.query('ROLLBACK');
  const cleared=await rpc(db,'account_erasure_local_cleanup',f.actor,true);
  assert.equal(cleared.remaining,0);
 }finally{await parallel.query('ROLLBACK').catch(()=>{});await parallel.end();}
 report.checks.push('separate-connection transaction/lock barriers refuse Storage and cleanup; closed-ticket/admin-path reference writes denied');
}
