import { expect, test } from '@playwright/test';

import { db, expectNothingFrozen, lastTurnId, ledger, replies, resetSim, seed, signIn, startFreeChat, turns, watchPage } from './support';

/**
 * PUBLISH-MONITOR B2: a free chat message with one screenshot. The browser makes it a JPEG, the model gets it with that message, the
 * turn is charged as any turn, and the image is kept nowhere (Owner 10-27 "截图不长期保留"): the conversation shows "[截图]" and the text.
 */
test.beforeEach(resetSim);

// A 1 x 1 PNG: the browser turns it into the JPEG it sends.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('chat image: a screenshot goes with one message, the reply comes back, one charged turn, nothing of the image kept', async ({ page }) => {
  const alice = seed().users.alice;
  const evidence = watchPage(page);
  await signIn(page, 'alice');
  const session = await startFreeChat(page, '先说一句：我想请你看后台数据。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('after the first reply'); throw error; });
  await expectNothingFrozen(alice.id);
  const before = (await ledger(alice.id)).credits;
  const mark = await lastTurnId(alice.id);

  let sentImage = '';
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/turn')) {
      const body = JSON.parse(request.postData() ?? '{}') as { image?: string };
      if (body.image) sentImage = body.image;
    }
  });
  await page.getByLabel('选择截图').setInputFiles({ name: 'backoffice.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('已附截图', { exact: false })).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).click();
  await page.keyboard.insertText('这是作品后台截图，帮我看看完播率。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(replies(page).nth(1)).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('after the image reply'); throw error; });
  await expect(page.getByText('已附截图', { exact: false })).toHaveCount(0);
  await expectNothingFrozen(alice.id);

  expect(sentImage.startsWith('data:image/jpeg;base64,'), 'the browser sent one JPEG').toBe(true);
  const opened = await turns(alice.id, mark);
  expect(opened.map(t => t.kind)).toEqual(['chat']);
  expect(opened[0]).toMatchObject({ session_id: session, close_kind: 'completed', settlement: 'done' });
  expect(opened[0]!.charged).toBeGreaterThan(0);
  expect((await ledger(alice.id)).credits).toBe(before - opened[0]!.charged!);
  await expect(page.getByText('[截图] 这是作品后台截图，帮我看看完播率。')).toBeVisible();

  // Nothing of the image anywhere in the database: no table's text holds a piece of its base64.
  const payload = sentImage.slice('data:image/jpeg;base64,'.length);
  const piece = payload.slice(Math.floor(payload.length / 2) - 24, Math.floor(payload.length / 2) + 24);
  expect(piece.length).toBe(48);
  const sql = db();
  const tables = await sql<{ t: string }[]>`select quote_ident(table_schema)||'.'||quote_ident(table_name) t from information_schema.tables
    where table_schema in ('public','storage','auth') and table_type='BASE TABLE'`;
  const found: string[] = [];
  for (const { t } of tables)
    if ((await sql.unsafe(`select count(*)::int n from ${t} x where strpos(x::text, $1) > 0`, [piece]))[0]!.n) found.push(t);
  expect(found, 'tables holding a piece of the screenshot').toEqual([]);
});
