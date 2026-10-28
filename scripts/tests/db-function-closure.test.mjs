/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, closure, readFunctions, readTables, scan, stripCode, DEFAULTS } from '../db-function-closure.mjs';

const fn = (name, body) => `CREATE OR REPLACE FUNCTION public.${name}()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\n${body}\n$function$;\n`;
function repo(files, tables = ['profiles', 'turns', 'runtime_sessions', 'turn_calls', 'daily_spend', 'catalog_versions', 'secret_things', 'a_t', 'b_t']) {
  const root = mkdtempSync(join(tmpdir(), 'closure-'));
  mkdirSync(join(root, 'packages/db/migrations'), { recursive: true });
  mkdirSync(join(root, 'packages/db/baseline'), { recursive: true });
  writeFileSync(join(root, 'packages/db/baseline/0000_core_prerequisites.sql'),
    'CREATE TABLE IF NOT EXISTS public.profiles(id uuid);\nCREATE TABLE public.credit_transactions(id int);');
  writeFileSync(join(root, 'packages/db/migrations/0001.sql'), tables.map(t => `CREATE TABLE public.${t}(id int);`).join('\n'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, 'packages/db/functions', path, '..'), { recursive: true });
    writeFileSync(join(root, 'packages/db/functions', path), text);
  }
  return root;
}

test('comments and string literals are not code', () => {
  assert.equal(stripCode("x -- FROM secret_things\n'FROM secret_things' /* UPDATE turns */ y").replace(/\s+/g, ' ').trim(), "x '' y");
});

test('closure counts reachable functions and tables and does not enter ledger leaves', () => {
  const root = repo({
    'turn/turn_open.sql': fn('turn_open', 'PERFORM helper_a(); PERFORM atomic_pre_deduct(); SELECT 1 FROM profiles WHERE id=1;'),
    'other/helper_a.sql': fn('helper_a', 'PERFORM helper_b(); SELECT 1 FROM a_t;'),
    'other/helper_b.sql': fn('helper_b', 'SELECT 1 FROM b_t;'),
    'billing/atomic_pre_deduct.sql': fn('atomic_pre_deduct', 'SELECT 1 FROM secret_things;'),
  });
  const c = closure('turn_open', readFunctions(join(root, 'packages/db/functions')),
    readTables(join(root, 'packages/db/baseline'), join(root, 'packages/db/migrations')));
  assert.deepEqual(c.functions, ['atomic_pre_deduct', 'helper_a', 'helper_b', 'turn_open']);
  assert.deepEqual(c.tables, ['a_t', 'b_t', 'profiles'], 'the leaf\'s own table is not reached; profiles comes from the baseline file');
});

test('rules: row locks, UPDATE targets and keys, session state, temporary tables', () => {
  const bad = (body) => scan('f', body, DEFAULTS);
  assert.deepEqual(bad('SELECT 1 FROM profiles WHERE id=a FOR UPDATE;'), []);
  assert.deepEqual(bad('SELECT 1 FROM runtime_sessions s WHERE s.id=a FOR UPDATE OF s;'), []);
  assert.deepEqual(bad('SELECT 1 FROM catalog_versions FOR SHARE;'), ['f: row lock on catalog_versions']);
  assert.deepEqual(bad('SELECT 1 FROM profiles p JOIN secret_things s ON true WHERE p.id=a FOR UPDATE OF s;'), ['f: row lock on secret_things']);
  assert.deepEqual(bad('UPDATE turns SET state=1 WHERE actor_id=a AND id=b;'), []);
  assert.deepEqual(bad('UPDATE turns SET state=1;'), ['f: UPDATE of turns without actor_id or id in WHERE']);
  assert.deepEqual(bad('UPDATE secret_things SET x=1 WHERE id=1;'), ['f: UPDATE of secret_things']);
  // The UPDATE may open a control block and its alias may omit AS.
  assert.deepEqual(bad('BEGIN\n UPDATE secret_things s SET x=1; END;'), ['f: UPDATE of secret_things']);
  assert.deepEqual(bad('IF a THEN UPDATE turns t SET state=1 WHERE t.id=b; END IF;'), []);
  assert.deepEqual(bad('IF a THEN UPDATE turns t SET state=1; END IF;'), ['f: UPDATE of turns without actor_id or id in WHERE']);
  assert.deepEqual(bad('ELSE UPDATE secret_things AS s SET x=1; END IF;'), ['f: UPDATE of secret_things']);
  assert.deepEqual(bad('INSERT INTO turns(id) VALUES(1) ON CONFLICT (id) DO UPDATE SET state=1;'), [], 'DO UPDATE SET names no table');
  assert.deepEqual(bad('UPDATE daily_spend SET spent=spent+1 WHERE day=d AND bucket=b;'), []);
  assert.deepEqual(bad("PERFORM pg_advisory_xact_lock(1);"), ['f: advisory lock']);
  assert.deepEqual(bad("PERFORM pg_advisory_lock(1);"), ['f: advisory lock']);
  assert.deepEqual(bad("SET search_path = x;"), ['f: non-LOCAL SET']);
  assert.deepEqual(bad("SET LOCAL lock_timeout = 5;"), []);
  assert.deepEqual(bad("PERFORM set_config('a.b','1',false);"), ['f: session-level set_config']);
  assert.deepEqual(bad("PERFORM set_config('a.b','1',true);"), []);
  assert.deepEqual(bad("CREATE TEMP TABLE t(x int);"), ['f: temporary table']);
  assert.deepEqual(bad("-- FOR UPDATE\nRAISE EXCEPTION 'UPDATE secret_things SET x=1';"), [], 'comments and messages are ignored');
});

test('the enforced directory is checked, everything else is only reported; an absent directory skips', () => {
  const old = fn('old_one', 'PERFORM pg_advisory_lock(1); SELECT 1 FROM secret_things FOR UPDATE;');
  const noTurn = repo({ 'runtime/old_one.sql': old });
  const skipped = analyze({ root: noTurn, roots: ['old_one'] });
  assert.equal(skipped.enforcedDirPresent, false);
  assert.deepEqual(skipped.violations, []);
  assert.ok(skipped.reported.old_one.length >= 2, 'the old path is reported');
  const withTurn = repo({ 'runtime/old_one.sql': old, 'turn/turn_open.sql': fn('turn_open',
    'PERFORM old_one(); SELECT 1 FROM profiles WHERE id=a FOR UPDATE; PERFORM pg_advisory_xact_lock(1);') });
  const checked = analyze({ root: withTurn });
  assert.equal(checked.enforcedDirPresent, true);
  assert.deepEqual(checked.violations, ['turn_open: advisory lock'], 'only the turn function is enforced');
  assert.equal(checked.roots.turn_open.functions, 2);
});

test('closure limits are enforced for turn functions', () => {
  const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`other/h${i}.sql`, fn(`h${i}`, i < 15 ? `PERFORM h${i + 1}();` : 'SELECT 1;')]));
  const root = repo({ 'turn/turn_open.sql': fn('turn_open', 'PERFORM h0();'), ...many });
  const result = analyze({ root });
  assert.match(result.violations.join('\n'), /turn_open: 17 reachable functions \(max 15\)/);
});
