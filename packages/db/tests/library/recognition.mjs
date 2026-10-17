/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2d (0287): saving browser-recognised text of scanned PDF pages and Word images (switch, ownership, version,
// order, quota, races, Word anchors, roles).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyRecognition(admin, one, two) {
  const a = randomUUID(), b = randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1),($2)', [a, b]);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=100000000 WHERE level='free'");
  const value = async (c, q, args = []) => (await c.query(q, args)).rows[0].v;
  // A 4-page PDF: text, scanned, text, scanned.
  const pdf = async (actor) => {
    const did = (await value(one, "SELECT library_upload_begin($1,$2,'scan.pdf','pdf','reference',5) v", [actor, randomUUID()])).documentId;
    await one.query('SELECT library_pdf_text_begin($1,$2,5)', [actor, did]);
    const segments = [{ title: '第 1 页', body: 'one', page_number: 1 }, { title: '第 3 页', body: 'three', page_number: 3 }];
    const pages = ['text', 'scanned', 'text', 'scanned'].map((status, i) => ({ page_number: i + 1, status }));
    await one.query('SELECT library_pdf_publish($1,$2,5,$3,$4,$5)', [actor, did, 8 + 3, JSON.stringify(segments), JSON.stringify(pages)]);
    return did;
  };
  const did = await pdf(a);
  const save = (c, pos, ver, segments, actor = a, doc = did, kind = 'pdf_page') => value(c,
    'SELECT library_recognition_save($1,$2,$3,$4,$5,$6) v', [actor, doc, kind, pos, ver, JSON.stringify(segments)]);
  const page = (n, body) => [{ title: `第 ${n} 页`, body }];
  const rows = async () => (await admin.query(`SELECT ordinal,page_number,source,body FROM library_document_segments
    WHERE document_id=$1 ORDER BY ordinal`, [did])).rows;

  // Off by default: nothing can be saved, the state still reads.
  await assert.rejects(save(one, 2, 1, page(2, 'x')), /LIBRARY_DISABLED/);
  assert.deepEqual(await value(one, 'SELECT library_recognition_pending($1) v', [a]), [], 'nothing to do while off');
  await admin.query(`INSERT INTO system_settings(key,value) VALUES('library_scan_recognition_enabled','true')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  assert.deepEqual(await value(one, 'SELECT library_recognition_pending($1) v', [a]),
    [{ documentId: did, format: 'pdf', contentVersion: 1, positions: [2, 4] }]);
  assert.deepEqual(await value(one, 'SELECT library_recognition_pending($1) v', [b]), []);

  // Ownership, version, page and segment checks.
  await assert.rejects(save(one, 2, 1, page(2, 'x'), b), /LIBRARY_NOT_FOUND/);
  await assert.rejects(save(one, 2, 1, page(2, 'x'), a, did, 'word_image'), /LIBRARY_TYPE/);
  await assert.rejects(save(one, 2, 7, page(2, 'x')), /LIBRARY_VERSION_CHANGED/);
  await assert.rejects(save(one, 9, 1, page(9, 'x')), /LIBRARY_NOT_FOUND/);
  await assert.rejects(save(one, 2, 1, page(2, 'a\fb')), /LIBRARY_INVALID/);
  await assert.rejects(save(one, 2, 1, []), /LIBRARY_INVALID/);
  await assert.rejects(save(one, 2, 1, Array(201).fill(page(2, 'x')[0])), /LIBRARY_INVALID/);
  assert.equal((await rows()).length, 2, 'refusals change nothing');

  // A completed text page is never overwritten.
  assert.deepEqual(await save(one, 1, 1, page(1, 'x')), { saved: false, status: 'complete', contentVersion: 1 });

  // Page 4 then page 2: segments stay in page order with contiguous ordinals; version and space move each time.
  const usage = async () => Number(await value(admin, 'SELECT library_usage($1) v', [a]));
  const before = await usage();
  assert.deepEqual(await save(one, 4, 1, page(4, 'four')), { saved: true, status: 'complete', contentVersion: 2 });
  assert.deepEqual(await save(one, 2, 2, [...page(2, 'two-a'), ...page(2, 'two-b')]), { saved: true, status: 'complete', contentVersion: 3 });
  assert.deepEqual((await rows()).map((r) => [r.ordinal, r.page_number, r.source, r.body]), [
    [0, 1, 'extracted', 'one'], [1, 2, 'recognized', 'two-a'], [2, 2, 'recognized', 'two-b'],
    [3, 3, 'extracted', 'three'], [4, 4, 'recognized', 'four']]);
  assert.equal(await usage(), before + 4 + 5 + 5, 'recognised text counts toward space');
  assert.equal((await value(one, 'SELECT library_segments_range($1,$2,3,0,50) v', [a, did])).length, 5);
  await assert.rejects(one.query('SELECT library_segments_range($1,$2,1,0,50)', [a, did]), /LIBRARY_VERSION_CHANGED/);
  // Saving the same page again (refresh, retry) changes nothing.
  assert.deepEqual(await save(one, 2, 3, page(2, 'again')), { saved: false, status: 'complete', contentVersion: 3 });
  assert.equal((await rows()).length, 5);
  assert.deepEqual(await value(one, 'SELECT library_recognition_pending($1) v', [a]), [], 'no page left waiting');

  // Two tabs racing on one page: the actor lock serialises them and exactly one save lands.
  const race = await pdf(a);
  await admin.query('BEGIN');
  await admin.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [a]);
  const both = [save(one, 2, 1, page(2, 'tab one'), a, race), save(two, 2, 1, page(2, 'tab two'), a, race)];
  for (let i = 0; i < 500; i++) {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const waiting = await value(admin, "SELECT count(*)::int v FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT library_recognition_save%'");
    if (waiting === 2) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await admin.query('COMMIT');
  const settled = await Promise.all(both);
  assert.equal(settled.filter((r) => r.saved).length, 1);
  assert.deepEqual(settled.find((r) => !r.saved), { saved: false, status: 'complete', contentVersion: 2 });
  assert.equal(await value(admin, "SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1 AND source='recognized'", [race]), 1);

  // Not enough space pauses the page and stores nothing; with space again the paused page saves.
  const used = await usage();
  await admin.query("UPDATE membership_plans SET library_storage_bytes=$1 WHERE level='free'", [used + 3]);
  assert.deepEqual(await save(one, 4, 2, page(4, 'longer'), a, race), { saved: false, status: 'paused', contentVersion: 2, code: 'LIBRARY_SPACE' });
  assert.equal(await value(admin, "SELECT status v FROM library_recognition_units WHERE document_id=$1 AND position=4", [race]), 'paused');
  // Another tab that could not read it does not turn a paused page into a failed one; it resumes when space frees.
  assert.deepEqual(await value(one, "SELECT library_recognition_fail($1,$2,'pdf_page',4) v", [a, race]), { status: 'paused' });
  assert.equal(await usage(), used);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=100000000 WHERE level='free'");
  assert.equal((await save(one, 4, 2, page(4, 'longer'), a, race)).saved, true);

  // A unit that would push the document past the 10 MB segment limit is marked failed, not retried forever.
  const full = await pdf(a);
  await admin.query('UPDATE library_upload_reservations SET segment_hold=9999998 WHERE document_id=$1', [full]);
  assert.deepEqual(await save(one, 2, 1, page(2, 'abc'), a, full), { saved: false, status: 'failed', contentVersion: 1, code: 'LIBRARY_TEXT_LIMIT' });
  assert.deepEqual(await save(one, 2, 1, page(2, 'abc'), a, full), { saved: false, status: 'failed', contentVersion: 1, code: 'LIBRARY_TEXT_LIMIT' });
  assert.equal(await value(admin, "SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1 AND source='recognized'", [full]), 0);

  // A page the browser could not read is marked failed and completed pages stay complete; another tab that did
  // read it can still save its text afterwards, and a save cannot be undone by a later failure.
  const failing = await pdf(a);
  assert.deepEqual(await value(one, "SELECT library_recognition_fail($1,$2,'pdf_page',2) v", [a, failing]), { status: 'failed' });
  assert.deepEqual(await value(one, "SELECT library_recognition_fail($1,$2,'pdf_page',1) v", [a, failing]), { status: 'complete' });
  assert.deepEqual(await save(one, 2, 1, page(2, 'late'), a, failing), { saved: true, status: 'complete', contentVersion: 2 });
  assert.deepEqual(await value(one, "SELECT library_recognition_fail($1,$2,'pdf_page',2) v", [a, failing]), { status: 'complete' });
  assert.equal(await value(admin, "SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1 AND source='recognized' AND body='late'", [failing]), 1);

  // Deleted documents and non-PDF documents are refused.
  await one.query('SELECT library_delete($1,$2)', [a, failing]);
  await assert.rejects(save(one, 4, 1, page(4, 'x'), a, failing), /LIBRARY_NOT_FOUND/);
  const txt = (await value(one, "SELECT library_upload_begin($1,$2,'a.txt','txt','reference',3) v", [a, randomUUID()])).documentId;
  await one.query(`SELECT library_publish($1,$2,3,'[{"title":"","body":"abc"}]')`, [a, txt]);
  await assert.rejects(save(one, 1, 1, page(1, 'x'), a, txt), /LIBRARY_TYPE/);

  // Word: units from image anchors at publish; recognised text goes before the anchored extracted segment.
  const word = async (images) => {
    const doc = (await value(one, "SELECT library_upload_begin($1,$2,'a.docx','docx','reference',5) v", [a, randomUUID()])).documentId;
    await one.query('SELECT library_word_text_begin($1,$2,5)', [a, doc]);
    const segments = [{ title: '', body: 'A' }, { title: '', body: 'B' }, { title: '', body: 'C' }];
    await one.query('SELECT library_word_publish($1,$2,5,3,$3,$4)', [a, doc, JSON.stringify(segments), JSON.stringify(images)]);
    return doc;
  };
  await assert.rejects(word([{ anchor: 2 }, { anchor: 1 }]), /LIBRARY_INVALID/, 'anchors must not go backwards');
  await assert.rejects(word([{ anchor: 4 }]), /LIBRARY_INVALID/, 'anchor beyond the last segment');
  const docx = await word([{ anchor: 1 }, { anchor: 1 }, { anchor: 3 }, ...Array(50).fill({ anchor: 3 })]);
  const units = (await admin.query('SELECT position,status,anchor FROM library_recognition_units WHERE document_id=$1 ORDER BY position', [docx])).rows;
  assert.equal(units.length, 53);
  assert.deepEqual(units.slice(0, 3), [{ position: 1, status: 'pending', anchor: 1 }, { position: 2, status: 'pending', anchor: 1 },
    { position: 3, status: 'pending', anchor: 3 }]);
  assert.equal(units.filter((u) => u.status === 'over_limit').length, 3);
  await assert.rejects(save(one, 1, 1, page(1, 'x'), a, docx, 'pdf_page'), /LIBRARY_TYPE/);
  const wordSave = (pos, ver, body) => save(one, pos, ver, [{ title: `图片 ${pos}（识别）`, body }], a, docx, 'word_image');
  assert.equal((await wordSave(3, 1, 'img3')).saved, true);
  assert.equal((await wordSave(2, 2, 'img2')).saved, true);
  assert.equal((await wordSave(1, 3, 'img1')).saved, true);
  const order = (await admin.query('SELECT body,source,page_number FROM library_document_segments WHERE document_id=$1 ORDER BY ordinal', [docx])).rows;
  assert.deepEqual(order.map((r) => r.body), ['A', 'img1', 'img2', 'B', 'C', 'img3'], 'shared anchor keeps image order');
  assert.ok(order.filter((r) => r.source === 'recognized').every((r) => r.page_number === null));
  // A Word file that is only images: empty text, no segments, one unit per image.
  const pictures = (await value(one, "SELECT library_upload_begin($1,$2,'p.docx','docx','reference',5) v", [a, randomUUID()])).documentId;
  await one.query('SELECT library_word_text_begin($1,$2,5)', [a, pictures]);
  await assert.rejects(one.query(`SELECT library_word_publish($1,$2,5,3,'[]','[{"anchor":0}]')`, [a, pictures]), /LIBRARY_INVALID/);
  // With recognition off it would become a ready document with nothing to read, so it is refused.
  await admin.query("UPDATE system_settings SET value='false' WHERE key='library_scan_recognition_enabled'");
  await assert.rejects(one.query(`SELECT library_word_publish($1,$2,5,0,'[]','[{"anchor":0}]')`, [a, pictures]), /LIBRARY_NO_TEXT/);
  await admin.query("UPDATE system_settings SET value='true' WHERE key='library_scan_recognition_enabled'");
  assert.equal((await value(one, `SELECT library_word_publish($1,$2,5,0,'[]','[{"anchor":0},{"anchor":0}]') v`, [a, pictures])).status, 'ready');
  assert.equal(await value(admin, "SELECT count(*)::int v FROM library_recognition_units WHERE document_id=$1 AND status='pending'", [pictures]), 2);
  assert.equal((await save(one, 2, 1, [{ title: '图片 2（识别）', body: 'second' }], a, pictures, 'word_image')).saved, true);
  assert.equal((await save(one, 1, 2, [{ title: '图片 1（识别）', body: 'first' }], a, pictures, 'word_image')).saved, true);
  assert.deepEqual((await admin.query('SELECT body FROM library_document_segments WHERE document_id=$1 ORDER BY ordinal', [pictures])).rows
    .map((r) => r.body), ['first', 'second']);

  // The original five-argument publisher still works and creates no image units.
  const plain = (await value(one, "SELECT library_upload_begin($1,$2,'b.docx','docx','reference',5) v", [a, randomUUID()])).documentId;
  await one.query('SELECT library_word_text_begin($1,$2,5)', [a, plain]);
  await one.query(`SELECT library_word_publish($1,$2,5,1,'[{"title":"","body":"x"}]')`, [a, plain]);
  assert.equal(await value(admin, 'SELECT count(*)::int v FROM library_recognition_units WHERE document_id=$1', [plain]), 0);

  for (const role of ['anon', 'authenticated']) {
    await admin.query('SET ROLE ' + role);
    await assert.rejects(admin.query('SELECT public.library_recognition_pending($1)', [a]), /permission denied/);
    for (const call of ["library_recognition_save($1,$2,'pdf_page',1,1,'[]')", "library_recognition_fail($1,$2,'pdf_page',1)",
      "library_word_publish($1,$2,5,1,'[]','[]')"]) {
      await assert.rejects(admin.query(`SELECT public.${call}`, [a, did]), /permission denied/, `${role} ${call}`);
    }
    await admin.query('RESET ROLE');
  }
  await admin.query("DELETE FROM system_settings WHERE key='library_scan_recognition_enabled'");
  console.log('PASS: recognition switch, ownership, version, page order, space pause, two-tab race, failed pages, Word anchors, deletion, denied roles');
}
