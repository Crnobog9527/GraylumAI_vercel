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
  await code(set({ en: { reportTitle: 'x'.repeat(70000) } }), '23514');
  report.checks.push('allow: an object of translations; deny: non-objects, null and values over 64 KB');

  for (const role of ['anon', 'authenticated']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      assert.equal(await v("SELECT has_column_privilege($1,'public.modules','display_translations',$2) v", [role, p]), false, `${role} ${p}`);
    }
  }
  assert.equal(await v("SELECT has_column_privilege('service_role','public.modules','display_translations','UPDATE') v"), true);
  report.checks.push('clients cannot read or write the column; service_role can');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
