/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';

// Exercises the real 0143 migration through local SQL and PostgREST (no mocks).
export async function verifyTicketRepair({ sql, http, denied, owner, other, admin, ticket, otherTicket }) {
  const ticketColumns = 'id,user_id,title,description,category,priority,attachments,status,is_deleted,created_at,updated_at';
  const replyColumns = 'id,ticket_id,user_id,content,is_admin,attachments,created_at';
  const deniedHttp = async (role, sub, path, method, body) => {
    const response = await http(role, sub, path, method, body);
    assert.equal(response.status, role ? 403 : 401);
    assert.equal(response.body.code, '42501');
  };
  const selectTickets = `tickets?select=${ticketColumns},ticket_replies(${replyColumns})`;
  const selectReplies = `ticket_replies?select=${replyColumns}`;
  for (const [sub, id] of [[owner, ticket], [other, otherTicket]]) {
    const list = await http('authenticated', sub, selectTickets);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map(x => x.id), [id]);
    assert.equal(list.body[0].ticket_replies.length, 1);
  }
  // Even an admin JWT stays on the own-row client path; adminProcedure uses service_role.
  assert.deepEqual((await http('authenticated', admin, selectTickets)).body, []);
  for (const table of ['tickets', 'ticket_replies']) {
    await deniedHttp('authenticated', owner, `${table}?select=*`);
    await deniedHttp(null, null, `${table}?select=id`);
    await deniedHttp(null, null, `${table}?select=id`, 'POST', {});
    await deniedHttp(null, null, `${table}?select=id`, 'PATCH', {});
    await deniedHttp(null, null, `${table}?select=id`, 'DELETE');
    for (const role of ['anon', 'authenticated']) {
      denied(role, `TRUNCATE ${table}`);
      denied(role, `DELETE FROM ${table}`);
      for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
        assert.equal(sql(`SELECT has_table_privilege('${role}','${table}','${privilege}')`), 'f');
      }
    }
  }
  // P1/P2 regression: call PostgREST directly, bypassing the tRPC input filters.
  for (const category of ['unexpected', '', 'BUG', '__proto__', 'constructor']) {
    await deniedHttp('authenticated', owner, 'tickets?select=id', 'POST', {
      user_id: owner, title: 'fixture', category,
    });
  }
  const allowedPath = `${owner}/fixture.png`;
  const invalidAttachments = [
    ['https://tracker.example.invalid/image.png'], ['http://tracker.example.invalid/image.png'],
    [`${other}/fixture.png`], [`/${owner}/fixture.png`], [`${owner}/../fixture.png`],
    [`${owner}/folder/../../fixture.png`], [allowedPath, 'https://tracker.example.invalid/image.png'],
    [null], [1], [true], [{}], [[allowedPath]], [''], [' '], null, {}, 'https://tracker.example.invalid/image.png',
  ];
  for (const attachments of invalidAttachments) {
    await deniedHttp('authenticated', owner, 'tickets?select=id', 'POST', {
      user_id: owner, title: 'fixture', attachments,
    });
  }
  for (const category of ['bug', 'feature', 'question', 'account', 'billing', 'other']) {
    const attachments = [allowedPath, `${owner}/folder/fixture.webp`, `${owner}/a..b.png`];
    const accepted = await http('authenticated', owner, 'tickets?select=id,category,attachments', 'POST', {
      user_id: owner, title: 'fixture', category, attachments,
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body[0].category, category);
    assert.deepEqual(accepted.body[0].attachments, attachments);
    sql(`DELETE FROM tickets WHERE id='${accepted.body[0].id}'`);
  }
  console.log('PASS direct-write regression: category allowlist and owned string-array attachments');
  const created = await http('authenticated', owner, `tickets?select=${ticketColumns}`, 'POST', {
    user_id: owner, title: 'fixture', description: 'fixture', category: 'other', attachments: [],
  });
  assert.equal(created.status, 201);
  const id = created.body[0].id;
  assert.equal(created.body[0].status, 'open');
  const reply = await http('authenticated', owner, `${selectReplies}`, 'POST', {
    ticket_id: id, user_id: owner, content: 'fixture',
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.body[0].is_admin, 'false');
  await deniedHttp('authenticated', owner, 'tickets?select=id', 'POST', { user_id: other, title: 'fixture' });
  for (const extra of [{ status: 'closed' }, { priority: 'urgent' }, { is_deleted: 'true' },
    { deleted_at: '2026-01-01' }, { created_at: '2026-01-01' }, { id: otherTicket }]) {
    await deniedHttp('authenticated', owner, 'tickets?select=id', 'POST', { user_id: owner, title: 'fixture', ...extra });
  }
  for (const payload of [
    { ticket_id: otherTicket, user_id: owner }, { ticket_id: id, user_id: other },
    { ticket_id: id, user_id: owner, is_admin: 'true' },
    { ticket_id: id, user_id: owner, attachments: [] },
    { ticket_id: id, user_id: owner, is_deleted: 'true' },
  ]) {
    await deniedHttp('authenticated', owner, 'ticket_replies?select=id', 'POST', { content: 'fixture', ...payload });
  }
  const close = await http('authenticated', owner, `tickets?id=eq.${id}&select=id,status`, 'PATCH', { status: 'closed' });
  assert.equal(close.status, 200);
  assert.equal(close.body[0].status, 'closed');
  for (const status of ['open', 'in_progress']) {
    await deniedHttp('authenticated', owner, `tickets?id=eq.${id}&select=id`, 'PATCH', { status });
  }
  for (const patch of [{ user_id: other }, { title: 'changed' }, { is_deleted: 'true' }]) {
    await deniedHttp('authenticated', owner, `tickets?id=eq.${id}&select=id`, 'PATCH', patch);
  }
  const otherUpdate = await http('authenticated', owner, `tickets?id=eq.${otherTicket}&select=id`, 'PATCH', { status: 'closed' });
  assert.equal(otherUpdate.status, 200);
  assert.deepEqual(otherUpdate.body, []);
  assert.equal(sql(`SELECT status FROM tickets WHERE id='${otherTicket}'`), 'open');
  await deniedHttp('authenticated', owner, 'ticket_replies?select=id', 'PATCH', { content: 'changed' });
  // Deleted replies and all replies belonging to a deleted parent remain invisible.
  sql(`UPDATE ticket_replies SET is_deleted='true' WHERE ticket_id='${ticket}';`);
  assert.deepEqual((await http('authenticated', owner, `${selectReplies}&ticket_id=eq.${ticket}`)).body, []);
  sql(`UPDATE tickets SET is_deleted='true' WHERE id='${id}';`);
  assert.deepEqual((await http('authenticated', owner, `${selectTickets}&id=eq.${id}`)).body, []);
  assert.deepEqual((await http('authenticated', owner, `${selectReplies}&ticket_id=eq.${id}`)).body, []);
  await deniedHttp('authenticated', owner, 'ticket_replies?select=id', 'POST', {
    ticket_id: id, user_id: owner, content: 'fixture',
  });
  const hiddenClose = await http('authenticated', owner, `tickets?id=eq.${id}&select=id`, 'PATCH', { status: 'closed' });
  assert.deepEqual(hiddenClose.body, []);
  // Service writes only the columns required by admin and TicketAutoCloseService.
  const serviceReply = await http('service_role', admin, 'ticket_replies?select=*', 'POST', {
    ticket_id: otherTicket, user_id: admin, content: 'fixture', is_admin: 'true',
  });
  assert.equal(serviceReply.status, 201);
  const serviceClose = await http('service_role', admin, `tickets?id=eq.${otherTicket}&select=*`, 'PATCH', {
    status: 'in_progress', updated_at: new Date().toISOString(),
  });
  assert.equal(serviceClose.status, 200);
  assert.equal(serviceClose.body[0].status, 'in_progress');
  const systemReply = await http('service_role', admin, 'ticket_replies?select=*', 'POST', {
    ticket_id: otherTicket, user_id: null, content: 'fixture', is_admin: 'true',
  });
  assert.equal(systemReply.status, 201);
  await deniedHttp('service_role', admin, 'tickets?select=id', 'PATCH', { title: 'changed' });
  await deniedHttp('service_role', admin, 'ticket_replies?select=id', 'PATCH', { content: 'changed' });
  // Restore the original rows and remove only synthetic rows created by this function.
  sql(`DELETE FROM tickets WHERE id='${id}';
    DELETE FROM ticket_replies WHERE id IN ('${serviceReply.body[0].id}','${systemReply.body[0].id}');
    UPDATE ticket_replies SET is_deleted='false' WHERE ticket_id='${ticket}';
    UPDATE tickets SET status='open' WHERE id='${otherTicket}';`);
  console.log('PASS 0143 SQL/REST: own create/read/reply/close, cross-user and anonymous denial, forgery/soft-delete boundaries, service capabilities');
}
