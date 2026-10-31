/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { pruneForKind, kindsOf } from '../db-function-kinds.mjs';
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

test('a baseline lets known debt through and fails anything new or bigger; it only shrinks', async () => {
  const { applyBaseline, shrinkBaseline } = await import('../db-function-closure.mjs');
  const baseline = { closure: { turn_open: { functions: 78, tables: 53 } }, rules: ['turn_x: non-LOCAL SET'] };
  const known = ['turn_open: 78 reachable functions (max 15)', 'turn_open: 53 reachable tables (max 10)', 'turn_x: non-LOCAL SET'];
  assert.deepEqual(applyBaseline(known, baseline), { failing: [], known });
  const worse = ['turn_open: 79 reachable functions (max 15)', 'turn_y: advisory lock', 'turn_z: 20 reachable tables (max 10)'];
  assert.deepEqual(applyBaseline(worse, baseline).failing, worse, 'a bigger closure, a new rule hit and an unlisted function all fail');
  assert.deepEqual(shrinkBaseline(['turn_open: 60 reachable functions (max 15)', 'turn_new: advisory lock'], baseline),
    { closure: { turn_open: { functions: 60 } }, rules: [] }, 'smaller sizes are kept, fixed rules are dropped, nothing new is added');
});

test('a lock is attributed to its own SELECT: CTE names are not tables, nested selects and siblings do not count', () => {
  const hits = body => scan('f', body, DEFAULTS);
  const claim = `WITH due AS (SELECT t.id FROM turns t WHERE t.state='x' ORDER BY t.id LIMIT 5 FOR UPDATE OF t SKIP LOCKED),
    leased AS (UPDATE turns SET state='y' WHERE id IN (SELECT id FROM due) RETURNING id) SELECT id FROM leased;`;
  assert.deepEqual(hits(claim), [], 'FOR UPDATE ... SKIP LOCKED locks turns; due and leased are CTE names');
  assert.deepEqual(hits('WITH due AS (SELECT id FROM turns FOR UPDATE SKIP LOCKED) SELECT id FROM due;'), []);
  assert.deepEqual(hits('WITH due AS (SELECT id FROM secret_things FOR UPDATE SKIP LOCKED) SELECT id FROM due;'), ['f: row lock on secret_things']);
  assert.deepEqual(hits('SELECT id FROM profiles WHERE id IN (SELECT id FROM secret_things) FOR UPDATE;'), [], 'the subquery is not locked');
  assert.deepEqual(hits('SELECT 1 FROM profiles p JOIN secret_things s ON true WHERE p.id=a FOR UPDATE OF s;'), ['f: row lock on secret_things']);
});

test('SET is a statement, UPDATE ... SET on its own line is not; ledger leaves may lock and write source rows; kind tables are writable', () => {
  const hits = (body, name = 'f') => scan(name, body, DEFAULTS);
  assert.deepEqual(hits('UPDATE turns\n  SET state = 1\n  WHERE id = b;'), []);
  assert.deepEqual(hits('SET search_path = x;'), ['f: non-LOCAL SET']);
  assert.deepEqual(hits('BEGIN SET statement_timeout TO 5; END;'), ['f: non-LOCAL SET']);
  assert.deepEqual(hits('SET LOCAL statement_timeout = 5;'), []);
  const ledger = 'SELECT 1 FROM subscription_credit_grants WHERE user_id=a FOR UPDATE; UPDATE subscription_credit_grants SET consumed=1 WHERE id=g;';
  assert.deepEqual(hits(ledger), ['f: row lock on subscription_credit_grants', 'f: UPDATE of subscription_credit_grants']);
  assert.deepEqual(hits(ledger, 'turn_settle_credits'), [], 'the ledger leaf is exempt from the table lists');
  assert.deepEqual(hits('SET search_path = x;', 'turn_settle_credits'), ['turn_settle_credits: non-LOCAL SET'], 'but not from the session-state rules');
  assert.deepEqual(hits('UPDATE artifact_rounds SET steps = s WHERE id = r;'), []);
  assert.deepEqual(hits('UPDATE profiles SET credits = 0 WHERE true RETURNING id;'), ['f: UPDATE of profiles without id in WHERE'],
    'a key named only in RETURNING does not filter');
  assert.deepEqual(hits('PERFORM 1 FROM profiles WHERE true ORDER BY id FOR UPDATE;'), ['f: row lock on profiles without id in WHERE'],
    'nor does one in ORDER BY');
  assert.deepEqual(hits('BEGIN FOR r IN SELECT id FROM secret_things FOR UPDATE LOOP NULL; END LOOP; END;'), ['f: row lock on secret_things'],
    'a FOR UPDATE that ends in LOOP is still a lock');
  assert.deepEqual(hits('FOR r IN SELECT id FROM turns WHERE actor_id = a LOOP PERFORM 1 FROM profiles WHERE id = a FOR UPDATE; END LOOP;'), [],
    'a loop head is not part of the lock inside its body');
  assert.deepEqual(hits('UPDATE artifact_rounds SET steps = s;'), ['f: UPDATE of artifact_rounds without id or project_id in WHERE']);
  assert.deepEqual(hits('UPDATE fusion_reviews SET turn_id = t WHERE actor_id = a AND id = r;'), [], 'a jury review: one row, by its owner key');
  assert.deepEqual(hits('UPDATE fusion_compares SET turn_id = t WHERE state = s;'), ['f: UPDATE of fusion_compares without actor_id or id in WHERE']);
  assert.deepEqual(hits('UPDATE fusion_reviews SET state = s;'), ['f: UPDATE of fusion_reviews without actor_id or id in WHERE']);
});

test('an allowed lock must carry its owner key; a SKIP LOCKED batch claim need not; a multi-line UPDATE is not a SET command', () => {
  const hits = body => scan('f', body, DEFAULTS);
  assert.deepEqual(hits('BEGIN\n PERFORM id FROM profiles FOR UPDATE;\nEND;'), ['f: row lock on profiles without id in WHERE']);
  assert.deepEqual(hits('SELECT 1 FROM runtime_sessions s WHERE s.scope = x FOR UPDATE OF s;'),
    ['f: row lock on runtime_sessions without id or actor_id in WHERE']);
  assert.deepEqual(hits('SELECT 1 FROM turns WHERE actor_id = a AND request_id = r FOR UPDATE;'), []);
  assert.deepEqual(hits('WITH due AS (SELECT id FROM turns WHERE state = x LIMIT 5 FOR UPDATE SKIP LOCKED) SELECT id FROM due;'), []);
  assert.deepEqual(hits('BEGIN\n UPDATE turns\n SET state=1 WHERE actor_id=a AND id=b;\nEND;'), []);
}); 

test('every UPDATE of a statement is judged by its own WHERE, and a SET command inside IF / ELSE / BEGIN is found', () => {
  const hits = body => scan('f', body, DEFAULTS);
  assert.deepEqual(hits("WITH moved AS (UPDATE turns SET state='closed' WHERE actor_id=a RETURNING id) UPDATE profiles SET credits=0;"),
    ['f: UPDATE of profiles without id in WHERE'], 'the CTE\'s owner key does not satisfy the outer UPDATE');
  assert.deepEqual(hits("WITH moved AS (UPDATE turns SET state='closed' WHERE actor_id=a RETURNING id) UPDATE secret_things SET x=1;"),
    ['f: UPDATE of secret_things']);
  assert.deepEqual(hits("WITH moved AS (UPDATE turns SET state='closed' RETURNING id) UPDATE profiles SET credits=0 WHERE id=a;"),
    ['f: UPDATE of turns without actor_id or id in WHERE'], 'the CTE UPDATE has no WHERE of its own');
  assert.deepEqual(hits("WITH moved AS (UPDATE turns SET state='closed' WHERE actor_id=a RETURNING id) UPDATE profiles SET credits=0 WHERE id=a;"), []);
  assert.deepEqual(hits('BEGIN IF should_change THEN SET search_path TO other; END IF; END;'), ['f: non-LOCAL SET']);
  assert.deepEqual(hits('BEGIN IF a THEN NULL; ELSE SET statement_timeout = 5; END IF; END;'), ['f: non-LOCAL SET']);
  assert.deepEqual(hits('BEGIN IF a THEN SET LOCAL statement_timeout = 5; END IF; END;'), []);
  assert.deepEqual(hits('BEGIN IF a THEN\n UPDATE turns\n SET state=1 WHERE actor_id=a AND id=b;\n END IF; END;'), []);
});

test('pruneForKind drops branches another kind takes, and keeps what it cannot judge', () => {
  const body = `BEGIN
    IF t.kind = 'mentor' THEN PERFORM mentor_fn(); ELSIF t.kind = 'report' THEN PERFORM report_fn(); ELSE PERFORM other_fn(); END IF;
    IF p_kind = 'report' OR x THEN PERFORM mixed_fn(); END IF;
    IF t.kind <> 'report' THEN PERFORM skip_rep_fn(); END IF;
    PERFORM CASE WHEN a THEN b ELSE c END;
  END;`;
  const seen = kind => ['mentor_fn', 'report_fn', 'other_fn', 'mixed_fn', 'skip_rep_fn'].filter(n => pruneForKind(body, kind).includes(n));
  assert.deepEqual(seen('mentor'), ['mentor_fn', 'mixed_fn', 'skip_rep_fn']);
  assert.deepEqual(seen('report'), ['report_fn', 'mixed_fn']);
  assert.deepEqual(seen('chat'), ['other_fn', 'mixed_fn', 'skip_rep_fn']);
});

test('kindsOf limits the fusion functions to the kinds they accept', () => {
  assert.deepEqual(kindsOf('turn_fusion_open'), ['compare', 'jury', 'jury_adopt']);
  assert.deepEqual(kindsOf('turn_fusion_recovery'), ['jury', 'jury_adopt']);
  assert.ok(kindsOf('turn_close').includes('chat'));
});
