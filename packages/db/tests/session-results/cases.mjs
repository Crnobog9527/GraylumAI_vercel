/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CONTENT-CONVERSATION-DRIVEN C1-lite (0338): the results folder of an ordinary free conversation. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

const REPLY = '标题：早起的人赢在哪\n开头：你有没有发现，早起三十天之后……\n结尾：明天六点见。';
const count = async (db,where,args) =>
  (await db.query(`SELECT count(*)::int n FROM runtime_session_results WHERE ${where}`,args)).rows[0].n;

/** An ordinary free-chat conversation of a fresh account (a plain positioning conversation; no old-path execution exists any more). */
async function freeChat(db) {
  const actor = randomUUID(), session = randomUUID();
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,1000)',[actor]);
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  return {actor,session};
}

/** A turn of this conversation that closed `closeKind` (null: still running) and saved REPLY as its assistant message. */
async function turnReply(db,f,closeKind='completed') {
  const {rows:[turn]} = await db.query(`INSERT INTO turns(actor_id,session_id,request_id,kind,state,close_kind,closed_at)
    VALUES($1,$2,$3,'chat',$4,$5,CASE WHEN $5::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [f.actor,f.session,randomUUID(),closeKind?'closed':'running',closeKind]);
  const {rows:[{seq}]} = await db.query('SELECT coalesce(max(seq),0)+1 seq FROM session_messages WHERE session_id=$1',[f.session]);
  await db.query("INSERT INTO session_messages(session_id,seq,role,turn_id,content,content_hash) VALUES($1,$2,'assistant',$3,$4,repeat('a',64))",
    [f.session,seq,turn.id,REPLY]);
  return Number(turn.id);
}
const saveTurn = (db,actor,session,turn,extra={}) => rpc(db,'runtime_session_result_save_turn',actor,session,turn,
  extra.request??randomUUID(),extra.type??'script',extra.title??null,extra.excerpt===undefined?null:extra.excerpt);

export async function runCases({db,report}) {
  const failures = [];
  const check = async (name,run) => {try {await run();report.checks.push(name);} catch (error) {failures.push(name+': '+(error.stack??error));}};

  await check('V2 a completed turn saves its reply or an excerpt, checked against session_messages; replay is idempotent', async () => {
    const f = await freeChat(db), turn = await turnReply(db,f);
    const whole = await saveTurn(db,f.actor,f.session,turn);
    assert.deepEqual([whole.body,whole.sourceTurnId,whole.sourceExecutionId,whole.sourceAvailable],[REPLY,turn,null,true]);
    const request = randomUUID();
    const part = await saveTurn(db,f.actor,f.session,turn,{request,type:'copy',excerpt:'明天六点见。'});
    assert.equal((await saveTurn(db,f.actor,f.session,turn,{request,type:'copy',excerpt:'明天六点见。'})).id,part.id,'replay');
    await assert.rejects(saveTurn(db,f.actor,f.session,turn,{request,type:'copy',excerpt:'明天六点'}),/SESSION_RESULT_REQUEST_CONFLICT/);
    await assert.rejects(saveTurn(db,f.actor,f.session,turn,{excerpt:'不在回复里的话'}),/SESSION_RESULT_INVALID/);
    assert.deepEqual((await rpc(db,'runtime_session_results_list_turns',f.actor,f.session)).map(r=>[r.id,r.sourceTurnId]),[[whole.id,turn],[part.id,turn]]);
    assert.equal('sourceTurnId' in (await rpc(db,'runtime_session_results_list',f.actor,f.session))[0],false,'the old read keeps its shape for the running API');
  });

  await check('V2 a reply hidden after the save keeps the saved text and reads as source-unavailable', async () => {
    const f = await freeChat(db), turn = await turnReply(db,f);
    const saved = await saveTurn(db,f.actor,f.session,turn);
    assert.equal(saved.sourceAvailable,true);
    await db.query('UPDATE session_messages SET visible=false WHERE session_id=$1 AND turn_id=$2',[f.session,turn]);
    const [row] = await rpc(db,'runtime_session_results_list_turns',f.actor,f.session);
    assert.deepEqual([row.id,row.body,row.sourceAvailable],[saved.id,REPLY,false]);
  });

  await check('V2 refuses another account\'s turn, a turn of another conversation, and any turn that did not complete', async () => {
    const f = await freeChat(db), other = await freeChat(db), turn = await turnReply(db,f);
    await assert.rejects(saveTurn(db,other.actor,f.session,turn),/SESSION_RESULT_NOT_FOUND/,'another account in this conversation');
    await assert.rejects(saveTurn(db,other.actor,other.session,turn),/SESSION_RESULT_SOURCE/,'this turn through its own conversation');
    const running = await turnReply(db,f,null);
    await assert.rejects(saveTurn(db,f.actor,f.session,running),/SESSION_RESULT_SOURCE/,'still running');
    for (const closeKind of ['failed','interrupted','expired','erased'])
      await assert.rejects(saveTurn(db,f.actor,f.session,await turnReply(db,f,closeKind)),/SESSION_RESULT_SOURCE/,closeKind);
    await db.query('UPDATE session_messages SET deleted_at=now() WHERE session_id=$1 AND turn_id=$2',[f.session,turn]);
    await assert.rejects(saveTurn(db,f.actor,f.session,turn),/SESSION_RESULT_SOURCE/,'a deleted message is no source');
    assert.equal(await count(db,'session_id=$1',[f.session]),0);
  });

  await check('C1 edit appends a version; stale edits conflict; versions stay readable; delete removes the family', async () => {
    const f = await freeChat(db);
    const first = await saveTurn(db,f.actor,f.session,await turnReply(db,f));
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
    assert.equal((await db.query('SELECT count(*)::int n FROM session_messages WHERE session_id=$1',[f.session])).rows[0].n,1,'the reply stays');
  });

  await check('C1 table and functions are closed to client roles', async () => {
    for (const role of ['anon','authenticated']) for (const statement of [
      'SELECT * FROM runtime_session_results',
      `SELECT runtime_session_results_list('${randomUUID()}','${randomUUID()}')`,
      `SELECT runtime_session_results_list_turns('${randomUUID()}','${randomUUID()}')`,
      `SELECT runtime_session_result_save_turn('${randomUUID()}','${randomUUID()}',1,'${randomUUID()}','body',NULL,NULL)`]) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query(statement),/permission denied/,role+' '+statement);
      } finally {await db.query('ROLLBACK');}
    }
  });

  if (failures.length) throw new Error(failures.join('\n\n'));
}
