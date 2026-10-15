/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0257: an open staging test window admits any signed-in actor; every other window check still applies.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rpc} from '../erasure-b2a/cases.mjs';

const migration=new URL('../../migrations/0257_runtime_test_window_all_actors.sql',import.meta.url);
const signatures=['runtime_test_window_allowed(uuid,jsonb)','runtime_test_policy(uuid,uuid)',
  'runtime_test_actor_access(uuid)','runtime_financial_recovery(uuid,uuid,boolean)'];
const definitions=async db=>Object.fromEntries(await Promise.all(signatures.map(async s=>
  [s,(await db.query(`SELECT pg_get_functiondef('public.${s}'::regprocedure) d`)).rows[0].d])));
const rejects=(promise,pattern)=>assert.rejects(promise,error=>pattern.test(error.message));

export async function allActorsWindowCases(db,report,createFixture,claim) {
  const listed=await createFixture(db,{empirical:true});
  const other=await createFixture(db,{empirical:true});
  const stranger=randomUUID();
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[stranger]);
  const open=randomUUID();
  await db.query(`INSERT INTO runtime_test_windows(id,enabled,all_actors,actor_ids,call_policies,credits_per_usd,multiplier,
    max_cost_usd,max_calls,expires_at) SELECT $1,true,true,'{}',call_policies,credits_per_usd,multiplier,1,100,
    now()+interval '2 hours' FROM runtime_test_windows WHERE id=$2`,[open,other.payload.testWindowId]);
  const onOpen={...other.payload,testWindowId:open,rules:{...other.payload.rules,quoteVersion:open}};
  const prepare=(actor,payload)=>rpc(db,'bill2_prepare',actor,randomUUID(),payload);
  try {
    assert.ok((await prepare(other.actor,onOpen)).id);
    assert.equal((await rpc(db,'runtime_test_policy',stranger,open)).id,open);
    assert.equal(await rpc(db,'runtime_test_actor_access',stranger),true);
    report.checks.push('open window admits an unlisted actor for prepare, policy and maintenance reads');

    await rejects(prepare(other.actor,{...listed.payload,scope:other.payload.scope}),/RUNTIME_TEST_WINDOW_DENIED/);
    await rejects(rpc(db,'runtime_test_policy',stranger,listed.payload.testWindowId),/RUNTIME_TEST_WINDOW_DENIED/);
    report.checks.push('listed window still denies actors outside actor_ids');

    await db.query('UPDATE runtime_test_windows SET call_policies=$2 WHERE id=$1',[open,JSON.stringify(listed.payload.callPolicy)]);
    await rejects(prepare(other.actor,onOpen),/RUNTIME_TEST_MODEL_DENIED/);
    await db.query('UPDATE runtime_test_windows SET call_policies=$2 WHERE id=$1',[open,JSON.stringify(other.payload.callPolicy)]);
    await rejects(prepare(other.actor,{...onOpen,input:{...onOpen.input,network:'allow'}}),/RUNTIME_TEST_WINDOW_DENIED/);
    // PAYG v2 reserves the window budget per call, so the open window's cap is enforced at claim.
    const budgeted={...other,run:(await prepare(other.actor,onOpen)).id,payload:onOpen};
    await db.query('UPDATE runtime_test_windows SET max_cost_usd=0.000000000001 WHERE id=$1',[open]);
    await rejects(claim(db,budgeted,1,false),/RUNTIME_TEST_BUDGET_EXHAUSTED/);
    await db.query('UPDATE runtime_test_windows SET max_cost_usd=1 WHERE id=$1',[open]);
    for (const change of ['enabled=false',"expires_at=now()-interval '1 second'"]) {
      await db.query(`UPDATE runtime_test_windows SET ${change} WHERE id=$1`,[open]);
      await rejects(prepare(other.actor,onOpen),/RUNTIME_TEST_WINDOW_DENIED/);
      await rejects(rpc(db,'runtime_test_policy',stranger,open),/RUNTIME_TEST_WINDOW_DENIED/);
      await rejects(rpc(db,'runtime_test_actor_access',stranger),/RUNTIME_TEST_ACTOR_DENIED/);
      await db.query("UPDATE runtime_test_windows SET enabled=true,expires_at=now()+interval '2 hours' WHERE id=$1",[open]);
    }
    report.checks.push('open window keeps model, network, budget, enablement and expiry denials');

    const isolated=await createFixture(db);
    assert.ok(isolated.run,'isolated (production-shaped) prepare is unaffected while an open window exists');
    await rejects(prepare(isolated.actor,{...isolated.payload,testWindowId:open}),/RUNTIME_TEST_WINDOW_DENIED/);
    report.checks.push('non-staging mode ignores open windows and still refuses a test window id');

    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        await rejects(rpc(db,'runtime_test_policy',stranger,open),/permission denied/);
        await rejects(rpc(db,'runtime_test_actor_access',stranger),/permission denied/);
        await rejects(prepare(stranger,onOpen),/permission denied/);
        await rejects(db.query('SELECT id FROM runtime_test_windows'),/permission denied/);
      } finally {await db.query('RESET ROLE');}
    }
    report.checks.push('anon and authenticated roles cannot reach open-window functions or the table');

    await rejects(db.query(`INSERT INTO runtime_test_windows(id,enabled,all_actors,actor_ids,call_policies,credits_per_usd,
      multiplier,max_cost_usd,max_calls,expires_at) VALUES($1,true,true,$2,'[{}]',1,1,1,1,now())`,[randomUUID(),[stranger]]),
    /runtime_test_windows_actor_ids_check/);
    await rejects(db.query(`INSERT INTO runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,
      multiplier,max_cost_usd,max_calls,expires_at) VALUES($1,true,'{}','[{}]',1,1,1,1,now())`,[randomUUID()]),
    /runtime_test_windows_actor_ids_check/);
    report.checks.push('open windows cannot also list actors; enabled listed windows still need an actor');

    const patched=await definitions(db);
    for (const [signature,source] of Object.entries(patched)) assert.match(source,/all_actors/,signature);
    await db.query(readFileSync(migration,'utf8'));
    assert.deepEqual(await definitions(db),patched,'rerun leaves every patched function unchanged');
    const policy=patched['runtime_test_policy(uuid,uuid)'];
    await db.query(policy.replace('NOT(w.all_actors OR p_actor_id=ANY(w.actor_ids))','NOT(p_actor_id = ANY(w.actor_ids))'));
    try {
      await rejects(db.query(readFileSync(migration,'utf8')),/RUNTIME_TEST_ALL_ACTORS_PATCH_MISSING/);
      await db.query('ROLLBACK');
    } finally {await db.query(policy);}
    assert.deepEqual(await definitions(db),patched);
    report.checks.push('migration rerun is a no-op and a missing anchor aborts it');
  } finally {
    await db.query('UPDATE runtime_test_windows SET enabled=false WHERE id=$1',[open]);
  }
}
