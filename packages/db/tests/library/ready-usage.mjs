/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// 0213: published documents count actual bytes; unfinished/deleted documents keep the full token holds.
export async function verifyReadyUsage(admin, one) {
  const c = randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1)', [c]);
  await admin.query("UPDATE system_settings SET value='true' WHERE key='library_upload_enabled'");
  await admin.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  const value = async (q, args) => (await one.query(q, args)).rows[0].v;
  const usage = async () => Number((await admin.query('SELECT library_usage($1) v', [c])).rows[0].v);
  const begin = (f) => value(`SELECT library_upload_begin($1,$2,'small.${f}',$3,'reference',3000) v`, [c, randomUUID(), f]);
  const pdf = async () => {
    const did = (await begin('pdf')).documentId;
    await one.query('SELECT library_pdf_text_begin($1,$2,3000)', [c, did]);
    await one.query('SELECT library_pdf_publish($1,$2,3000,7,$3,$4)', [c, did,
      JSON.stringify([{ title: '', body: 'hello', page_number: 1 }]),
      JSON.stringify(['text', 'scanned', 'blank'].map((status, i) => ({ page_number: i + 1, status })))]);
    return did;
  };
  const word = async () => {
    const did = (await begin('docx')).documentId;
    await one.query('SELECT library_word_text_begin($1,$2,3000)', [c, did]);
    await one.query('SELECT library_word_publish($1,$2,3000,5,$3)', [c, did, JSON.stringify([{ title: '', body: 'hello' }])]);
    return did;
  };
  // Original 3000 + text object 7 (form feeds included) + segments 5; Word text object equals its segments.
  const first = await pdf();
  assert.equal(await usage(), 3012, 'a published PDF counts actual bytes during the token guard');
  const second = await word();
  assert.equal(await usage(), 3012 + 3010);
  // Before 0213 this third 20 MB admission failed: two small files already held 40 MB of 50 MB.
  const third = await pdf();
  assert.equal(await usage(), 3012 * 2 + 3010);
  assert.equal((await value('SELECT library_list($1) v', [c])).usedBytes, 3012 * 2 + 3010);
  const holds = (await admin.query('SELECT original_hold,text_hold FROM library_upload_reservations WHERE document_id=ANY($1)',
    [[first, second, third]])).rows;
  assert.ok(holds.every(h => h.original_hold === '10000000' && h.text_hold === '10000000'), 'token holds are retained');
  // An unfinished document still counts both writable paths.
  const pending = (await begin('pdf')).documentId;
  assert.equal(await usage(), 3012 * 2 + 3010 + 20000000);
  await one.query('SELECT library_delete($1,$2)', [c, pending]);
  assert.equal(await usage(), 3012 * 2 + 3010 + 20000000, 'deleted unfinished document keeps its holds');
  // Deleting during the guard: removed paths can be recreated by a live token, so full holds return.
  await one.query('SELECT library_delete($1,$2)', [c, first]);
  assert.equal(await usage(), 3012 + 3010 + 40000000);
  // After the guard, cleanup shrinks holds to actual bytes; a later delete counts only those.
  await admin.query(`UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 minute',
    text_guard_until=now()-interval '1 minute' WHERE document_id=$1`, [third]);
  await one.query('SELECT library_cleanup_observe($1,$2,false)', [c, third]);
  assert.deepEqual((await admin.query('SELECT original_hold,text_hold FROM library_upload_reservations WHERE document_id=$1',
    [third])).rows[0], { original_hold: '3000', text_hold: '7' });
  assert.equal(await usage(), 3012 + 3010 + 40000000);
  await one.query('SELECT library_delete($1,$2)', [c, third]);
  assert.equal(await usage(), 3007 + 3010 + 40000000, 'expired-guard delete keeps only actual object holds');
  // Capacity still blocks a new 20 MB admission when actual usage leaves too little room.
  await admin.query("UPDATE membership_plans SET library_storage_bytes=60000000 WHERE level='free'");
  await assert.rejects(begin('pdf'), /LIBRARY_SPACE/);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  console.log('PASS: ready documents count actual bytes; unfinished/deleted documents keep live-token holds');
}
