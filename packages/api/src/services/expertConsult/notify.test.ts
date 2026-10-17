/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import { notifyOwnerOfExpertConsult, ownerNotice } from './notify';
import type { NoticeConfigResult } from '../notify/config';

const ticket = '30000000-0000-4000-8000-000000000009';
const ok = (allowed: string[] | null = null): NoticeConfigResult => ({ ok: true, config: {
  apiKey: 'test-key', from: 'Graylum AI <no-reply@graylum.com>', replyTo: null,
  allowedRecipients: allowed ? new Set(allowed) : null } });
function db(mailbox: unknown = 'Owner@Example.test', error: unknown = null) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: mailbox === null ? null : { value: mailbox }, error }) };
  return { rpc: vi.fn(), from: vi.fn(() => q) };
}
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
vi.spyOn(logger, 'info').mockImplementation(() => {});
afterEach(() => warn.mockClear());

it('mails the support mailbox once per ticket, with the ticket id only', async () => {
  const transport = vi.fn(async () => ({ kind: 'sent' as const, providerMessageId: 'm1' }));
  expect(await notifyOwnerOfExpertConsult(db() as never, ticket, { config: ok(), transport })).toBe('sent');
  expect(transport).toHaveBeenCalledExactlyOnceWith('test-key', expect.objectContaining({
    to: 'owner@example.test', from: 'Graylum AI <no-reply@graylum.com>', idempotencyKey: `expert-consult-${ticket}`,
  }));
  const mail = ownerNotice(ticket);
  expect(mail.text).toContain(ticket);
  expect(mail.text).not.toMatch(/联系方式|需求：|wechat/);
  expect(warn).toHaveBeenCalledWith('api', 'expert_consult_requested', { ticketId: ticket });
});

it.each([
  ['no Resend key', { config: { ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' } as NoticeConfigResult }, db(),
    'PAYMENT_NOTICE_NOT_CONFIGURED'],
  ['no support mailbox', { config: ok() }, db(null), 'EXPERT_CONSULT_NOTICE_NO_MAILBOX'],
  ['an invalid mailbox', { config: ok() }, db('not a mailbox'), 'EXPERT_CONSULT_NOTICE_NO_MAILBOX'],
  ['a settings read error', { config: ok() }, db('owner@example.test', { message: 'x' }), 'EXPERT_CONSULT_NOTICE_NO_MAILBOX'],
  ['staging mailbox not on the test list', { config: ok(['qa@example.test']) }, db(), 'EXPERT_CONSULT_NOTICE_RECIPIENT_NOT_ALLOWED'],
])('sends nothing with %s and records why', async (_name, deps, client, code) => {
  const transport = vi.fn();
  expect(await notifyOwnerOfExpertConsult(client as never, ticket, { ...deps, transport })).toBe(code);
  expect(transport).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith('api', 'expert_consult_notice_not_sent', { ticketId: ticket, code });
});

it('a refused, uncertain or throwing provider never fails the request', async () => {
  const refused = vi.fn(async () => ({ kind: 'failed' as const, code: 'PAYMENT_NOTICE_PROVIDER_422' }));
  expect(await notifyOwnerOfExpertConsult(db() as never, ticket, { config: ok(['owner@example.test']), transport: refused }))
    .toBe('PAYMENT_NOTICE_PROVIDER_422');
  const throwing = vi.fn(async () => { throw new Error('boom'); });
  expect(await notifyOwnerOfExpertConsult(db() as never, ticket, { config: ok(), transport: throwing }))
    .toBe('EXPERT_CONSULT_NOTICE_UNAVAILABLE');
});
