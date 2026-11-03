import { deflateSync } from 'node:zlib';

import { expect, test, type Page } from '@playwright/test';

import { db, expectNothingFrozen, lastTurnId, ledger, replies, resetSim, seed, signIn, startFreeChat, turns, watchPage } from './support';

/**
 * PUBLISH-MONITOR B2 (Owner 11-03: "和主流 Agent 一样"): screenshots join a free chat message from the composer's "+" menu, by dropping
 * them on the conversation, or by pasting into the box; each can be removed; several go with one message. The model gets them with
 * that message, the turn is charged as any turn, and no image is kept anywhere (Owner 10-27): the conversation shows "[截图×N]".
 */
test.beforeEach(resetSim);

/** A solid-colour RGB PNG of w x h (the browser makes it the JPEG it sends; the server needs 64 px on the short side). */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crc = (bytes: Buffer) => { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** Dispatches a paste (into the message box) or a drop (on the conversation) carrying one PNG file, as the browser would. */
async function deliver(page: Page, how: 'paste' | 'drop', name: string, bytes: Buffer) {
  await page.evaluate(({ how, name, base64 }) => {
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: 'image/png' }));
    if (how === 'paste') {
      const box = document.querySelector('[aria-label="消息"]') as HTMLElement;
      box.focus();
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    } else {
      const area = document.querySelector('[aria-label="对话记录"]') as HTMLElement;
      area.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      area.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }
  }, { how, name, base64: bytes.toString('base64') });
}

test('chat images: "+", paste and drop add screenshots, one is removed, two go with one message, one charged turn, none kept', async ({ page }) => {
  const alice = seed().users.alice;
  const evidence = watchPage(page);
  await signIn(page, 'alice');
  const session = await startFreeChat(page, '先说一句：我想请你看后台数据。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('after the first reply'); throw error; });
  await expectNothingFrozen(alice.id);
  const before = (await ledger(alice.id)).credits;
  const mark = await lastTurnId(alice.id);

  let sent: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/turn')) {
      const body = JSON.parse(request.postData() ?? '{}') as { images?: string[] };
      if (body.images) sent = body.images;
    }
  });
  const thumbs = page.getByRole('img', { name: /^已附图片 \d$/ });
  // 1. The "+" menu's file picker (the same input as other attachments).
  await page.getByRole('button', { name: '添加资料', exact: true }).click();
  await expect(page.getByText(/图片（截图、PNG、JPG、WebP，最多 4 张）/)).toBeVisible();
  await page.getByLabel('选择附件').setInputFiles({ name: 'plus.png', mimeType: 'image/png', buffer: png(320, 640, [200, 30, 30]) });
  await expect(thumbs).toHaveCount(1);
  // 2. Ctrl/⌘+V into the box.
  await deliver(page, 'paste', 'pasted.png', png(640, 320, [30, 200, 30]));
  await expect(thumbs).toHaveCount(2);
  // 3. Dropped on the conversation.
  await deliver(page, 'drop', 'dropped.png', png(400, 400, [30, 30, 200]));
  await expect(thumbs).toHaveCount(3);
  // Removing the second leaves the first and the third.
  await page.getByRole('button', { name: '移除图片 2' }).click();
  await expect(thumbs).toHaveCount(2);

  await page.getByRole('textbox', { name: '消息' }).click();
  await page.keyboard.insertText('这是两条作品的后台截图，帮我看看完播率。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(replies(page).nth(1)).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('after the image reply'); throw error; });
  await expect(thumbs).toHaveCount(0);
  await expectNothingFrozen(alice.id);

  expect(sent, 'two JPEGs went with the message').toHaveLength(2);
  for (const url of sent) expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
  const opened = await turns(alice.id, mark);
  expect(opened.map(t => t.kind)).toEqual(['chat']);
  expect(opened[0]).toMatchObject({ session_id: session, close_kind: 'completed', settlement: 'done' });
  expect(opened[0]!.charged).toBeGreaterThan(0);
  expect((await ledger(alice.id)).credits).toBe(before - opened[0]!.charged!);
  await expect(page.getByText('[截图×2] 这是两条作品的后台截图，帮我看看完播率。')).toBeVisible();

  // Nothing of either image anywhere in the database: no table's text holds a piece of its base64.
  const sql = db();
  const tables = await sql<{ t: string }[]>`select quote_ident(table_schema)||'.'||quote_ident(table_name) t from information_schema.tables
    where table_schema in ('public','storage','auth') and table_type='BASE TABLE'`;
  for (const url of sent) {
    const payload = url.slice('data:image/jpeg;base64,'.length), middle = Math.floor(payload.length / 2);
    const piece = payload.slice(middle - 24, middle + 24);
    expect(piece.length).toBe(48);
    const found: string[] = [];
    for (const { t } of tables)
      if ((await sql.unsafe(`select count(*)::int n from ${t} x where strpos(x::text, $1) > 0`, [piece]))[0]!.n) found.push(t);
    expect(found, 'tables holding a piece of a screenshot').toEqual([]);
  }
});
