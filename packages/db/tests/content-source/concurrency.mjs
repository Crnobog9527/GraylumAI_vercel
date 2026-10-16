/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// A2 (PRECONDITIONS 2.4): checkpoint_source and a D7 content deletion in both orders, on two connections.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {rpc} from '../erasure-b2a/cases.mjs';
import {preview} from '../content-erasure/cases.mjs';

export async function runConcurrency(db,address,{topic,running,complete,checkpoint},report){
 const require=createRequire(resolve(import.meta.dirname,'../../../api/package.json'));
 const {Client}=require('pg');
 const connect=async()=>{const c=new Client({connectionString:`postgres://postgres@${address}/a2`});await c.connect();return c;};
 const reader=await connect(),deleter=await connect();
 try{
  // Checkpoint commits first: the deletion cannot take the session meanwhile, then erases the reading turn.
  const t=await topic(db);const x=await running(db,t);
  const hash=(await preview(db,t,'content',t.art.content)).previewHash;
  await reader.query('BEGIN');
  const read=await checkpoint(reader,t,x,'script');
  assert.equal(read.body,'D7_INDEPENDENT_SAVED_BODY');
  await assert.rejects(rpc(deleter,'content_erasure_confirm',t.actor,'content',t.art.content,hash),
   error=>error.code==='55P03','the deletion waits for (refuses during) the open checkpoint');
  await reader.query('COMMIT');
  await complete(db,t,x,'A2_REPLY_WITH_SOURCE');
  await rpc(deleter,'content_erasure_confirm',t.actor,'content',t.art.content,(await preview(db,t,'content',t.art.content)).previewHash);
  const after=(await db.query('SELECT content_deleted_at,result FROM runtime_executions WHERE id=$1',[x.id])).rows[0];
  assert.ok(after.content_deleted_at,'the turn that read the content is erased with it');
  assert.doesNotMatch(JSON.stringify(after.result??{}),/A2_REPLY_WITH_SOURCE/);
  report.checks.push('checkpoint first: deletion is refused while it is open, then erases the reading turn and its reply');

  // Deletion commits first: the waiting checkpoint never returns the body.
  const u=await topic(db);const y=await running(db,u);
  const hash2=(await preview(db,u,'content',u.art.content)).previewHash;
  await deleter.query('BEGIN');
  await rpc(deleter,'content_erasure_confirm',u.actor,'content',u.art.content,hash2);
  const pending=checkpoint(reader,u,y,'script').then(value=>({value}),error=>({error}));
  await new Promise(done=>setTimeout(done,300));
  await deleter.query('COMMIT');
  const outcome=await pending;
  assert.ok(outcome.error||outcome.value?.status!=='injected','no body after the deletion committed');
  assert.doesNotMatch(JSON.stringify(outcome.value??{}),/D7_INDEPENDENT_SAVED_BODY/);
  assert.equal((await db.query('SELECT injected_source v FROM runtime_executions WHERE id=$1',[y.id])).rows[0].v,null);
  report.checks.push('deletion first: the waiting checkpoint returns no body and records nothing');
 }finally{
  await reader.query('ROLLBACK').catch(()=>{});await deleter.query('ROLLBACK').catch(()=>{});
  await reader.end();await deleter.end();
 }
}
