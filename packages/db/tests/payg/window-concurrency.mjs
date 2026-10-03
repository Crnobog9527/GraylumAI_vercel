/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {conserved} from './core.mjs';

export async function windowConcurrencyCases({db,Client,connectionString,report,createFixture,claim}) {
  const writers=[new Client({connectionString}),new Client({connectionString})];
  await Promise.all(writers.map(w=>w.connect()));
  try {
    await Promise.all(writers.map(w=>w.query("SET statement_timeout='5s'")));
    for (const operation of ['prepare','dispatch']) {
      const first=await createFixture(db,{empirical:true});
      // Distinct models prevent the model advisory lock from masking the wallet/window inversion.
      const second=await createFixture(db,{empirical:true,actor:first.actor});
      await db.query('UPDATE runtime_test_windows SET call_policies=call_policies||$2::jsonb WHERE id=$1',
        [first.payload.testWindowId,JSON.stringify(second.payload.callPolicy)]);
      const payload={...second.payload,testWindowId:first.payload.testWindowId,
        rules:{...second.payload.rules,quoteVersion:first.payload.testWindowId}};
      const otherRun=await rpc(db,'bill2_prepare',first.actor,randomUUID(),payload);
      const other={...second,run:otherRun.id,payload};
      const prepared=await claim(db,first,1,false);
      const holder=(await writers[0].query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const waiter=(await writers[1].query('SELECT pg_backend_pid() pid')).rows[0].pid;
      let pending;
      await writers[0].query('BEGIN');
      try {
        // Pause the competing transaction after its profile lock, before its window lock.
        await writers[0].query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[first.actor]);
        pending=claim(writers[1],other,1,false).then(value=>({value}),error=>({error}));
        let blocked=false;
        for (let i=0;i<100&&!blocked;i++) {
          blocked=(await db.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked',[holder,waiter])).rows[0].blocked;
          if (!blocked) await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(blocked,true,'claim must reach the held profile lock');
        if (operation==='prepare') {
          assert.ok((await rpc(writers[0],'bill2_prepare',first.actor,randomUUID(),first.payload)).id);
        } else {
          assert.equal((await rpc(writers[0],'bill2_dispatch',first.actor,first.run,prepared.id,prepared.dispatchToken)).dispatch,true);
        }
        await writers[0].query('COMMIT');
        const result=await pending;
        assert.equal(result.error,undefined,`${operation}/claim must not deadlock or time out`);
        assert.ok(result.value.id);
        assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[first.actor])).rows[0].credits,82);
        await conserved(db,first);
        await conserved(db,other);
      } finally {
        await writers[0].query('ROLLBACK');
        await pending;
      }
      report.checks.push(`two-backend ${operation}/claim on one actor/window with distinct models: profile before window, no deadlock, two holds`);
    }
  } finally {await Promise.all(writers.map(w=>w.end()));}
}
