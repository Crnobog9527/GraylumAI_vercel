/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only VOICE-2 PR-5 verification (0546): importing the user's own past posts from the latest paid TikHub read of an own
// connected account. Checks grants, that only the owner's own connected connection is read, that the text comes from the stored
// read (not the caller), dedupe and re-import after a delete, space, the library switch, a wiped read, erasure coverage, and
// that the migration applies again unchanged.
// Run: node packages/db/tests/voice-import/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const file = readdirSync(new URL('../../migrations/', import.meta.url)).find(f => /^\d{4}_voice2_import_posts\.sql$/.test(f));
assert.ok(file, 'the import migration exists');
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: file, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const refusal = async promise => { try { await promise; } catch (e) { return e.message; } assert.fail('accepted'); };
const ROUTE = '/api/v1/douyin/app/v3/fetch_user_post_videos';
const routes = JSON.stringify({ douyin: ROUTE, xiaohongshu: '/xhs/posts' });
const profile = async () => { const id = randomUUID(); await c.query('INSERT INTO profiles(id,credits,status,is_deleted) VALUES($1,0,$2,false)', [id, 'active']); return id; };
// Fixture rows without their business chain (the import only reads connections and reads): FK checks off for the inserts only.
const raw = async (sql, args) => { await c.query("SET session_replication_role='replica'"); try { await c.query(sql, args); } finally { await c.query("SET session_replication_role='origin'"); } };
const connection = async (a, { role = 'own', status = 'connected', platform = 'douyin' } = {}) => {
  const id = randomUUID();
  await raw(`INSERT INTO social_connections(id,actor_id,business_id,account_project_id,role,source,platform,profile_ref,status)
    VALUES($1,$2,$3,$4,$5,'tikhub',$6,'ref',$7)`, [id, a, randomUUID(), role === 'benchmark' ? null : randomUUID(), role, platform, status]);
  return id;
};
const post = (id, title, extra = {}) => ({ url: `https://www.douyin.com/video/${id}`, fields: { id, title, publishedAt: '2026-11-01T10:00:00Z', ...extra }, missing: [] });
const readRow = async (a, cid, items, { route = ROUTE, state = 'answered', at = 'now()' } = {}) => {
  await raw(`INSERT INTO social_billed_reads(id,actor_id,connection_id,refresh_id,request_key,model,run_id,state,token,result,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${at})`, [randomUUID(), a, cid, randomUUID(), 'a'.repeat(64), 'tikhub:' + route, randomUUID(),
    state, randomUUID(), JSON.stringify({ vendor: 'tikhub', route, outcome: 'ok', items })]);
};
const svc = async (sql, args) => { await c.query('BEGIN'); try { await c.query('SET LOCAL ROLE service_role'); const r = await v(sql, args); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } };
const sources = a => svc('SELECT voice_import_sources($1,$2) v', [a, routes]);
const candidates = (a, cid) => svc('SELECT voice_import_candidates($1,$2,$3) v', [a, cid, routes]);
const importPosts = (a, cid, ids) => svc('SELECT library_import_posts($1,$2,$3,$4) v', [a, cid, routes, ids]);

try {
  await c.query("INSERT INTO system_settings(key,value) VALUES('library_upload_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'");
  // A free plan with library space (an empty database has none).
  if (!(await v("SELECT count(*)::int v FROM membership_plans WHERE level='free'"))) await c.query(`INSERT INTO membership_plans(name,level,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Free','free',false,false,50000000)`);
  else await c.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  for (const role of ['anon', 'authenticated']) for (const f of ['voice_import_sources(uuid,jsonb)', 'voice_import_candidates(uuid,uuid,jsonb)', 'library_import_posts(uuid,uuid,jsonb,text[])'])
    assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
  assert.equal(await v("SELECT has_table_privilege('service_role','public.library_document_imports','SELECT') v"), false);
  assert.equal(await v("SELECT relrowsecurity v FROM pg_class WHERE oid='public.library_document_imports'::regclass"), true);
  report.checks.push('service role only; the imports table is closed to every client role');

  const a = await profile(), b = await profile();
  const cid = await connection(a), other = await connection(b), benchmark = await connection(a, { role: 'benchmark' });
  const gone = await connection(a, { status: 'disconnected' });
  await readRow(a, cid, [post('p1', '老一点的帖子'), post('p2', '')], { at: "now()-interval '1 hour'" });
  await readRow(a, cid, [post('p1', '各位街坊，晚上好，我是楼下老周。'), post('p2', '今天去菜市场'), post('p3', '   '), post('', '没有编号')]);
  await readRow(a, cid, [post('x', '主页信息')], { route: '/profile' });
  await readRow(a, cid, [post('z', '没扣费完成的读取')], { state: 'abandoned' });
  await readRow(b, other, [post('b1', '别人的帖子')]);
  await readRow(a, benchmark, [post('k1', '对标账号的帖子')]);
  await readRow(a, gone, [post('g1', '断开的账号')]);

  const listed = await sources(a);
  assert.deepEqual(listed.map(s => [s.connectionId, s.posts]), [[cid, 2]], 'only the own connected connection; its latest posts read');
  const cand = await candidates(a, cid);
  assert.deepEqual(cand.posts.map(p => [p.postId, p.text, p.imported]), [['p1', '各位街坊，晚上好，我是楼下老周。', false], ['p2', '今天去菜市场', false]],
    'the latest answered posts read, posts with an id and some text');
  assert.deepEqual((await candidates(b, cid)).posts, [], 'another account reads nothing of it');
  assert.deepEqual((await candidates(a, benchmark)).posts, [], 'a benchmark connection is not the user\'s own writing');
  assert.deepEqual((await candidates(a, gone)).posts, [], 'a disconnected connection');
  report.checks.push('sources and candidates: only the owner\'s own connected connection, its latest answered posts read; others, benchmarks, disconnected: nothing');

  const result = await importPosts(a, cid, ['p1', 'p2', 'nope']);
  assert.deepEqual(result, { imported: 2, skipped: 1 });
  const docs = (await c.query(`SELECT d.id,d.status,d.kind,d.format,d.purpose,d.filename,d.original_bytes,d.text_bytes,s.body FROM library_documents d
    JOIN library_document_segments s ON s.document_id=d.id WHERE d.actor_id=$1 ORDER BY s.body`, [a])).rows;
  assert.equal(docs.length, 2);
  for (const d of docs) assert.deepEqual([d.status, d.kind, d.format, d.purpose, Number(d.original_bytes)], ['ready', 'document', 'txt', 'authored', 0]);
  assert.ok(docs.some(d => d.body === '各位街坊，晚上好，我是楼下老周。' && d.filename.startsWith('抖音 · 2026-11-01 · ')));
  assert.equal(Number(await v('SELECT library_usage($1)::bigint v', [a])), docs.reduce((s, d) => s + Number(d.text_bytes), 0), 'only the text counts');
  assert.deepEqual((await candidates(a, cid)).posts.map(p => p.imported), [true, true]);
  assert.deepEqual(await importPosts(a, cid, ['p1']), { imported: 0, skipped: 1 }, 'an imported post is not imported twice');
  report.checks.push('import: ready 「我本人写的」 txt documents with the stored text, no original, only text counted; marked imported; never twice');

  // The cleanup job never takes an import for an unfinished upload.
  assert.deepEqual(await svc('SELECT library_cleanup_candidates($1,10) v', [a]), []);
  const p1 = docs.find(d => d.body.startsWith('各位街坊')).id;
  await svc('SELECT library_delete($1,$2) v', [a, p1]);
  assert.deepEqual((await candidates(a, cid)).posts.map(p => [p.postId, p.imported]), [['p1', false], ['p2', true]]);
  assert.deepEqual(await importPosts(a, cid, ['p1']), { imported: 1, skipped: 0 }, 'a deleted import can be imported again');
  report.checks.push('deleting an imported document frees its post for a new import; the cleanup job sees no unfinished upload');

  assert.match(await refusal(importPosts(b, cid, ['p1'])), /VOICE_IMPORT_NOTHING/, 'another account cannot import from it');
  assert.match(await refusal(importPosts(a, cid, [])), /VOICE_INVALID/);
  assert.match(await refusal(importPosts(a, cid, Array.from({ length: 31 }, (_, i) => 'p' + i))), /VOICE_INVALID/);
  await c.query("UPDATE system_settings SET value='false' WHERE key='library_upload_enabled'");
  assert.match(await refusal(importPosts(a, cid, ['p2'])), /LIBRARY_DISABLED/);
  await c.query("UPDATE system_settings SET value='true' WHERE key='library_upload_enabled'");
  const big = 'x'.repeat(8000);
  await readRow(a, cid, [post('p9', big)]);
  const used = Number(await v('SELECT library_usage($1)::bigint v', [a]));
  await c.query("UPDATE membership_plans SET library_storage_bytes=$1 WHERE level='free'", [used + 4000]);
  assert.match(await refusal(importPosts(a, cid, ['p9'])), /LIBRARY_SPACE/, 'no room for 8,000 bytes: nothing written');
  assert.equal(Number(await v('SELECT library_usage($1)::bigint v', [a])), used);
  await c.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  assert.deepEqual(await importPosts(a, cid, ['p9']), { imported: 1, skipped: 0 });
  report.checks.push('refused: another account, no or too many posts, library switched off; space checked before writing');

  // Disconnecting wipes the stored read (existing trigger): nothing left to import.
  await raw('DELETE FROM social_connections WHERE id=$1', [cid]);
  assert.deepEqual(await sources(a), []);
  report.checks.push('a disconnected (deleted) connection leaves nothing to list or import');

  assert.ok(Number(await v('SELECT library_erasure_remaining($1)::bigint v', [a])) > 0);
  const counted = await v('SELECT count(*)::int v FROM library_document_imports WHERE actor_id=$1', [a]);
  assert.ok(counted > 0, 'imports are counted as remaining until the documents go');
  // As erasure's cleanup does in the end (with FK actions on, so the cascade runs).
  await c.query('DELETE FROM library_document_segments WHERE actor_id=$1', [a]);
  await c.query('DELETE FROM library_upload_reservations WHERE actor_id=$1', [a]);
  await c.query('DELETE FROM library_documents WHERE actor_id=$1', [a]);
  assert.equal(await v('SELECT count(*)::int v FROM library_document_imports WHERE actor_id=$1', [a]), 0, 'they go with their documents');
  const audit = (await c.query(read('packages/db/tests/erasure-coverage-audit.sql'))).rows;
  assert.deepEqual(audit, [], JSON.stringify(audit));
  report.checks.push('erasure: imports counted by library_erasure_remaining and deleted with their documents; coverage audit 0 rows');

  await c.query(read(`packages/db/migrations/${file}`));
  assert.equal(await v("SELECT has_function_privilege('authenticated','library_import_posts(uuid,uuid,jsonb,text[])','execute') v"), false);
  report.checks.push('the migration applies again unchanged');
  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
