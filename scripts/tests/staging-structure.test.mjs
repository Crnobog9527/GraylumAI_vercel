/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareStructure } from '../../packages/db/tests/baseline/staging-comparison.mjs';
import { captureSql, parseSnapshot } from '../staging-structure.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const permissions = read('../../packages/db/tests/baseline/staging-test-permissions.json').objects;
const platform = read('../../packages/db/tests/baseline/expected-differences.json').platformOnlyOnStaging.keys;
const local = { 'rel:ai_models': 'r', 'col:ai_models.id': 'uuid NOT NULL', 'fn:business()': 'business definition' };
const hash = value => createHash('md5').update(value ?? '<null>').digest('hex').slice(0, 12);
const built = { objects: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, hash(v)])) };
const make = () => ({ format: 'graylum-structure-v2', searchPath: 'public',
  objects: { ...local, ...Object.fromEntries(platform.map(key => [key, 'platform definition'])), ...permissions } });
const complete = snapshot => ({ ...snapshot, objectCount: Object.keys(snapshot.objects).length });
const check = snapshot => compareStructure(local, complete(snapshot), { stagingTestPermissions: true });
const grant = 'colacl:turns.id';
const policy = 'pol:turns.core_e2e_read';

test('exactly 25 column grants and 3 complete policies pass in both replay and controller checks', () => {
  assert.equal(Object.keys(permissions).filter(key => key.startsWith('colacl:')).length, 25);
  assert.equal(Object.keys(permissions).filter(key => key.startsWith('pol:')).length, 3);
  const snapshot = complete(make());
  const result = check(snapshot);
  assert.deepEqual(result.unexpected, []);
  assert.equal(result.verifiedTestPermissions.length, 28);
  assert.deepEqual(compareStructure(built.objects, snapshot, { hashed: true, stagingTestPermissions: true }), result);
});
for (const [name, mutate] of [
  ['extra column', s => { s.objects['colacl:turns.policy'] = permissions[grant]; }],
  ['extra policy', s => { s.objects['pol:turns.unapproved'] = permissions[policy]; }],
  ['missing grant', s => { delete s.objects[grant]; }],
  ['missing whole policy group', s => { delete s.objects[policy]; }],
  ['UPDATE permission', s => { s.objects[grant] = 'core_e2e_reader=rw/postgres'; }],
  ['grant option', s => { s.objects[grant] = 'core_e2e_reader=r*/postgres'; }],
  ['other role', s => { s.objects[grant] = 'authenticated=r/postgres'; }],
  ['other grantor', s => { s.objects[grant] = 'core_e2e_reader=r/other'; }],
  ['additional grantee', s => { s.objects[grant] += ',anon=r/postgres'; }],
  ['ALL policy', s => { s.objects[policy] = permissions[policy].replace('SELECT', 'ALL'); }],
  ['policy roles', s => { s.objects[policy] = permissions[policy].replace('{core_e2e_reader}', '{public}'); }],
  ['policy condition', s => { s.objects[policy] = permissions[policy].replace('true', 'false'); }],
  ['policy check expression', s => { s.objects[policy] += ' | true'; }],
  ['same table other change', s => { s.objects['col:ai_models.id'] = 'text'; }],
  ['other business function change', s => { s.objects['fn:business()'] += ' changed'; }],
  ['unknown event trigger', s => { s.objects['evt:unapproved'] = 'definition'; }],
  ['unknown default privileges', s => { s.objects['defacl:unapproved.r'] = 'privileges'; }],
  ['stale platform exception', s => { delete s.objects[platform[0]]; }],
]) test(`rejects ${name}`, () => {
  const snapshot = make(); mutate(snapshot);
  assert.ok(check(snapshot).unexpected.length);
  assert.ok(compareStructure(built.objects, complete(snapshot), { hashed: true, stagingTestPermissions: true }).unexpected.length);
});

test('ordinary build/release comparison never opts into staging permissions', () => {
  assert.ok(compareStructure(local, complete(make())).unexpected.some(x => x.includes(grant)));
  const snapshot = make(); for (const key of Object.keys(permissions)) delete snapshot.objects[key];
  assert.deepEqual(compareStructure(local, complete(snapshot)).unexpected, []);
  assert.ok(compareStructure({ ...local, ...permissions }, complete(make()), { stagingTestPermissions: true }).unexpected.length);
});

test('missing/hashed definitions, partial snapshots and invalid local inputs fail closed', () => {
  for (const change of [s => { delete s.objects; }, s => { delete s.objectCount; }, s => { s.objectCount++; },
    s => { s.searchPath = 'public, extensions'; }, s => { s.format = 'legacy'; }, s => { s.objects[grant] = {}; }]) {
    const s = complete(make()); change(s); assert.throws(() => compareStructure(local, s, { stagingTestPermissions: true }));
  }
  const s = make(); s.objects[grant] = hash(permissions[grant]); assert.ok(check(s).unexpected.length);
  assert.throws(() => compareStructure({}, complete(make())));
  assert.throws(() => compareStructure({ x: 'not-a-hash' }, complete(make()), { hashed: true }));
  assert.throws(() => parseSnapshot('{broken'));
  assert.throws(() => parseSnapshot(JSON.stringify({ rows: [] })));
  assert.throws(() => parseSnapshot(JSON.stringify({ rows: [{ snapshot: complete(make()) }, {}] })));
});

test('capture is one read-only transaction with full catalog definitions and a fixed search path', () => {
  const sql = captureSql();
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /SET LOCAL search_path = public;/);
  assert.match(sql, /jsonb_object_agg\(k,d ORDER BY k\)/);
  assert.match(sql, /COMMIT;\s*$/);
  const s = complete(make()); assert.deepEqual(parseSnapshot(JSON.stringify({ rows: [{ snapshot: s }] })), s);
});

test('controller shell blocks writes on failed precheck and blocks merge on failed postcheck (stubbed services)', () => {
  const temp = mkdtempSync(join(tmpdir(), 'graylum-structure-'));
  try {
    const install = spawnSync(process.execPath, ['scripts/install-staging-structure-tools.mjs', '--target', temp], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const shell = readFileSync(join(temp, 'mig-apply.sh'), 'utf8').replace('T=~/.graylum/controller-tools', `T='${temp}'`);
    writeFileSync(join(temp, 'apply-test.sh'), shell);
    mkdirSync(join(temp, 'sb/supabase/.temp'), { recursive: true });
    writeFileSync(join(temp, 'sb/supabase/.temp/project-ref'), 'gvcpmcunmfrbxuwimxfa');
    mkdirSync(join(temp, 'm0550')); mkdirSync(join(temp, 'bin'));
    writeFileSync(join(temp, 'm0550/0550.sql'), 'STUB ONLY');
    writeFileSync(join(temp, 'm0550/stg.json'), JSON.stringify(built));
    writeFileSync(join(temp, 'm0550/built.json'), JSON.stringify(built));
    const valid = JSON.stringify({ rows: [{ snapshot: complete(make()) }] });
    writeFileSync(join(temp, 'valid.json'), valid);
    writeFileSync(join(temp, 'invalid.json'), '{}');
    writeFileSync(join(temp, 'bin/gh'), `#!/bin/sh
case "$*" in
 *headRefOid*) echo testcommit;;
 *isDraft*) echo false;;
 *baseRefName*) echo staging;;
 *mergeCommit*) echo merged;;
 *'pr merge'*) echo MERGE >> '${temp}/effects';;
esac
`, { mode: 0o755 });
    writeFileSync(join(temp, 'bin/supabase'), `#!/bin/sh
case "$*" in
 *capture-direct.sql*) cat "$BEFORE";;
 *capture-after.sql*) cat "$AFTER";;
 */0550.sql*) echo WRITE >> '${temp}/effects'; echo '{}';;
 */rec.sql*) echo RECORD >> '${temp}/effects'; echo '{"rows":[{"version":"stub"}]}';;
 *) exit 9;;
esac
`, { mode: 0o755 });
    const run = (before, after, overrides = {}) => {
      writeFileSync(join(temp, 'effects'), '');
      const r = spawnSync('bash', [join(temp, 'apply-test.sh'), '0550', '123', 'testcommit', 'test_migration'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${temp}/bin:${process.env.PATH}`,
          BEFORE: join(temp, before), AFTER: join(temp, after), ALLOW_EXTRA: '', MIG_REVIEWED: '1', ...overrides },
      });
      return { ...r, effects: readFileSync(join(temp, 'effects'), 'utf8') };
    };
    let r = run('valid.json', 'valid.json', { MIG_REVIEWED: '' }); assert.notEqual(r.status, 0); assert.equal(r.effects, '');
    r = run('invalid.json', 'valid.json'); assert.notEqual(r.status, 0); assert.equal(r.effects, '');
    r = run('valid.json', 'invalid.json'); assert.notEqual(r.status, 0); assert.match(r.effects, /WRITE/); assert.doesNotMatch(r.effects, /MERGE/);
    r = run('valid.json', 'valid.json'); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.effects, /MERGE/);
    r = run('valid.json', 'valid.json', { ALLOW_EXTRA: '.*' }); assert.notEqual(r.status, 0); assert.equal(r.effects, '');
    writeFileSync(join(temp, 'sb/supabase/.temp/project-ref'), 'wrong-project');
    r = run('valid.json', 'valid.json'); assert.notEqual(r.status, 0); assert.equal(r.effects, '');
    const go = readFileSync(join(temp, 'mig-go.sh'), 'utf8');
    assert.doesNotMatch(go, /PLATFORM=|grep -vE|ALLOW_EXTRA=|RISK=/);
    assert.match(go, /MODE=\$\{2:---check\}/);
    assert.match(go, /--apply\) \[ \"\$MIG_REVIEWED\" = \"1\" \]/);
    assert.match(go, /compare-staging \$M\/before.json \$M\/stg.json/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
