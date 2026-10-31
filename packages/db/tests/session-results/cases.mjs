/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CONTENT-CONVERSATION-DRIVEN C1-lite (0338): the results folder of an ordinary free conversation. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
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
    assert.equal(whole.title,REPLY.replace(/\s+/g,' ').trim().slice(0,40),'default title: first 40 characters on one line');
    const request = randomUUID();
    const part = await save(db,f,{request,type:'copy',title:' 结尾句 ',excerpt:'明天六点见。'});
    assert.deepEqual([part.title,part.body],['结尾句','明天六点见。']);
    assert.equal((await save(db,f,{request,type:'copy',title:'结尾句',excerpt:'明天六点见。'})).id,part.id,'replay');
    const retitled = await save(db,f,{request,type:'copy',title:null,excerpt:'明天六点见。'});
    assert.deepEqual([retitled.id,retitled.title],[part.id,'结尾句'],'the same save with another title replays the first one');
    await assert.rejects(save(db,f,{request,type:'copy',title:'结尾句',excerpt:'明天六点'}),/SESSION_RESULT_REQUEST_CONFLICT/);
    await assert.rejects(save(db,f,{excerpt:'不在回复里的话'}),/SESSION_RESULT_INVALID/);
    await assert.rejects(save(db,f,{type:'minutes'}),/SESSION_RESULT_INVALID/,'minutes are never saved here (Q1)');
    await assert.rejects(save(db,f,{excerpt:'   '}),/SESSION_RESULT_INVALID/);
    const list = await rpc(db,'runtime_session_results_list',f.actor,f.session);
    assert.deepEqual(list.map(r=>r.id),[whole.id,part.id]);
  });

  await check('V2 a completed turn saves its reply or an excerpt, checked against session_messages; replay is idempotent', async () => {
    const f = await freeChat(db), turn = await turnReply(db,f);
    const whole = await saveTurn(db,f.actor,f.session,turn);
    assert.deepEqual([whole.body,whole.sourceTurnId,whole.sourceExecutionId,whole.sourceAvailable],[REPLY,turn,null,true]);
    const request = randomUUID();
    const part = await saveTurn(db,f.actor,f.session,turn,{request,type:'copy',excerpt:'明天六点见。'});
    assert.equal((await saveTurn(db,f.actor,f.session,turn,{request,type:'copy',excerpt:'明天六点见。'})).id,part.id,'replay');
    await assert.rejects(saveTurn(db,f.actor,f.session,turn,{request,type:'copy',excerpt:'明天六点'}),/SESSION_RESULT_REQUEST_CONFLICT/);
    await assert.rejects(saveTurn(db,f.actor,f.session,turn,{excerpt:'不在回复里的话'}),/SESSION_RESULT_INVALID/);
    assert.deepEqual((await rpc(db,'runtime_session_results_list',f.actor,f.session)).map(r=>r.id),[whole.id,part.id]);
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

  await check('C1 erasing only the source reply keeps the saved text as source-unavailable; erasing the conversation removes it', async () => {
    const f = await freeChat(db);
    const saved = await save(db,f);
    const edited = await rpc(db,'runtime_session_result_edit',f.actor,saved.familyId,randomUUID(),1,null,'用户自己改过的版本');
    await erase(db,f,'answer',f.execution);
    assert.equal(await count(db,'family_id=$1',[saved.familyId]),2,'answer erasure keeps the user\'s saved and edited versions');
    const [kept] = await rpc(db,'runtime_session_results_list',f.actor,f.session);
    assert.deepEqual([kept.id,kept.body,kept.sourceAvailable,kept.versions],[edited.id,'用户自己改过的版本',true,2],
      'the newest version is the user\'s own edit, so it has no source to lose');
    const versions = await rpc(db,'runtime_session_result_versions',f.actor,saved.familyId);
    assert.deepEqual(versions.map(v=>[v.version,v.sourceAvailable]),[[2,true],[1,false]],'only the version saved from the erased reply is unavailable');
    await assert.rejects(save(db,f),/SESSION_RESULT_SOURCE/,'an erased reply cannot be saved again');
    const h = await freeChat(db);
    const plain = await save(db,h);
    await erase(db,h,'answer',h.execution);
    const [still] = await rpc(db,'runtime_session_results_list',h.actor,h.session);
    assert.deepEqual([still.id,still.body,still.sourceAvailable],[plain.id,REPLY,false],'an unedited result stays, marked source unavailable');
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
    await closeAccount(db,f);
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

  await check('C1 identical saves in parallel yield one result; an edit racing a delete never revives the family', async () => {
    const f = await freeChat(db);
    const request = randomUUID();
    const clients = await Promise.all([0,1,2].map(async()=>{const c = new Client({connectionString});await c.connect();return c;}));
    try {
      const saved = await Promise.all(clients.map(c=>rpc(c,'runtime_session_result_save',f.actor,f.session,f.execution,request,'copy',null,'明天六点见。')));
      assert.equal(new Set(saved.map(r=>r.id)).size,1,'one result for three identical requests');
      assert.equal(await count(db,'session_id=$1',[f.session]),1);
      const family = saved[0].familyId;
      // Edit and delete race: either the delete wins (edit finds nothing) or the edit commits first (delete removes both).
      const outcomes = await Promise.allSettled([
        rpc(clients[0],'runtime_session_result_edit',f.actor,family,randomUUID(),1,null,'改过的稿子'),
        rpc(clients[1],'runtime_session_result_delete',f.actor,family)]);
      assert.equal(outcomes[1].status,'fulfilled');
      if (outcomes[0].status==='rejected') assert.match(String(outcomes[0].reason),/SESSION_RESULT_NOT_FOUND/);
      assert.equal(await count(db,'family_id=$1',[family]),0,'no version survives the delete');
    } finally {await Promise.all(clients.map(c=>c.end()));}
  });

  await check('C1 table and functions are closed to client roles', async () => {
    for (const role of ['anon','authenticated']) for (const statement of [
      'SELECT * FROM runtime_session_results',
      `SELECT runtime_session_results_list('${randomUUID()}','${randomUUID()}')`,
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
