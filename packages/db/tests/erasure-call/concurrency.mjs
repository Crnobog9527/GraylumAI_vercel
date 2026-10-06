/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc,fixture,call,evidence,closeAccount,outcome} from '../erasure-b2a/cases.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {scrub,row} from './cases.mjs';

export async function runConcurrency({db,Client,connectionString,report}) {
  const a = new Client({connectionString}), b = new Client({connectionString});
  await a.connect(); await b.connect();
  try {
    const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    for (const version of ['v1','v2']) for (const mode of ['scrub','record','close']) {
      const f = version==='v1'?await fixture(db):await createFixture(db,{lookupSupported:true});
      const c = version==='v1'?await call(db,f):await claim(db,f);
      await closeAccount(db,f);
      await rpc(db,'bill2_close',f.actor,f.run,'unknown',null);
      await a.query('BEGIN');
      await scrub(a,f);
      const pending = (mode === 'scrub' ? scrub(b,f) : mode === 'record'
        ? (version==='v1'?rpc(b,'bill2_record',f.actor,f.run,c.id,evidence(c)):receipt(b,f,c))
        : rpc(b,'bill2_close',f.actor,f.run,'delivered',outcome))
        .then(value=>({value}),error=>({error}));
      let blocked = false;
      for (let i=0;i<100;i++) {
        if ((await db.query('SELECT cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n>0) {
          blocked=true;break;
        }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,mode+' must wait on original run lock');
      await a.query('COMMIT');
      const result=await pending;if(result.error)throw result.error;
      assert.doesNotMatch(JSON.stringify(await row(db,f)),/B2A_PRIVATE/);
      if(mode==='scrub')assert.deepEqual(result.value,{processed:0,remaining:0});
    }
    report.checks.push('v1/v2 real two-connection scrub/scrub, scrub/record and scrub/close serialization');
  } finally {
    await a.query('ROLLBACK');await a.end();await b.end();
  }
}
