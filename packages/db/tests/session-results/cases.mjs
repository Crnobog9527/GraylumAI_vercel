/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CONTENT-CONVERSATION-DRIVEN C1-lite (0337): the results folder of an ordinary free conversation. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {runtimeFixture,erase} from '../content-erasure/cases.mjs';

const REPLY = '标题：早起的人赢在哪\n开头：你有没有发现，早起三十天之后……\n结尾：明天六点见。';
const count = async (db,where,args) =>
  (await db.query(`SELECT count(*)::int n FROM runtime_session_results WHERE ${where}`,args)).rows[0].n;

/** A completed, billed, available free-chat reply in an ordinary conversation. */
async function freeChat(db) {
  const f = await runtimeFixture(db,{settled:true});
  await db.query("UPDATE runtime_executions SET result=result||jsonb_build_object('body',$2::text) WHERE id=$1",[f.execution,REPLY]);
  await db.query('DELETE FROM opc_drafts WHERE session_id=$1',[f.session]);
  return f;
}
const save = (db,f,extra={}) => rpc(db,'runtime_session_result_save',f.actor,f.session,extra.execution??f.execution,
  extra.request??randomUUID(),extra.type??'script',extra.title??null,extra.excerpt===undefined?null:extra.excerpt);

export async function runCases({db,Client,connectionString,report}) {
  const failures = [];
  const check = async (name,run) => {try {await run();report.checks.push(name);} catch (error) {failures.push(name+': '+(error.stack??error));}};

  await check('C1 fixture reply is available history in an ordinary free conversation', async () => {
    const f = await freeChat(db);
    assert.equal((await db.query('SELECT runtime_history_available($1) v',[f.execution])).rows[0].v,true);
    assert.deepEqual(await rpc(db,'runtime_session_results_list',f.actor,f.session),[]);
  });

  await check('C1 save whole reply or a verbatim excerpt; replay is idempotent; mismatched replay conflicts', async () => {
    const f = await freeChat(db);
    const whole = await save(db,f);
    assert.deepEqual([whole.version,whole.versions,whole.resultType,whole.body,whole.sourceAvailable,whole.familyId],
      [1,1,'script',REPLY,true,whole.id]);
    assert.equal(whole.title,'标题：早起的人赢在哪 开头：你有没有发现，早起三十天之后……'.slice(0,40));
    const request = randomUUID();
    const part = await save(db,f,{request,type:'copy',title:' 结尾句 ',excerpt:'明天六点见。'});
    assert.deepEqual([part.title,part.body],['结尾句','明天六点见。']);
    assert.equal((await save(db,f,{request,type:'copy',title:'结尾句',excerpt:'明天六点见。'})).id,part.id,'replay');
    await assert.rejects(save(db,f,{request,type:'copy',title:'结尾句',excerpt:'明天六点'}),/SESSION_RESULT_REQUEST_CONFLICT/);
    await assert.rejects(save(db,f,{excerpt:'不在回复里的话'}),/SESSION_RESULT_INVALID/);
    await assert.rejects(save(db,f,{type:'minutes'}),/SESSION_RESULT_INVALID/,'minutes are never saved here (Q1)');
    await assert.rejects(save(db,f,{excerpt:'   '}),/SESSION_RESULT_INVALID/);
    const list = await rpc(db,'runtime_session_results_list',f.actor,f.session);
    assert.deepEqual(list.map(r=>r.id),[whole.id,part.id]);
  });

  await check('C1 refuses another account, a topic or positioning session, and an unavailable reply', async () => {
    const f = await freeChat(db), other = await freeChat(db);
    await assert.rejects(rpc(db,'runtime_session_result_save',other.actor,f.session,f.execution,randomUUID(),'script',null,null),
      /SESSION_RESULT_NOT_FOUND/);
    await assert.rejects(rpc(db,'runtime_session_results_list',other.actor,f.session),/SESSION_RESULT_NOT_FOUND/);
    const guided = await runtimeFixture(db,{settled:true});
    if ((await db.query('SELECT count(*)::int n FROM opc_drafts WHERE session_id=$1',[guided.session])).rows[0].n===0)
      await db.query("UPDATE runtime_sessions SET scope=jsonb_build_object('kind','work_item','projectId',gen_random_uuid(),'workItemId',gen_random_uuid()) WHERE id=$1",[guided.session]);
    await assert.rejects(save(db,guided),/SESSION_RESULT_NOT_FOUND/);
    const unavailable = randomUUID();
    await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
      VALUES($1,$2,$3,gen_random_uuid(),'{}',0,'completed',$4)`,[unavailable,f.actor,f.session,{body:REPLY}]);
    await assert.rejects(save(db,f,{execution:unavailable}),/SESSION_RESULT_SOURCE/);
    await db.query("UPDATE runtime_executions SET state='cancelled' WHERE id=$1",[unavailable]);
    await assert.rejects(save(db,f,{execution:other.execution}),/SESSION_RESULT_SOURCE/,'reply of another conversation');
  });

  await check('C1 edit appends a version; stale edits conflict; versions stay readable; delete removes the family', async () => {
    const f = await freeChat(db);
    const first = await save(db,f);
    const request = randomUUID();
    const second = await rpc(db,'runtime_session_result_edit',f.actor,first.familyId,request,1,'改过的标题','改过的稿子');
    assert.deepEqual([second.version,second.versions,second.sourceExecutionId,second.familyId,second.resultType],
      [2,2,null,first.familyId,'script']);
    assert.equal((await rpc(db,'runtime_session_result_edit',f.actor,first.familyId,request,1,'改过的标题','改过的稿子')).id,second.id);
    await assert.rejects(rpc(db,'runtime_session_result_edit',f.actor,first.familyId,randomUUID(),1,null,'旧版本上改'),
      /SESSION_RESULT_VERSION_CONFLICT/);
    const versions = await rpc(db,'runtime_session_result_versions',f.actor,first.familyId);
    assert.deepEqual(versions.map(v=>[v.version,v.body]),[[2,'改过的稿子'],[1,REPLY]]);
    assert.deepEqual((await rpc(db,'runtime_session_results_list',f.actor,f.session)).map(r=>[r.id,r.versions]),[[second.id,2]]);
    const other = await freeChat(db);
    assert.equal((await rpc(db,'runtime_session_result_delete',other.actor,first.familyId)).deleted,0);
    await assert.rejects(rpc(db,'runtime_session_result_versions',other.actor,first.familyId),/SESSION_RESULT_NOT_FOUND/);
    assert.equal(await count(db,'family_id=$1',[first.familyId]),2,'another account deletes nothing');
    assert.equal((await rpc(db,'runtime_session_result_delete',f.actor,first.familyId)).deleted,2);
    assert.equal((await rpc(db,'runtime_session_result_delete',f.actor,first.familyId)).deleted,0,'repeat is a no-op');
    assert.equal(await count(db,'session_id=$1',[f.session]),0);
    assert.equal((await db.query("SELECT state FROM runtime_executions WHERE id=$1",[f.execution])).rows[0].state,'completed',
      'the reply stays');
  });

  await check('C1 deleting the reply or the conversation erases its results, edits included', async () => {
    const f = await freeChat(db);
    const saved = await save(db,f);
    await rpc(db,'runtime_session_result_edit',f.actor,saved.familyId,randomUUID(),1,null,'用户自己改过的版本');
    await erase(db,f,'answer',f.execution);
    assert.equal(await count(db,'family_id=$1',[saved.familyId]),0,'answer erasure removes the whole family');
    const g = await freeChat(db);
    await save(db,g);
    await erase(db,g,'session',g.session);
    assert.equal(await count(db,'session_id=$1',[g.session]),0,'conversation erasure');
    await assert.rejects(save(db,g),/CONTENT_ERASED|SESSION_RESULT_NOT_FOUND/);
  });

  await check('C1 account erasure deletes and counts the rows; the body proof sees them', async () => {
    const f = await freeChat(db);
    await save(db,f);await save(db,f,{type:'copy',excerpt:'明天六点见。'});
    assert.ok(Number((await db.query('SELECT account_erasure_body_remaining($1) v',[f.actor])).rows[0].v)>=2);
    const counts = (await db.query('SELECT account_erasure_scrub_content($1) v',[f.actor])).rows[0].v;
    assert.equal(counts.runtime_session_results_deleted,2);
    assert.equal(await count(db,'actor_id=$1',[f.actor]),0);
  });

  await check('C1 a save waiting on a conversation deletion is refused after it commits', async () => {
    const f = await freeChat(db);
    const deleter = new Client({connectionString});await deleter.connect();
    try {
      await deleter.query('BEGIN');
      await deleter.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[f.session]);
      const pending = save(db,f);
      await new Promise(resolve=>setTimeout(resolve,300));
      await deleter.query('UPDATE runtime_sessions SET content_deleted_at=now() WHERE id=$1',[f.session]);
      await deleter.query('COMMIT');
      await assert.rejects(pending,/CONTENT_ERASED/);
      assert.equal(await count(db,'session_id=$1',[f.session]),0);
    } finally {await deleter.end();}
  });

  await check('C1 table and functions are closed to client roles', async () => {
    for (const role of ['anon','authenticated']) for (const statement of [
      'SELECT * FROM runtime_session_results',
      `SELECT runtime_session_results_list('${randomUUID()}','${randomUUID()}')`]) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query(statement),/permission denied/,role+' '+statement);
      } finally {await db.query('ROLLBACK');}
    }
  });

  if (failures.length) throw new Error(failures.join('\n\n'));
}
