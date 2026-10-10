/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,outcome} from '../erasure-b2a/cases.mjs';
import {erase,preview} from './cases.mjs';
export async function runVideo(db,report){
 const f=(await db.query('SELECT runtime_perf_test.seed(1,false) v')).rows[0].v;
 const art=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const request=(await db.query('SELECT request_id FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].request_id;
 const materialRequest=randomUUID(),consumer=randomUUID(),dependent=randomUUID(),unrelated=randomUUID(),saved=randomUUID();
 const content={brief:'FROZEN_SCRIPT_PRIVATE_BODY',material:'PRIVATE_VIDEO_CONTEXT'};
 const hash=(await db.query('SELECT artifact_hash($1::jsonb) h',[content])).rows[0].h;
 await db.query('INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash) VALUES($1,1,$2,$3,$3,$4)',
  [f.session,materialRequest,content,hash]);
 assert.notEqual(materialRequest,art.content,'material request is independent of source script identity');
 await db.query(`INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision,storyboard,editing,expected_storyboard_version,expected_editing_version)
  VALUES($1,$2,$3,$4,$5,1,true,false,0,0)`,[f.actor,request,art.workItem,art.content,f.session]);
 const payload={...f.payload,scopeMaterial:{sessionId:f.session,revision:1,hash,content}};
 await db.query('UPDATE runtime_executions SET payload=$2,result=$3 WHERE id=$1',[f.execution,payload,outcome]);
 for(const [id,p] of [[consumer,payload],[dependent,{input:'KEEP_PROMPT',historyItems:[{content:'COPIED_VIDEO_RESULT'}]}],
  [unrelated,{input:'KEEP_UNRELATED_PROMPT'}]])
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
   VALUES($1,$2,$3,$4,$5,0,'completed',$6)`,[id,f.actor,f.session,randomUUID(),p,{...outcome,body:'VIDEO_RESULT_BODY'}]);
 await db.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[dependent,consumer]);
 await db.query(`INSERT INTO opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,request_id,source_content_id)
  VALUES($1,$2,$3,'storyboard',1,'final','KEEP_SAVED_STORYBOARD',$4,$5)`,[saved,f.actor,art.workItem,randomUUID(),art.content]);
 const first=await preview(db,f,'content',art.content);assert.equal(first.affectedExecutions,3);
 await erase(db,f,'content',art.content,first.previewHash);
 for(const id of [f.execution,consumer,dependent]){
  const row=(await db.query('SELECT payload,result,content_deleted_at FROM runtime_executions WHERE id=$1',[id])).rows[0];
  assert.ok(row.content_deleted_at);assert.equal(row.result,null);
  assert.doesNotMatch(JSON.stringify(row.payload),/FROZEN_SCRIPT|PRIVATE_VIDEO|COPIED_VIDEO/);
  await assert.rejects(rpc(db,'runtime_execution',f.actor,id,'read',null),/CONTENT_ERASED/);
 }
 assert.equal((await db.query('SELECT content FROM runtime_scope_material WHERE session_id=$1',[f.session])).rows[0].content,null);
 assert.equal((await preview(db,f,'content',art.content)).affectedExecutions,3,'IDs-only binding/dependency closure survives body scrub');
 assert.equal((await erase(db,f,'content',art.content)).alreadyDeleted,true);
 const kept=(await db.query('SELECT result,content_deleted_at FROM runtime_executions WHERE id=$1',[unrelated])).rows[0];
 assert.equal(kept.content_deleted_at,null);assert.equal(kept.result.body,'VIDEO_RESULT_BODY');
 assert.equal((await db.query('SELECT body FROM opc_content_versions WHERE id=$1',[saved])).rows[0].body,'KEEP_SAVED_STORYBOARD');
 await assert.rejects(rpc(db,'runtime_admission_replay',f.actor,request,payload),/CONTENT_ERASED/);
 report.checks.push('video source binding closes frozen material consumers and history descendants; repeated scope stable; unrelated execution and independent saved storyboard retained');
}
