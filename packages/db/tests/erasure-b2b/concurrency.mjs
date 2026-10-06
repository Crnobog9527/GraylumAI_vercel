/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc, fixture, call, evidence, closeAccount} from '../erasure-b2a/cases.mjs';
import {seedHistoricalReceipt} from './cases.mjs';

export async function receiptConcurrency({db, Client, connectionString, report}) {
  const f = await fixture(db);
  const c = await call(db, f);
  const original = evidence(c);
  await rpc(db, 'bill2_record', f.actor, f.run, c.id, original);
  const rejected = await seedHistoricalReceipt(db, c, {provider: 'unexpected-provider'});
  await closeAccount(db, f);
  const a = new Client({connectionString});
  const b = new Client({connectionString});
  await a.connect();
  await b.connect();
  try {
    const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    for (const mode of ['scrub', 'record']) {
      await a.query('BEGIN');
      await rpc(a, 'account_erasure_scrub_receipts', f.actor, f.run, 100);
      const pending = mode === 'scrub'
        ? rpc(b, 'account_erasure_scrub_receipts', f.actor, f.run, 100)
        : rpc(b, 'bill2_record', f.actor, f.run, c.id, original);
      // Keep rejection handled while observing actual PostgreSQL lock wait.
      const handled = pending.then(value => ({value}), error => ({error}));
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const state = (await db.query('SELECT cardinality(pg_blocking_pids($1)) n', [pid])).rows[0];
        if (state.n > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, mode + ' waits on original run lock');
      await a.query('COMMIT');
      const result = await handled;
      if (result.error) throw result.error;
      if (mode === 'scrub') assert.deepEqual(result.value, {processed: 0, remaining: 1, manualReview: 1});
      assert.equal((await db.query('SELECT count(*)::int n FROM bill2_receipts WHERE call_id=$1', [c.id])).rows[0].n, 2);
      assert.deepEqual((await db.query('SELECT * FROM bill2_receipts WHERE id=$1', [rejected.id])).rows[0], rejected);
    }
    report.checks.push('two real connections: scrub/scrub and scrub/record serialize; no duplicate/refill; rejected evidence unchanged');
  } finally {
    await a.query('ROLLBACK');
    await a.end();
    await b.end();
  }
}
