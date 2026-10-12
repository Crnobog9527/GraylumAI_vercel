/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only POSITIONING-GATE PR1 verification: Skill flag column and the confirmed-positioning check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
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
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.message, expected);
const POSITIONING = { steps: [{ information: [{ id: 'a', profileKey: 'audience' }] }, { information: [{ id: 'b' }] }] };
const ORDINARY = { steps: [{ resources: ['SKILL.md'] }] };
// Module plus a stand-in Skill package (parents inserted without their own triggers/foreign keys);
// artifact_workflows rows themselves go through every trigger, including the 0219 guard.
const skillModule = async (flag = false) => {
  const [moduleId, skillId, revisionId, actor] = [randomUUID(), randomUUID(), randomUUID(), await profile()];
  await c.query("INSERT INTO modules(id,title,active,social_media_related) VALUES($1,'模块',false,$2)", [moduleId, flag]);
  await c.query('SET session_replication_role=replica');
  try {
    await c.query("INSERT INTO skills(id,skill_key,draft_content) VALUES($1,$2,'')", [skillId, 'module-' + moduleId]);
    await c.query("INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)"
      + " VALUES($1,$2,$3,'{}',$4,$4,0,$5)", [revisionId, skillId, randomUUID(), 'a'.repeat(64), actor]);
  } finally { await c.query('SET session_replication_role=DEFAULT'); }
  return { moduleId, skillId, revisionId };
};
const workflow = (m, body, enabled = true, client = c) => client.query('INSERT INTO artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled)'
  + " VALUES($1,$2,$3,$4,$5,'模块',$6)", ['w-' + randomUUID(), m.moduleId, m.skillId, m.revisionId, body, enabled]);
const flag = (m, value, client = c) => client.query('UPDATE modules SET social_media_related=$2 WHERE id=$1', [m.moduleId, value]);
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
    for (const f of ['opc_has_confirmed_positioning(uuid)', 'opc_is_positioning_workflow(jsonb)',
      'modules_social_media_guard()', 'artifact_workflows_social_media_guard()']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
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

  // The positioning Skill can never carry the flag, whichever side changes first.
  for (const [body, expected] of [[POSITIONING, true], [ORDINARY, false], [{ steps: [] }, false], [{}, false],
    [{ steps: [{ information: [{ profileKey: 'a' }] }, { information: [] }] }, false],
    [{ steps: [{ information: [{ profileKey: '' }] }] }, false], [{ steps: [{ information: [{ profileKey: 1 }] }] }, false],
    [{ steps: [null] }, false], [{ steps: 'x' }, false]]) {
    assert.equal(await v('SELECT opc_is_positioning_workflow($1) v', [body]), expected, JSON.stringify(body));
  }
  const plain = await skillModule(); await workflow(plain, ORDINARY);
  await flag(plain, true);
  assert.equal(await v('SELECT social_media_related v FROM modules WHERE id=$1', [plain.moduleId]), true);
  report.checks.push('allow: an ordinary Skill can be flagged');
  const positioning = await skillModule(); await workflow(positioning, POSITIONING);
  await code(flag(positioning, true), 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL');
  // A new module has no workflow yet, so it may be created flagged.
  await c.query("INSERT INTO modules(id,title,active,social_media_related) VALUES($1,'x',false,true)", [randomUUID()]);
  await code(workflow(plain, POSITIONING), 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL');
  await workflow(plain, POSITIONING, false);
  await code(c.query("UPDATE artifact_workflows SET enabled=true WHERE module_id=$1 AND workflow=$2", [plain.moduleId, POSITIONING]),
    'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL');
  await flag(plain, false);
  await workflow(plain, POSITIONING);
  report.checks.push('deny: flagging a positioning Skill, publishing or enabling a positioning workflow on a flagged module;'
    + ' allow: unflag first, then publish');

  // Concurrent publication and flag save serialize on the module row (publication locks it FOR UPDATE first).
  for (const publishFirst of [true, false]) {
    const m = await skillModule(); await workflow(m, ORDINARY);
    const [one, two] = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
    await one.connect(); await two.connect();
    try {
      await one.query('BEGIN'); await two.query('BEGIN');
      let blocked;
      if (publishFirst) {
        await one.query('SELECT id FROM modules WHERE id=$1 FOR UPDATE', [m.moduleId]);
        await workflow(m, POSITIONING, true, one);
        blocked = flag(m, true, two).then(() => null, e => e);
      } else {
        await flag(m, true, one);
        blocked = two.query('SELECT id FROM modules WHERE id=$1 FOR UPDATE', [m.moduleId])
          .then(() => workflow(m, POSITIONING, true, two)).then(() => null, e => e);
      }
      await new Promise(r => setTimeout(r, 300));
      await one.query('COMMIT');
      assert.equal((await blocked)?.message, 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL', publishFirst ? 'publish then flag' : 'flag then publish');
      await two.query('ROLLBACK');
    } finally { await one.end(); await two.end(); }
    assert.equal(await v("SELECT bool_and(NOT (m.social_media_related AND opc_is_positioning_workflow(w.workflow))) v"
      + ' FROM modules m JOIN artifact_workflows w ON w.module_id=m.id AND w.enabled WHERE m.id=$1', [m.moduleId]), true);
  }
  report.checks.push('concurrent publish and flag save in both orders never leave a flagged positioning Skill');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
