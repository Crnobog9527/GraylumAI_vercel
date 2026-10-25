/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX B2: per-user ticket attachment limits and the orphan list for the daily cleanup (0391).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BUCKET = 'ticket-attachments';
const MB = 1024 * 1024;
export async function verifyTicketLimits(admin, service) {
  const actor = async () => {
    const id = randomUUID();
    await admin.query('INSERT INTO profiles(id) VALUES($1)', [id]);
    return id;
  };
  const begin = (a, bytes) => bytes === undefined
    ? service.query('SELECT ticket_upload_begin($1,$2) v', [a, randomUUID()])
    : service.query('SELECT ticket_upload_begin($1,$2,$3) v', [a, randomUUID(), bytes]);
  const stored = (a, { age = '2 hours', size = 1000, name } = {}) => admin.query(
    `INSERT INTO storage.objects(bucket_id,name,metadata,created_at) VALUES($1,$2,$3,now()-$4::interval) RETURNING name`,
    [BUCKET, name ?? `${a}/${randomUUID()}.png`, { size }, age]).then(r => r.rows[0].name);
  const refused = (fn, code) => assert.rejects(fn, e => e.message.includes(code));

  // Size is validated; the two-argument call of the deployed code still works (declares the 5 MB maximum).
  const a = await actor();
  await refused(() => begin(a, 0), 'UPLOAD_INVALID');
  await refused(() => begin(a, 5 * MB + 1), 'UPLOAD_INVALID');
  assert.equal((await begin(a)).rows[0].v.admitted, true);
  assert.equal((await admin.query('SELECT declared_bytes::int n FROM ticket_upload_intents WHERE profile_id=$1', [a])).rows[0].n, 5 * MB);

  // Count: stored objects of the last 24 hours plus open intents; older objects and other users do not count.
  const b = await actor(); const other = await actor();
  for (let i = 0; i < 19; i++) await stored(b);
  await stored(b, { age: '25 hours' });
  for (let i = 0; i < 5; i++) await stored(other);
  assert.equal((await begin(b, 1)).rows[0].v.admitted, true);
  await refused(() => begin(b, 1), 'UPLOAD_DAILY_COUNT');
  assert.equal((await begin(other, 1)).rows[0].v.admitted, true);

  // Bytes: 50 MB in 24 hours, counting recorded object sizes and declared in-flight sizes.
  const c = await actor();
  await stored(c, { size: 45 * MB });
  await begin(c, 4 * MB);
  await refused(() => begin(c, MB + 1), 'UPLOAD_DAILY_BYTES');
  assert.equal((await begin(c, MB)).rows[0].v.admitted, true);

  // Burst: at most 10 in any minute.
  const d = await actor();
  for (let i = 0; i < 10; i++) await begin(d, 1);
  await refused(() => begin(d, 1), 'UPLOAD_RATE_LIMITED');
  await admin.query("UPDATE ticket_upload_intents SET admitted_at=admitted_at-interval '2 minutes' WHERE profile_id=$1", [d]);
  assert.equal((await begin(d, 1)).rows[0].v.admitted, true);

  // A closed account is still refused first.
  await admin.query("UPDATE profiles SET status='disabled' WHERE id=$1", [d]);
  await refused(() => begin(d, 1), 'UPLOAD_ACCOUNT_CLOSED');

  // Orphans: older than 24 hours, not on any ticket or reply, no open intent, no erasure in progress.
  const e = await actor();
  const orphan = await stored(e, { age: '30 hours' });
  const recent = await stored(e, { age: '2 hours' });
  const onTicket = await stored(e, { age: '30 hours' });
  const onReply = await stored(e, { age: '30 hours' });
  const live = randomUUID();
  await service.query('SELECT ticket_upload_begin($1,$2,1)', [e, live]);
  const intent = await stored(e, { age: '30 hours', name: `${e}/${live}.png` });
  const ticket = (await admin.query(`INSERT INTO tickets(user_id,title,description,category,attachments)
    VALUES($1,'t','d','other',$2) RETURNING id`, [e, JSON.stringify([onTicket])])).rows[0].id;
  await admin.query(`INSERT INTO ticket_replies(ticket_id,user_id,content,is_admin,attachments)
    VALUES($1,$2,'r',true,$3)`, [ticket, e, JSON.stringify([onReply])]);
  const f = await actor();
  const erasing = await stored(f, { age: '30 hours' });
  await admin.query(`INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at)
    VALUES($1,$2,$3,clock_timestamp())`, [f, randomUUID(), randomUUID()]);
  const listed = (await service.query('SELECT ticket_attachment_orphans(1000) v')).rows[0].v;
  assert.ok(listed.includes(orphan));
  for (const kept of [recent, onTicket, onReply, intent, erasing]) assert.ok(!listed.includes(kept), kept);
  assert.equal((await service.query('SELECT cardinality(ticket_attachment_orphans(1)) n')).rows[0].n, 1);

  // Privileges: service role only.
  await service.query('SET ROLE authenticated');
  await refused(() => service.query('SELECT ticket_attachment_orphans(1)'), 'permission denied');
  await refused(() => begin(a, 1), 'permission denied');
  await service.query('SET ROLE service_role');
  console.log('PASS: ticket upload limits (size, legacy call, 20/day, 50MB/day, 10/minute, closed account)'
    + ' and orphan list (age, ticket/reply references, open intent, erasure, limit, privileges)');
}
