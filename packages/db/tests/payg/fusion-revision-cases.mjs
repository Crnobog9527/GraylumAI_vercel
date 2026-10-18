/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// #1099 post-merge repair: reuse PAYG fixtures; no provider or remote database calls.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createFixture} from './fixture.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const count=async(db,sql,args)=>Number((await db.query(sql,args)).rows[0].v);
const call=async(client,name,...args)=>{
  await client.query('SET ROLE service_role');
  try {
    return (await client.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,
      args.map(a=>a!==null&&typeof a==='object'?JSON.stringify(a):a))).rows[0].v;
  } finally { await client.query('RESET ROLE'); }
};

async function fixture(db) {
  const a=await createFixture(db,{credits:40,phase:'fusion_compare'});
  const b=await createFixture(db,{actor:a.actor,phase:'fusion_compare'});
  const actor=a.actor;
  const models=[a,b].map(f=>f.payload.modelId);
  const session=randomUUID();
  const requestId=randomUUID();
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [session,actor,a.payload.scope,randomUUID()]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local revision fixture','gold',true,true,500000000) ON CONFLICT(level) DO NOTHING`,[randomUUID()]);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[actor]);
  const compare={enabled:true,allowedModelIds:models,defaultModelIds:models,minModels:2,maxBudgetUsd:'1'};
  await db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[{version:1,review:{enabled:false},compare}]);
  const question='Compare revision fixture';
  const request={question,questionHash:sha(question),historyRevision:'0',config:{models,skill:null},
    workspaceDependencies:[],snapshotHash:sha('snapshot'),requestHash:sha(requestId)};
  const started=await call(db,'fusion_compare_begin',actor,requestId,session,request);
  await call(db,'fusion_compare_gate',actor,started.compareId,'clear');
  const runs=[a,b].map((f,index)=>{
    const body=`revision fixture ${index}`;
    const fusion={index,phase:'fusion_compare',body,call:{...f.claimPayload,phase:'fusion_compare',requestHash:sha(body)}};
    return {requestId:randomUUID(),payload:{...f.payload,input:{...f.payload.input,fusion},
      sourceHash:sha(JSON.stringify(fusion)),limits:{...f.payload.limits,maxCalls:1}}};
  });
  const admit=client=>call(client,'fusion_group_admit',actor,requestId,'compare',session,runs);
  const state=async()=>({
    funds:(await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits,
    groups:await count(db,'SELECT count(*) v FROM fusion_billing_groups WHERE actor_id=$1',[actor]),
    runs:await count(db,'SELECT count(*) v FROM bill2_runs WHERE actor_id=$1',[actor]),
    calls:await count(db,'SELECT count(*) v FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE r.actor_id=$1',[actor]),
  });
  return {actor,session,requestId,compareId:started.compareId,admit,state};
}

export async function committedRevisionCase({db}) {
  const f=await fixture(db);
  const before=await f.state();
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[f.session]);
  await assert.rejects(f.admit(db),/FUSION_COMPARE_STALE/);
  assert.deepEqual(await f.state(),before,'stale admission creates no group/run/call and changes no credits');
  await call(db,'fusion_compare_stop',f.actor,f.compareId,null);
}

export async function concurrentRevisionCase({db,Client,connectionString}) {
  const f=await fixture(db);
  const before=await f.state();
  const writer=new Client({connectionString});
  const admitting=new Client({connectionString});
  await writer.connect();
  await admitting.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[f.session]);
    const pid=(await admitting.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pending=f.admit(admitting).then(value=>({value}),error=>({error}));
    let waiting=false;
    for(let attempt=0;attempt<100&&!waiting;attempt++) {
      waiting=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;
      if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(waiting,'admission waits for the conversation update');
    await writer.query("SET LOCAL lock_timeout='1s'");
    await writer.query('SELECT id FROM fusion_compares WHERE id=$1 FOR UPDATE',[f.compareId]);
    await writer.query('COMMIT');
    assert.match((await pending).error?.message??'',/FUSION_COMPARE_STALE/);
  } finally {
    await writer.query('ROLLBACK');
    await writer.end();
    await admitting.end();
  }
  assert.deepEqual(await f.state(),before,'concurrent stale admission creates no group/run/call and changes no credits');
  await call(db,'fusion_compare_stop',f.actor,f.compareId,null);
}

export async function frozenReplayCase({db}) {
  const f=await fixture(db);
  const admitted=await f.admit(db);
  assert.equal(admitted.replayed,false);
  const before=await f.state();
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[f.session]);
  const replay=await call(db,'fusion_group_admit',f.actor,f.requestId,'compare',f.session,[]);
  assert.equal(replay.replayed,true);
  assert.equal(replay.groupId,admitted.groupId);
  assert.deepEqual(replay.runs,admitted.runs,'existing group replays the same frozen runs after a later turn');
  assert.deepEqual(await f.state(),before);
  await call(db,'fusion_compare_stop',f.actor,f.compareId,null);
}
