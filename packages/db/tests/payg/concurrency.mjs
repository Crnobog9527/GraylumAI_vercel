/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
import {conserved,financial} from './core.mjs';

export async function concurrencyCases({db,Client,connectionString,report,createFixture,claim,receipt}) {
  const writers = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(writers.map(w=>w.connect()));
  try {
    await Promise.all(writers.map(w=>w.query("SET statement_timeout='10s'")));
    const duplicate = await createFixture(db);
    const raced = await Promise.all(writers.map(w=>claim(w,duplicate,1,false)));
    assert.equal(raced[0].id,raced[1].id);
    assert.equal(raced.filter(c=>c.dispatchToken).length,1,'one dispatch authority');
    assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[duplicate.run])).rows[0].n,1);
    await conserved(db,duplicate);
    report.checks.push('two-backend duplicate claim returns one identity, one token, one hold');

    const shared = await createFixture(db,{credits:10,threshold:3});
    const other = await createFixture(db,{actor:shared.actor,threshold:3});
    const claims = await Promise.allSettled([
      claim(writers[0],shared,1,false),claim(writers[1],other,1,false),
    ]);
    assert.equal(claims.filter(x=>x.status==='fulfilled'&&x.value.id).length,1,'wallet locks serialize competing runs');
    assert.equal(claims.filter(x=>x.status==='fulfilled'&&x.value.state==='waiting_credits').length,1);
    const total = (await db.query(`SELECT coalesce(sum(reserved_credits),0)::int n FROM bill2_calls
      WHERE run_id=ANY($1::uuid[])`,[[shared.run,other.run]])).rows[0].n;
    assert.equal(total,9);
    assert.equal((await financial(db,shared)).credits,1);
    await conserved(db,shared);
    report.checks.push('two runs share one wallet: balance lock admits exactly one hold, loser leaves no call');

    const settled = await createFixture(db);
    const c = await claim(db,settled,1,true);
    await Promise.all(writers.map(w=>receipt(w,settled,c,'0.001',{inputTokens:1000,outputTokens:0})));
    await Promise.all(writers.map(w=>rpc(w,'bill2_finalize',settled.actor,settled.run)));
    assert.equal(Number((await financial(db,settled)).charged_credits),1);
    await conserved(db,settled);
    const history = (await db.query("SELECT count(*)::int n FROM billing_history WHERE metadata->>'preDeductId'=(SELECT pre_deduct_id::text FROM bill2_calls WHERE id=$1)",[c.id])).rows[0];
    assert.equal(history.n,1);
    report.checks.push('two-backend repeated receipt and finalize settle exactly once');

    const cancelling = await createFixture(db);
    const pending = await claim(db,cancelling,1,true);
    await Promise.all([
      receipt(writers[0],cancelling,pending,'0.001',{inputTokens:1000,outputTokens:0}),
      rpc(writers[1],'bill2_cancel',cancelling.actor,cancelling.run),
    ]);
    await rpc(db,'bill2_finalize',cancelling.actor,cancelling.run);
    assert.equal(Number((await financial(db,cancelling)).charged_credits),1);
    await conserved(db,cancelling);
    report.checks.push('concurrent cancellation and final receipt preserve one charge without deadlock');
  } finally {
    await Promise.all(writers.map(w=>w.end()));
  }
}
