/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,outcome} from '../erasure-b2a/cases.mjs';
import {erase,preview} from './cases.mjs';
export async function runProducers(db,report){
 for(const kind of ['content','artifact']){
  const f=(await db.query('SELECT runtime_perf_test.seed(1,false) v')).rows[0].v;
  const art=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
  const producer=randomUUID(),dependent=randomUUID(),unrelated=randomUUID(),saved=randomUUID();
  await db.query('UPDATE runtime_executions SET result=$2 WHERE id=$1',[f.execution,{...outcome,body:'ORIGINAL_CONTENT_BODY'}]);
  await db.query(`INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,request_id,execution_id)
   VALUES($1,$2,'script',2,'final','ORIGINAL_CONTENT_BODY',$3,$4)`,[f.actor,art.workItem,randomUUID(),f.execution]);
  for(const id of [producer,dependent,unrelated])
   await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
    VALUES($1,$2,$3,$4,$5,0,'completed',$6)`,
   [id,f.actor,f.session,randomUUID(),{input:'KEEP_QUESTION'},{...outcome,body:'PRODUCER_PRIVATE_RESULT'}]);
  await db.query(`INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,request_id,execution_id)
   VALUES($1,$2,'script',3,'final','SECOND_CONTENT_BODY',$3,$4)`,[f.actor,art.workItem,randomUUID(),producer]);
  await db.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[dependent,producer]);
  const independent=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
  await db.query(`INSERT INTO opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,request_id,execution_id)
   VALUES($1,$2,$3,'storyboard',1,'final','KEEP_INDEPENDENT_SAVE',$4,$5)`,
  [saved,f.actor,independent.workItem,randomUUID(),producer]);
  const target=kind==='content'?art.content:art.workItem;
  const before=await preview(db,f,kind,target);
  assert.equal(before.affectedExecutions,3,'both family producers and dependent are included without reverse payload references');
  await erase(db,f,kind,target,before.previewHash);
  for(const id of [f.execution,producer,dependent]){
   const row=(await db.query('SELECT result,content_deleted_at,request_id,payload FROM runtime_executions WHERE id=$1',[id])).rows[0];
   assert.equal(row.result,null);assert.ok(row.content_deleted_at);
   await assert.rejects(rpc(db,'runtime_execution',f.actor,id,'read',null),/CONTENT_ERASED/);
   await assert.rejects(rpc(db,'runtime_admission_replay',f.actor,row.request_id,row.payload),/CONTENT_ERASED/);
  }
  assert.equal((await preview(db,f,kind,target)).affectedExecutions,3,'producer identity survives scrub');
  assert.equal((await erase(db,f,kind,target)).alreadyDeleted,true);
  const kept=(await db.query('SELECT result,content_deleted_at FROM runtime_executions WHERE id=$1',[unrelated])).rows[0];
  assert.equal(kept.content_deleted_at,null);assert.equal(kept.result.body,'PRODUCER_PRIVATE_RESULT');
  assert.equal((await db.query('SELECT body FROM opc_content_versions WHERE id=$1',[saved])).rows[0].body,'KEEP_INDEPENDENT_SAVE');
  report.checks.push(kind+': selected content family producers and history copies erased; repeat/read/replay guarded; unrelated execution and independent save retained');
 }
}
