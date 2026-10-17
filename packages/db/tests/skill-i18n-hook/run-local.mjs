/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only SKILL-I18N-HOOK verification: the per-module display translations column.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';

const file = readdirSync(`${root}/packages/db/migrations`).find(name => name.endsWith('_skill_i18n_hook.sql'));
assert.ok(file, 'migration file');
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: file, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(`packages/db/migrations/${file}`));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('reapplication after the full chain preserves the complete catalog');

  const column = (await c.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns"
    + " WHERE table_schema='public' AND table_name='modules' AND column_name='display_translations'")).rows[0];
  assert.deepEqual(column, { data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" });
  const moduleId = randomUUID();
  await c.query("INSERT INTO modules(id,title,active) VALUES($1,'模块',false)", [moduleId]);
  assert.deepEqual(await v('SELECT display_translations v FROM modules WHERE id=$1', [moduleId]), {});
  report.checks.push('existing and new modules start with no translations');

  const set = value => c.query('UPDATE modules SET display_translations=$2 WHERE id=$1', [moduleId, value]);
  await set({ en: { reportTitle: 'Positioning report', steps: { 'step-1': 'About you' } } });
  assert.equal(await v("SELECT display_translations->'en'->'steps'->>'step-1' v FROM modules WHERE id=$1", [moduleId]), 'About you');
  for (const bad of ['[]', '"text"', '1', 'null']) await code(c.query(`UPDATE modules SET display_translations='${bad}'::jsonb WHERE id=$1`,
    [moduleId]), '23514');
  await code(c.query('UPDATE modules SET display_translations=NULL WHERE id=$1', [moduleId]), '23502');
  await set({ en: { reportTitle: 'x'.repeat(2000000) } });
  await code(set({ en: { reportTitle: 'x'.repeat(2100000) } }), '23514');
  report.checks.push('allow: an object of translations; deny: non-objects, null and values over 2 MB');

  for (const role of ['anon', 'authenticated']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      assert.equal(await v("SELECT has_column_privilege($1,'public.modules','display_translations',$2) v", [role, p]), false, `${role} ${p}`);
    }
  }
  assert.equal(await v("SELECT has_column_privilege('service_role','public.modules','display_translations','UPDATE') v"), true);
  report.checks.push('clients cannot read or write the column; service_role can');

  // The published labels: artifact_workflows stays closed to service_role (0067); administrators use the function.
  assert.equal(await v("SELECT has_table_privilege('service_role','public.artifact_workflows','SELECT') v"), false);
  for (const role of ['anon', 'authenticated'])
    assert.equal(await v("SELECT has_function_privilege($1,'admin_skill_display_workflow(uuid,uuid)','execute') v", [role]), false);
  assert.equal(await v("SELECT has_function_privilege('service_role','admin_skill_display_workflow(uuid,uuid)','execute') v"), true);
  const person = async (role, status = 'active') => { const a = randomUUID();
    await c.query('INSERT INTO profiles(id,credits,role,status) VALUES($1,0,$2,$3)', [a, role, status]); return a; };
  const [admin, user, suspended] = [await person('admin'), await person('user'), await person('admin', 'suspended')];
  const display = (actor, module) => v('SELECT admin_skill_display_workflow($1,$2) v', [actor, module]);
  assert.equal(await display(admin, moduleId), null, 'unpublished module');
  const [skillId, revisionId] = [randomUUID(), randomUUID()];
  await c.query('SET session_replication_role=replica');
  try {
    await c.query("INSERT INTO skills(id,skill_key,draft_content) VALUES($1,$2,'')", [skillId, 'i18n-' + moduleId]);
    await c.query("INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)"
      + " VALUES($1,$2,$3,'{}',$4,$4,0,$5)", [revisionId, skillId, randomUUID(), 'a'.repeat(64), admin]);
  } finally { await c.query('SET session_replication_role=DEFAULT'); }
  const body = { steps: [{ id: 'step-1', title: '了解你' }], report: { title: '账号定位报告' } };
  const publish = (workflow, enabled) => c.query('INSERT INTO artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled)'
    + " VALUES($1,$2,$3,$4,$5,'模块',$6)", ['w-' + randomUUID(), moduleId, skillId, revisionId, workflow, enabled]);
  await publish({ old: true }, false);
  await publish(body, true);
  assert.deepEqual(await display(admin, moduleId), body);
  for (const actor of [user, suspended, randomUUID(), null]) await code(display(actor, moduleId), '42501');
  await code(display(admin, randomUUID()), 'P0001');
  report.checks.push('allow: an active administrator reads only the enabled workflow (NULL before publication);'
    + ' deny: ordinary users, suspended or unknown administrators, client roles, missing modules');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
