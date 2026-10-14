/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// 0244: library_search finds only the caller's own ready text documents by a literal file-name match.
export async function verifySearch(admin, one) {
  const mine = randomUUID(), other = randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1),($2)', [mine, other]);
  // A ready text document normally has extracted segments; `text: false` models an all-scanned or blank PDF.
  const add = async (actor, filename, status = 'ready', minutesAgo = 0, kind = 'document', text = true) => {
    const id = (await admin.query(
      `INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename,status,created_at)
       VALUES($1,$2,$6,CASE WHEN $6='image' THEN 'png' ELSE 'md' END,'reference',$3,$4,
        clock_timestamp()-make_interval(mins=>$5)) RETURNING id`,
      [actor, randomUUID(), filename, status, minutesAgo, kind])).rows[0].id;
    if (text && kind === 'document') await admin.query(`INSERT INTO library_document_segments(document_id,actor_id,ordinal,body,source)
      VALUES($1,$2,0,'text','extracted')`, [id, actor]);
    return id;
  };
  const search = async (q, actor = mine, cursor = null) => (await one.query(
    'SELECT library_search($1,$2,$3,$4) v', [actor, q, cursor?.createdAt ?? null, cursor?.id ?? null])).rows[0].v;
  const names = r => r.documents.map(d => d.filename);

  await add(mine, '周报 第1周.md', 'ready', 3);
  await add(mine, 'Weekly 周报.MD', 'ready', 2);
  await add(mine, '周报草稿.md', 'deleting', 1);
  await add(mine, '周报 处理中.md', 'processing', 1);
  await add(mine, '周报 失败.md', 'failed', 1);
  await add(mine, '周报 上传中.md', 'uploading', 1);
  await add(mine, '周报截图.png', 'ready', 1, 'image');
  await add(mine, '周报 扫描件.pdf', 'ready', 1, 'document', false);
  await add(mine, '100%_完成\\清单.md', 'ready', 4);
  await add(mine, '100 完成 清单.md', 'ready', 5);
  await add(other, '周报 别人的.md', 'ready', 0);

  // Own ready text documents with readable segments only, newest first, case-insensitive; images, unfinished,
  // failed or deleting documents and all-scanned PDFs are never offered, since a chosen reference must be readable.
  assert.deepEqual(names(await search('周报')), ['Weekly 周报.MD', '周报 第1周.md']);
  assert.deepEqual(names(await search('weekly')), ['Weekly 周报.MD']);
  assert.deepEqual(names(await search('周报', other)), ['周报 别人的.md']);
  // %, _ and \ match themselves only; they never widen the match.
  assert.deepEqual(names(await search('%')), ['100%_完成\\清单.md']);
  assert.deepEqual(names(await search('_')), ['100%_完成\\清单.md']);
  assert.deepEqual(names(await search('\\')), ['100%_完成\\清单.md']);
  assert.deepEqual(names(await search('100%_')), ['100%_完成\\清单.md']);
  assert.deepEqual(names(await search('不存在的名字')), []);
  // Term length 1–100 after trimming; a cursor needs both parts.
  for (const bad of ['', '   ', 'x'.repeat(101)]) await assert.rejects(search(bad), /LIBRARY_INVALID/);
  await assert.rejects(one.query('SELECT library_search($1,$2,now(),NULL)', [mine, '周报']), /LIBRARY_INVALID/);
  assert.equal((await search(`  ${'周'}  `)).documents.length, 2, 'surrounding spaces are trimmed');

  // 50 per page with the list's cursor; the second page continues without overlap.
  for (let i = 0; i < 55; i++) await add(mine, `批量 ${String(i).padStart(2, '0')}.md`, 'ready', 100 + i);
  const first = await search('批量');
  assert.equal(first.documents.length, 50);
  assert.ok(first.nextCursor);
  const second = await search('批量', mine, first.nextCursor);
  assert.equal(second.documents.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...names(first), ...names(second)]).size, 55);

  // Only service_role may call it; the table itself stays closed to it.
  const grants = (await admin.query(`SELECT grantee FROM information_schema.routine_privileges
    WHERE routine_schema='public' AND routine_name='library_search' ORDER BY grantee`)).rows.map(r => r.grantee);
  assert.ok(grants.includes('service_role'));
  for (const role of ['anon', 'authenticated', 'PUBLIC']) assert.ok(!grants.includes(role), role + ' must not execute');
}
