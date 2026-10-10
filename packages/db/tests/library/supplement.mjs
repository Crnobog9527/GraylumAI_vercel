/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifySupplement(admin, one, two) {
  const a = randomUUID(), b = randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1),($2)', [a, b]);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  const value = async (client, sql, args = []) => (await client.query(sql, args)).rows[0].v;
  const list = (cursor) => value(one, 'SELECT library_list_page($1,$2,$3) v', [a, cursor?.createdAt ?? null, cursor?.id ?? null]);
  await admin.query("UPDATE system_settings SET value='false' WHERE key='library_upload_enabled'");
  assert.equal((await value(one, 'SELECT library_list($1) v', [a])).uploadEnabled, false);
  assert.equal(await value(admin, 'SELECT library_usage($1) v', [a]), '0');
  await admin.query("UPDATE system_settings SET value='true' WHERE key='library_upload_enabled'");
  assert.equal((await list()).uploadEnabled, true);
  // Ties, sub-millisecond precision and deliberately unordered random IDs.
  const seeded = (await admin.query(`INSERT INTO library_documents(actor_id,request_id,kind,status,filename,created_at)
    SELECT $1,gen_random_uuid(),'document','ready','file-'||n,
      '2026-10-01T00:00:00Z'::timestamptz + ((n/3)::text||' microseconds')::interval
    FROM generate_series(1,123) n RETURNING id`, [a])).rows;
  const expected = (await admin.query('SELECT id FROM library_documents WHERE actor_id=$1 ORDER BY created_at DESC,id DESC', [a])).rows.map(r => r.id);
  const page1 = await list();
  assert.equal(page1.documents.length, 50);
  assert.deepEqual(page1.documents.map(r => r.id), expected.slice(0, 50));
  const compat = await value(one, 'SELECT library_list($1,$2) v', [a, page1.nextCursor.id]);
  assert.deepEqual(compat.documents.map(r => r.id), expected.slice(50, 100));
  // Delete the cursor row completely and insert a new newest row. Remaining pages must not move backwards.
  await admin.query('DELETE FROM library_documents WHERE id=$1', [page1.nextCursor.id]);
  await admin.query("INSERT INTO library_documents(actor_id,request_id,kind,status) VALUES($1,gen_random_uuid(),'image','ready')", [a]);
  const page2 = await list(page1.nextCursor), page3 = await list(page2.nextCursor);
  assert.deepEqual([...page1.documents, ...page2.documents, ...page3.documents].map(r => r.id), expected);
  assert.equal(page3.nextCursor, null);
  assert.equal(new Set(expected).size, seeded.length);
  await assert.rejects(one.query('SELECT library_list($1,$2)', [b, expected[0]]), /LIBRARY_INVALID_CURSOR/);
  await assert.rejects(one.query('SELECT library_list_page($1,null,$2)', [a, randomUUID()]), /LIBRARY_INVALID/);
  const foreign = await value(two, 'SELECT library_list_page($1,$2,$3) v', [b, page1.nextCursor.createdAt, page1.nextCursor.id]);
  assert.deepEqual(foreign.documents, []);

  const begin = (c, actor, request = randomUUID()) => value(c,
    "SELECT library_upload_begin($1,$2,'test.docx','docx','authored',1) v", [actor, request]);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=30000000 WHERE level='free'");
  // Two 20 MB admissions under an actual profile lock barrier cannot both consume a 30 MB allowance.
  await admin.query('BEGIN');
  await admin.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [b]);
  const admissions = [begin(one, b), begin(two, b)];
  const settled = Promise.allSettled(admissions);
  let blocked = false;
  for (let i = 0; i < 500; i++) {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const n = await value(admin, "SELECT count(*)::int v FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT library_upload_begin%'");
    if (n === 2) { blocked = true; break; }
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(blocked);
  await admin.query('COMMIT');
  const result = await settled;
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(result.find(r => r.status === 'rejected').reason.message, /LIBRARY_SPACE/);
  const grant = result.find(r => r.status === 'fulfilled').value;
  const did = grant.documentId;
  assert.equal(grant.textPath, `${b}/${did}/text`);
  assert.equal(await value(admin, 'SELECT library_usage($1) v', [b]), '20000000');
  const request = await value(admin, 'SELECT request_id v FROM library_documents WHERE id=$1', [did]);
  assert.equal((await begin(one, b, request)).dispatch, false);
  assert.deepEqual(await value(one, 'SELECT library_paths_claimed($1) v', [[grant.path, grant.textPath]]), [grant.path, grant.textPath]);
  const segments = Array.from({ length: 65 }, (_,i) => ({ title: `第${i}段`, body: `内容${i}\n` }));
  const bytes = segments.reduce((n, s) => n + Buffer.byteLength(s.body), 0);
  const publish = (actor = b, total = bytes) => value(one, 'SELECT library_word_publish($1,$2,4,$3,$4) v', [actor, did, total, JSON.stringify(segments)]);
  await assert.rejects(publish(a), /LIBRARY_NOT_FOUND/);
  await assert.rejects(publish(b, bytes - 1), /LIBRARY_INVALID/);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=20000000 WHERE level='free'");
  await assert.rejects(publish(), /LIBRARY_SPACE/);
  assert.equal(await value(admin, 'SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1', [did]), 0);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=30000000 WHERE level='free'");
  assert.equal((await publish()).status, 'ready');
  assert.equal((await publish()).status, 'ready');
  assert.equal(await value(admin, 'SELECT library_usage($1) v', [b]), String(20000000 + bytes));
  const directory = await value(one, 'SELECT library_directory($1,$2,1) v', [b,did]);
  assert.deepEqual(directory, segments.map((s,ordinal) => ({ ordinal, title: s.title })));
  const range = await value(one, 'SELECT library_segments_range($1,$2,1,49,16) v', [b,did]);
  assert.deepEqual(range.map(r => r.ordinal), Array.from({ length: 16 }, (_,i) => i+49));
  assert.deepEqual(await value(one, 'SELECT library_segments_range($1,$2,1,70,1) v', [b,did]), []);
  assert.equal((await value(one, 'SELECT library_segments($1,$2,1,2) v', [b,did])).length, 1);
  for (const call of ['library_directory($1,$2,2)', 'library_segments_range($1,$2,2,0,1)']) {
    await assert.rejects(one.query(`SELECT ${call}`, [b,did]), /LIBRARY_VERSION_CHANGED/);
  }
  for (const call of ['library_directory($1,$2,1)', 'library_segments_range($1,$2,1,0,1)']) {
    await assert.rejects(one.query(`SELECT ${call}`, [a,did]), /LIBRARY_NOT_FOUND/);
  }
  for (const [start,count] of [[-1,1],[0,0],[0,51],[10000,1],[null,1],[0,null]]) {
    await assert.rejects(one.query('SELECT library_segments_range($1,$2,1,$3,$4)', [b,did,start,count]), /LIBRARY_INVALID/);
  }
  await admin.query("UPDATE profiles SET status='disabled' WHERE id=$1", [b]);
  await assert.rejects(one.query('SELECT library_directory($1,$2,1)', [b,did]), /LIBRARY_ACCOUNT_CLOSED/);
  await admin.query("UPDATE profiles SET status='active' WHERE id=$1", [b]);
  // Even an actual-size original cannot hide an unreleased text hold from cleanup candidates.
  await admin.query(`UPDATE library_upload_reservations SET original_hold=4,
    original_guard_until=now()-interval '1 minute',text_guard_until=now()-interval '1 minute' WHERE document_id=$1`, [did]);
  const candidates = await value(one, 'SELECT library_cleanup_candidates($1) v', [b]);
  assert.ok(candidates.some(r => r.document_id === did));
  await one.query('SELECT library_cleanup_observe($1,$2,false)', [b,did]);
  assert.equal(await value(admin, 'SELECT library_usage($1) v', [b]), String(4 + bytes*2));
  await admin.query("UPDATE membership_plans SET library_storage_bytes=1 WHERE level='free'");
  assert.equal((await value(one, 'SELECT library_directory($1,$2,1) v', [b,did])).length, 65);
  await assert.rejects(begin(one,b), /LIBRARY_SPACE/);
  // Delete clears metadata/segments immediately; neither path is released with a live guard.
  await admin.query("UPDATE library_upload_reservations SET text_guard_until=now()+interval '1 minute' WHERE document_id=$1", [did]);
  await one.query('SELECT library_delete($1,$2)', [b,did]);
  await assert.rejects(one.query('SELECT library_directory($1,$2,1)', [b,did]), /LIBRARY_NOT_FOUND/);
  await assert.rejects(publish(), /LIBRARY_NOT_FOUND/);
  assert.equal(await value(one, 'SELECT library_cleanup_observe($1,$2,true) v', [b,did]), false);
  assert.equal(await value(admin, 'SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1', [did]), 0);
  await admin.query("UPDATE library_upload_reservations SET text_guard_until=now()-interval '1 minute' WHERE document_id=$1", [did]);
  await one.query('SELECT library_cleanup_observe($1,$2,true)', [b,did]);
  await one.query('SELECT library_cleanup_observe($1,$2,false)', [b,did]);
  await one.query('SELECT library_cleanup_observe($1,$2,true)', [b,did]);
  await new Promise(r => setTimeout(r, 1050));
  assert.equal(await value(one, 'SELECT library_cleanup_observe($1,$2,true) v', [b,did]), true);
  assert.equal(await value(admin, 'SELECT library_usage($1) v', [b]), '0');
  for (const role of ['anon', 'authenticated']) {
    await two.query(`SET ROLE ${role}`);
    for (const call of ['library_list_page($1)', 'library_directory($1,$2,1)',
      'library_segments_range($1,$2,1)', "library_word_publish($1,$2,4,1,'[]')"]) {
      await assert.rejects(two.query(`SELECT ${call}`, call.includes('$2') ? [a,did] : [a]), /permission denied/);
    }
  }
  await two.query('SET ROLE service_role');
  await admin.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  console.log('PASS: LIB-2a supplement: stable 123-row pagination, deleted cursor, upload flag, directory/range, Word quota barrier, dual holds, deletion, permissions');
}
