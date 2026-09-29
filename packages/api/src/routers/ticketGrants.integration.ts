/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { ticketRouter, TICKET_COLUMNS, TICKET_REPLY_COLUMNS } from './ticket';
import { adminRouter } from './admin';
import { TicketAutoCloseService } from '../services/ticketAutoClose';

const origin = process.env.B02_LOCAL_REST!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw new Error('B02 isolated runner required');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000003';
const nativeFetch = globalThis.fetch;
// PostgREST is mounted at / in this small fixture, without a Supabase gateway.
const localFetch: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== origin) throw new Error('Non-local request forbidden');
  target.pathname = target.pathname.replace(/^\/rest\/v1/, '');
  return nativeFetch(target, init);
};
const client = (key: string) => createClient(origin, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});
const service = client(process.env.B02_SERVICE_JWT!);
const context = (id: string, token: string) => {
  const userClient = client(token);
  return {
    headers: new Headers(), user: { id, app_metadata: { provider: 'email' }, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email', supabase: userClient, supabaseAuth: userClient,
    supabasePublic: userClient, supabaseAdmin: service, hasSupabaseAdminPrivileges: true,
  } as any;
};

it('B02: actual ticket routers work with column ACLs and cannot access another user', async () => {
  const ownContext = context(owner, process.env.B02_OWNER_JWT!);
  const own = ticketRouter.createCaller(ownContext);
  const stranger = ticketRouter.createCaller(context(other, process.env.B02_OTHER_JWT!));
  const management = adminRouter.createCaller(context(admin, process.env.B02_ADMIN_JWT!));
  const created = await own.createTicket({ title: 'fixture', description: 'fixture', attachments: [] });
  expect(created.user_id).toBe(owner);
  expect(created.status).toBe('open');
  expect(Object.keys(created).sort()).toEqual(TICKET_COLUMNS.split(',').sort());
  const reply = await own.replyToTicket({ ticketId: created.id, content: 'fixture' });
  expect(reply.is_admin_reply).toBe(false);
  expect((await own.getTicketById({ ticketId: created.id })).replies.map((x: any) => x.id)).toContain(reply.id);
  expect((await own.getTickets()).map((x: any) => x.id)).toContain(created.id);
  expect((await stranger.getTickets()).map((x: any) => x.id)).not.toContain(created.id);
  await expect(stranger.getTicketById({ ticketId: created.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(stranger.replyToTicket({ ticketId: created.id, content: 'fixture' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(stranger.closeTicket({ ticketId: created.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(adminRouter.createCaller(ownContext).getAllTickets({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(ticketRouter.createCaller({ ...ownContext, user: null }).getTickets()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(own.createTicket({ title: 'fixture', description: 'fixture', attachments: [`${other}/fixture.png`] }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  const managed = await management.getAllTickets({});
  expect(managed.tickets.map((x: any) => x.id)).toContain(created.id);
  const adminReply = await management.replyToTicket({ ticketId: created.id, content: 'fixture' });
  expect(adminReply.is_admin).toBe('true');
  expect((await management.updateTicketStatus({ ticketId: created.id, status: 'in_progress' })).status).toBe('in_progress');
  const rawReplies = await ownContext.supabase.from('ticket_replies').select(TICKET_REPLY_COLUMNS).eq('ticket_id', created.id);
  expect(rawReplies.error).toBeNull();
  expect(rawReplies.data.map((x: any) => x.id)).toContain(adminReply.id);
  expect(await own.closeTicket({ ticketId: created.id })).toEqual({ success: true });
  expect((await own.getTicketById({ ticketId: created.id })).status).toBe('closed');
});

it('B02: actual auto-close service can read replies, update ticket and insert a system reply', async () => {
  const own = ticketRouter.createCaller(context(owner, process.env.B02_OWNER_JWT!));
  const management = adminRouter.createCaller(context(admin, process.env.B02_ADMIN_JWT!));
  const created = await own.createTicket({ title: 'fixture', description: 'fixture', attachments: [] });
  await management.replyToTicket({ ticketId: created.id, content: 'fixture' });
  const result = await new TicketAutoCloseService({
    supabase: service, now: new Date(Date.now() + 49 * 60 * 60 * 1000),
  }).run();
  expect(result.decisions.map(x => x.ticketId)).toContain(created.id);
  const ticket = await own.getTicketById({ ticketId: created.id });
  expect(ticket.status).toBe('closed');
  expect(ticket.replies.filter((x: any) => x.is_admin_reply)).toHaveLength(2);
});
