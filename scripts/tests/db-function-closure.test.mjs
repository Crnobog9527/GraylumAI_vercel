/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { pruneForKind, kindsOf } from '../db-function-kinds.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, closure, FREE_READ_CATALOG, freeReadViolations, readFunctions, readTables, scan, stripCode, toolCallViolations, unownedReads, DEFAULTS } from '../db-function-closure.mjs';

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

test('pruneForKind keeps an outer NOT and a p_kind that is not the turn kind', () => {
  const negated = "IF NOT (t.kind = 'mentor') THEN PERFORM a_fn(); ELSE PERFORM b_fn(); END IF;";
  for (const kind of ['chat', 'mentor']) assert.ok(['a_fn', 'b_fn'].every(n => pruneForKind(negated, kind).includes(n)));
  const reason = "IF p_kind <> 'stopped' THEN PERFORM c_fn(); END IF;";
  assert.ok(pruneForKind(reason, 'stopped').includes('c_fn'));
  assert.ok(!pruneForKind(reason, 'stopped', true).includes('c_fn'));
});

test('a free read stays read-only, lock-free and keyed by its owner, all the way down', () => {
  const read = (attrs, body) => `CREATE OR REPLACE FUNCTION public.f(p_actor_id uuid)\n RETURNS void\n LANGUAGE plpgsql\n ${attrs}\nAS $function$\n${body}\n$function$;\n`;
  const hits = text => {
    const root = repo({ 'library/f.sql': text, 'library/g.sql': read('STABLE', 'UPDATE a_t SET id = 1 WHERE id = 2;').replace('f(p_actor_id', 'g(p_actor_id') });
    return freeReadViolations(readFunctions(join(root, 'packages/db/functions')), new Set(['a_t']), ['f']);
  };
  assert.deepEqual(hits(read('STABLE SECURITY DEFINER', 'SELECT 1 FROM a_t WHERE actor_id = p_actor_id;')), []);
  assert.match(hits(read('', 'SELECT 1 FROM a_t WHERE actor_id = p_actor_id;')).join(), /not STABLE/);
  assert.match(hits(read('STABLE', 'SELECT 1 FROM a_t WHERE actor_id = p_actor_id FOR UPDATE;')).join(), /row lock in f/);
  assert.match(hits(read('STABLE', 'SELECT 1 FROM a_t WHERE id = 1;')).join(), /a_t without the owner key/);
  const helper = read('STABLE', 'PERFORM h(p_actor_id); SELECT 1 FROM a_t WHERE actor_id = p_actor_id;');
  const root = repo({ 'library/f.sql': helper, 'library/h.sql': read('STABLE', 'SELECT 1 FROM a_t;').replace('f(p_actor_id', 'h(p_actor_id') });
  assert.match(freeReadViolations(readFunctions(join(root, 'packages/db/functions')), new Set(['a_t']), ['f']).join(), /a_t without the owner key in h/);
  assert.match(hits(read('STABLE', 'PERFORM g(p_actor_id); SELECT 1 FROM a_t WHERE actor_id = p_actor_id;')).join(), /write in g/);
  assert.match(hits(fn('f', 'SELECT 1 FROM a_t WHERE actor_id = p_actor_id;').replace('f()', 'f(p_other uuid)')).join(), /p_actor_id first/);
  assert.deepEqual(freeReadViolations(new Map(), new Set(), ['gone']), ['gone: free read has no function']);
});

test('only the listed tables may go without an owner column, and a linked one only by its key', () => {
  const lists = { linked: { v_t: ['id'], i_t: ['work_item_id'] }, catalog: ['c_t'] };
  const tables = new Set(['o_t', 'v_t', 'i_t', 'c_t', 'x_t']);
  const reads = sql => unownedReads(sql, tables, lists);
  assert.deepEqual(reads('SELECT 1 FROM o_t o JOIN v_t v ON v.id = o.version_id WHERE o.actor_id = p_actor_id;'), []);
  assert.deepEqual(reads('SELECT * INTO v FROM v_t WHERE id = version_id;'), []);
  assert.deepEqual(reads('SELECT 1 FROM i_t WHERE work_item_id = item;'), []);
  assert.deepEqual(reads('SELECT 1 FROM c_t WHERE key = k;'), []);
  // Reverse: a table outside the lists fails whatever it is joined to or filtered by.
  assert.deepEqual(reads('SELECT 1 FROM x_t WHERE id = item;'), ['x_t']);
  assert.deepEqual(reads('SELECT 1 FROM o_t o JOIN x_t x ON x.id = o.version_id WHERE o.actor_id = p_actor_id;'), ['x_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM v_t WHERE id = item;', tables), ['v_t']);
  // A linked table without its key, or by another column, or by itself, proves nothing.
  assert.deepEqual(reads('SELECT 1 FROM v_t;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t WHERE state = s;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE v.id = v.id;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE v.id = id;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE id = v.id;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE v.id = item;'), []);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE NOT v.id = item;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE NOT item = v.id;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE v.id <> item;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t v WHERE v.id = item AND NOT EXISTS (SELECT 1);'), []);
  assert.deepEqual(reads('SELECT 1 FROM v_t WHERE id = item OR state = s;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM i_t WHERE id = item;'), ['i_t']);
  // A linked table does not vouch for an owned one, and a catalog comma join cannot hide a table.
  assert.deepEqual(reads('SELECT 1 FROM v_t v JOIN o_t o ON o.id = v.id WHERE v.id = item;'), ['o_t']);
  assert.deepEqual(reads('SELECT 1 FROM c_t c, x_t x WHERE c.key = k;'), ['c_t']);
  // A quoted alias does not hide the comma join behind a catalog table.
  assert.deepEqual(reads('SELECT 1 FROM c_t AS "c", x_t x WHERE c.key = k;'), ['c_t']);
  assert.deepEqual(reads('SELECT 1 FROM v_t "v", x_t x WHERE v.id = item;'), ['v_t']);
  assert.deepEqual(reads('SELECT 1 FROM o_t "o" JOIN v_t "v" ON v.id = o.version_id WHERE o.actor_id = p_actor_id;'), []);
});

test('the repository\'s own catalog list leaves site settings out: a free read of system_settings fails', () => {
  assert.equal(FREE_READ_CATALOG.includes('system_settings'), false);
  assert.deepEqual(unownedReads('SELECT value FROM system_settings WHERE key = k;', new Set(['system_settings'])), ['system_settings']);
  assert.deepEqual(unownedReads('SELECT 1 FROM skills s JOIN system_settings c ON c.key = s.name WHERE s.id = 1;',
    new Set(['skills', 'system_settings'])), ['system_settings']);
});

test('a free read checks the owner itself, even when it reaches only listed tables', () => {
  const read = body => `CREATE OR REPLACE FUNCTION public.f(p_actor_id uuid)\n RETURNS void\n LANGUAGE plpgsql\n STABLE\nAS $function$\n${body}\n$function$;\n`;
  const hits = body => freeReadViolations(readFunctions(join(repo({ 'library/f.sql': read(body) }), 'packages/db/functions')), new Set(['skills']), ['f']);
  assert.match(hits('SELECT 1 FROM skills WHERE id = 1;').join(), /without an owner check/);
  assert.deepEqual(hits('SELECT 1 FROM skills WHERE id = 1; SELECT 1 FROM profiles WHERE profile_id = p_actor_id;'), []);
  // Computing the comparison is not checking it.
  assert.match(hits('SELECT actor_id = p_actor_id AS is_owner FROM skills;').join(), /without an owner check/);
  assert.match(hits('SELECT 1 FROM skills ORDER BY actor_id = p_actor_id;').join(), /without an owner check/);
  assert.deepEqual(hits('IF NOT EXISTS (SELECT 1 FROM profiles WHERE profile_id = p_actor_id) THEN RETURN; END IF; SELECT 1 FROM skills;'), []);
});

test('every read of a free read carries the owner key itself; one filtered branch does not vouch for another', () => {
  const tables = new Set(['a_t', 'b_t']);
  const owned = 'SELECT 1 FROM a_t WHERE actor_id = p_actor_id';
  assert.deepEqual(unownedReads(`${owned}; SELECT 1 FROM b_t WHERE id = 1;`, tables), ['b_t']);
  assert.deepEqual(unownedReads(`IF x THEN ${owned}; ELSE SELECT (SELECT 1 FROM b_t);END IF;`, tables), ['b_t']);
  assert.deepEqual(unownedReads(`${owned} UNION ALL SELECT 1 FROM b_t WHERE id = 1;`, tables), ['b_t']);
  assert.deepEqual(unownedReads(`SELECT 1 FROM b_t WHERE id IN (${owned});`, tables), ['b_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM a_t x JOIN b_t y ON y.id = x.id WHERE x.actor_id = p_actor_id;', tables), ['b_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM a_t x JOIN b_t y ON y.actor_id = x.actor_id WHERE x.actor_id = p_actor_id;', tables), []);
  assert.deepEqual(unownedReads('SELECT actor_id = p_actor_id AS is_owner FROM b_t WHERE id = 1;', tables), ['b_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM b_t WHERE id = 1 ORDER BY actor_id = p_actor_id;', tables), ['b_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM b_t WHERE actor_id = p_actor_id OR id = 1;', tables), ['b_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM b_t WHERE actor_id = p_actor_id AND (id = 1 OR id = 2);', tables), []);
  assert.deepEqual(unownedReads('SELECT 1 FROM a_t x LEFT JOIN b_t y ON y.actor_id = x.actor_id AND x.actor_id = p_actor_id;', tables), ['a_t', 'b_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM a_t x LEFT JOIN b_t y ON y.id = x.id WHERE x.actor_id = p_actor_id AND y.actor_id = x.actor_id;', tables), []);
  assert.deepEqual(unownedReads('SELECT 1 FROM a_t d, b_t s WHERE d.actor_id = p_actor_id;', tables), ['a_t']);
  assert.deepEqual(unownedReads('SELECT 1 FROM a_t r WHERE r.profile_id = p_actor_id; SELECT 1 FROM unnest(z) w;', tables), []);
});

test('the tool layer calls only the free reads, through the read client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'));
  const hits = text => { writeFileSync(join(dir, 'x.ts'), text); return toolCallViolations(dir, ['f']); };
  assert.deepEqual(hits("await read.rpc('f', {}); Buffer.from(x); Array.from({ length: 2 });"), []);
  assert.match(hits("await read.rpc('g', {});").join(), /outside the free reads/);
  assert.match(hits("await admin.from('turns').select();").join(), /outside the free reads/);
  assert.match(hits('await read.rpc(name, {});').join(), /outside the free reads/);
  assert.match(hits("await read.rpc('f' + '_other', {});").join(), /outside the free reads/);
  assert.match(hits('await read.rpc(`f${x}`, {});').join(), /outside the free reads/);
  assert.match(hits("await write.rpc('f', {});").join(), /not through the read client/);
  assert.deepEqual(toolCallViolations(join(dir, 'absent')), []);
});

test('the repository holds: library_turn_read is a free read and the tools call nothing else', () => {
  const result = analyze();
  assert.deepEqual(result.violations.filter(v => /free read|tool calls|library_turn_read/.test(v)), []);
});

test('pruneForKind drops the WHEN branches of CASE p_kind that other kinds take, and keeps what it cannot judge', () => {
  const simple = "x := CASE p_kind WHEN 'mentor' THEN mentor_fn(a) WHEN 'report', 'review' THEN rep_fn(CASE WHEN q THEN 1 ELSE 2 END) ELSE other_fn() END;";
  const seen = (body, kind, names) => names.filter(n => pruneForKind(body, kind, true).includes(n));
  const names = ['mentor_fn', 'rep_fn', 'other_fn'];
  assert.deepEqual(seen(simple, 'mentor', names), ['mentor_fn']);
  assert.deepEqual(seen(simple, 'review', names), ['rep_fn']);
  assert.deepEqual(seen(simple, 'chat', names), ['other_fn']);
  // A WHEN value that is not only string literals cannot be judged: every branch stays, ELSE included.
  const open = "x := CASE p_kind WHEN 'mentor' THEN mentor_fn() WHEN some_var THEN rep_fn() ELSE other_fn() END;";
  assert.deepEqual(seen(open, 'chat', names), ['rep_fn', 'other_fn']);
  assert.deepEqual(seen(open, 'mentor', names), ['mentor_fn', 'rep_fn']);
  // p_kind that is not the turn kind, and a searched CASE, are left alone.
  assert.deepEqual(names.filter(n => pruneForKind(simple, 'chat').includes(n)), names);
  const searched = "x := CASE WHEN a THEN mentor_fn() ELSE other_fn() END;";
  assert.deepEqual(seen(searched, 'chat', ['mentor_fn', 'other_fn']), ['mentor_fn', 'other_fn']);
});

test('pruneForKind reads neither an IF inside a CASE branch nor a keyword inside a string as the CASE own', () => {
  const inner = "CASE p_kind WHEN 'mentor' THEN IF v_flag THEN PERFORM helper_a(); ELSE PERFORM helper_b(); END IF; WHEN 'report' THEN PERFORM rep_fn(); END CASE;";
  const has = (body, kind, n) => pruneForKind(body, kind, true).includes(n);
  assert.ok(has(inner, 'mentor', 'helper_a') && has(inner, 'mentor', 'helper_b') && !has(inner, 'mentor', 'rep_fn'));
  const text = "SELECT CASE p_kind WHEN 'mentor' THEN concat('ELSE', helper_a()) ELSE helper_b() END;";
  assert.ok(has(text, 'mentor', 'helper_a') && !has(text, 'mentor', 'helper_b') && has(text, 'chat', 'helper_b'));
  const ifString = "IF p_kind = 'x' THEN PERFORM a_fn('END IF'); END IF; PERFORM b_fn();";
  assert.ok(has(ifString, 'chat', 'b_fn') && !has(ifString, 'chat', 'a_fn'));
});

test('pruneForKind does not read END LOOP as the end of a CASE, and keeps every branch around a nested BEGIN block', () => {
  const loop = "CASE p_kind WHEN 'mentor' THEN CASE v_flag WHEN true THEN LOOP PERFORM helper_a(); EXIT; END LOOP; ELSE PERFORM helper_b(); END CASE; ELSE PERFORM helper_c(); END CASE;";
  const has = (body, kind, n) => pruneForKind(body, kind, true).includes(n);
  assert.ok(has(loop, 'mentor', 'helper_a') && has(loop, 'mentor', 'helper_b') && !has(loop, 'mentor', 'helper_c'));
  const block = "CASE p_kind WHEN 'mentor' THEN BEGIN PERFORM helper_a(); END; ELSE PERFORM helper_c(); END CASE;";
  assert.ok(has(block, 'mentor', 'helper_a') && has(block, 'mentor', 'helper_c'));
});
