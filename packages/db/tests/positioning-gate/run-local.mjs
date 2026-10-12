/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only POSITIONING-GATE PR1 verification: Skill flag column and the confirmed-positioning check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0219_positioning_gate.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0219', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const profile = async () => { const a = randomUUID(); await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]); return a; };
const has = a => v('SELECT opc_has_confirmed_positioning($1) v', [a]);
// Fixture only: a published version and its project, stand-ins for the real publish path
// (artifact_transition, 0117, unchanged here). Foreign keys are skipped for these inserts.
const published = async (actor, { versionErased = false, projectErased = false } = {}) => {
  const [project, version] = [randomUUID(), randomUUID()];
  await c.query('SET session_replication_role=replica');
  try {
    await c.query('INSERT INTO artifact_projects(id,actor_id,module_id,skill_id) VALUES($1,$2,$3,$4)',
      [project, actor, randomUUID(), randomUUID()]);
    await c.query("INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)"
      + " VALUES($1,$2,$3,1,'{}','h','[]')", [version, project, randomUUID()]);
  } finally { await c.query('SET session_replication_role=DEFAULT'); }
  // Same column changes as selective content erasure (0201).
  if (versionErased) await c.query('UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=now() WHERE id=$1', [version]);
  if (projectErased) await c.query("UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=now() WHERE id=$1", [project]);
  return version;
};
const business = async (actor, { version = null, erased = false } = {}) => {
  await c.query('SET session_replication_role=replica');
  try {
    await c.query('INSERT INTO opc_businesses(actor_id,name,current_source_version_id,erased_at) VALUES($1,$2,$3,$4)',
      [actor, erased ? null : '测试业务', version, erased ? new Date() : null]);
  } finally { await c.query('SET session_replication_role=DEFAULT'); }
};
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0219 reapplication after the full chain preserves the complete catalog');

  const column = (await c.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns"
    + " WHERE table_schema='public' AND table_name='modules' AND column_name='social_media_related'")).rows[0];
  assert.deepEqual(column, { data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
  const moduleId = randomUUID();
  await c.query("INSERT INTO modules(id,title,active) VALUES($1,'未勾选的模块',false)", [moduleId]);
  assert.equal(await v('SELECT social_media_related v FROM modules WHERE id=$1', [moduleId]), false);
  report.checks.push('existing and new modules default to not social-media related');

  for (const role of ['anon', 'authenticated']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      assert.equal(await v("SELECT has_column_privilege($1,'public.modules','social_media_related',$2) v", [role, p]), false, `${role} ${p}`);
    }
    assert.equal(await v("SELECT has_function_privilege($1,'opc_has_confirmed_positioning(uuid)','execute') v", [role]), false);
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','opc_has_confirmed_positioning(uuid)','execute') v"), true);
  assert.equal(await v("SELECT has_column_privilege('service_role','public.modules','social_media_related','UPDATE') v"), true);
  report.checks.push('clients cannot read or write the flag or call the check; service_role can');

  const [none, draftOnly, confirmed, erasedOnly, mixed] = [await profile(), await profile(), await profile(), await profile(), await profile()];
  const [versionGone, projectGone, foreign] = [await profile(), await profile(), await profile()];
  await business(draftOnly);
  await business(confirmed, { version: await published(confirmed) });
  await business(erasedOnly, { version: await published(erasedOnly), erased: true });
  await business(mixed); await business(mixed, { version: await published(mixed), erased: true });
  await business(mixed, { version: await published(mixed, { versionErased: true }) });
  await business(mixed, { version: await published(mixed) });
  await business(versionGone, { version: await published(versionGone, { versionErased: true }) });
  await business(projectGone, { version: await published(projectGone, { projectErased: true }) });
  // A pointer to someone else's live version never counts.
  await business(foreign, { version: await published(confirmed) });
  assert.equal(await has(none), false, 'no business');
  assert.equal(await has(draftOnly), false, 'unpublished draft business');
  assert.equal(await has(erasedOnly), false, 'erased confirmed business');
  assert.equal(await has(versionGone), false, 'published version deleted by selective content erasure');
  assert.equal(await has(projectGone), false, 'positioning project deleted by selective content erasure');
  assert.equal(await has(foreign), false, 'version owned by another actor');
  assert.equal(await has(confirmed), true, 'one confirmed business');
  assert.equal(await has(mixed), true, 'any one confirmed business among several');
  assert.equal(await has(null), false);
  report.checks.push('deny: none, draft only, erased business, erased version, erased project, foreign version;'
    + ' allow: any one confirmed live business');

  assert.equal(await has(randomUUID()), false, 'another actor never sees these rows');
  report.checks.push('another actor never sees these rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
