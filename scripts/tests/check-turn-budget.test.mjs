/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, loadScenarios, lockClass, measure } from '../check-turn-budget.mjs';

const entry = { roundTrips: 5, dbTimeMs: 60, relationLocks: 40, hotSeqScans: 0 };

test('the ratchet allows equal or smaller counts and 1.5x of the database time, nothing more', () => {
  assert.deepEqual(compare({ roundTrips: 5, dbTimeMs: 60, relationLocks: 40, hotSeqScans: 0 }, entry), []);
  assert.deepEqual(compare({ roundTrips: 4, dbTimeMs: 89, relationLocks: 12, hotSeqScans: 0 }, entry), []);
  assert.deepEqual(compare({ roundTrips: 6, dbTimeMs: 60, relationLocks: 40, hotSeqScans: 0 }, entry), ['roundTrips 6 > baseline 5']);
  assert.deepEqual(compare({ roundTrips: 5, dbTimeMs: 60, relationLocks: 41, hotSeqScans: 1 }, entry), ['relationLocks 41 > baseline 40',
    'hotSeqScans 1 > baseline 0']);
  assert.match(compare({ roundTrips: 5, dbTimeMs: 91, relationLocks: 40, hotSeqScans: 0 }, entry)[0], /dbTimeMs 91 > baseline 60/);
});

test('scenarios are read from the directory; an absent directory means none', async () => {
  assert.deepEqual(await loadScenarios(join(tmpdir(), 'no-such-turn-budget-dir')), []);
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.mjs'), "export default { name: 'a', path: 'old', tables: [], async setup() {}, async run() {} };");
  assert.deepEqual((await loadScenarios(dir)).map(s => s.name), ['a']);
});

test('measure counts each call as one round trip, takes the largest lock set and the functions\' own time', async () => {
  const queries = [];
  const client = {
    async query(sql, args) {
      queries.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      if (/FROM pg_stat_user_functions/.test(sql)) return { rows: [{ funcname: 'f', total_time: queries.filter(q => q === 'SELECT f($1)').length * 2.5 }] };
      if (/FROM pg_stat_user_tables/.test(sql)) return { rows: [{ relname: 't', seq_scan: 3 }] };
      if (/pg_locks/.test(sql)) {
        const n = queries.filter(q => q === 'SELECT f($1)').length * 10;
        return { rows: Array.from({ length: n }, (_, i) => ({ relation: i, owner: i < 5 ? 'turns' : 'credit_transactions' })) };
      }
      if (/^\s*SELECT f/.test(sql)) return { rows: [{ v: 1 }] };
      return { rows: [] };
    },
  };
  const result = await measure({ name: 's', path: 'old', tables: ['t'], async setup() { return {}; }, async run({ call }) { await call('f',
    ['x']); await call('f', ['y']); } }, client);
  assert.equal(result.roundTrips, 2);
  assert.equal(result.relationLocks, 20);
  assert.deepEqual(result.lockClasses, { main: 5, ledger: 15 });
  assert.equal(result.dbTimeMs, 5);
  assert.equal(result.hotSeqScans, 0);
});

test('relation locks are classed as main path, ledger or the kind\'s own, and each class has its own ratchet', () => {
  assert.equal(lockClass('turns'), 'main');
  assert.equal(lockClass('public.session_messages_id_seq'), 'main');
  assert.equal(lockClass('subscription_credit_grants'), 'ledger');
  assert.equal(lockClass('credit_source_entries'), 'ledger');
  assert.equal(lockClass('research_plans'), 'mentor');
  const e = { ...entry, lockClasses: { main: 10, mentor: 20 } };
  assert.deepEqual(compare({ roundTrips: 5, dbTimeMs: 60, relationLocks: 30, hotSeqScans: 0, lockClasses: { main: 10, mentor: 20 } }, e), []);
  assert.deepEqual(compare({ roundTrips: 5, dbTimeMs: 60, relationLocks: 30, hotSeqScans: 0, lockClasses: { main: 11, mentor: 20 } }, e),
    ['main locks 11 > baseline 10']);
});
