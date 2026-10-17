/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { RESEND_EMAILS_URL, resendTransport, type NoticeMail } from './resend';

const mail: NoticeMail = { idempotencyKey: '00000000-0000-4000-8000-000000000001', from: 'Graylum AI <no-reply@graylum.com>',
  to: 'tester@example.test', replyTo: null, subject: 's', text: 't', html: '<p>t</p>' };
const reply = (status: number, body?: unknown) => vi.fn(async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status }));

it('posts to Resend with the idempotency key and returns the provider id', async () => {
  const fetchImpl = reply(200, { id: 'msg_123' });
  expect(await resendTransport(fetchImpl as never)('re_fake', mail)).toEqual({ kind: 'sent', providerMessageId: 'msg_123' });
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(RESEND_EMAILS_URL);
  expect(init.headers).toMatchObject({ Authorization: 'Bearer re_fake', 'Idempotency-Key': mail.idempotencyKey });
  expect(JSON.parse(init.body as string)).toEqual({ from: mail.from, to: [mail.to], subject: 's', text: 't', html: '<p>t</p>' });
  await resendTransport(reply(200, { id: 'm' }) as never)('re_fake', { ...mail, replyTo: 'support@example.test' });
});

it.each([
  [reply(200, {}), { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_NO_ID' }],
  [reply(500, { name: 'internal_server_error' }), { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_500' }],
  [reply(409, { name: 'concurrent_idempotent_requests' }), { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_IN_FLIGHT' }],
  [reply(409, { name: 'invalid_idempotent_request' }), { kind: 'conflict', code: 'PAYMENT_NOTICE_PROVIDER_IDEMPOTENCY_CONFLICT' }],
  [reply(422, { name: 'validation_error', message: 'contains tester@example.test' }),
    { kind: 'failed', code: 'PAYMENT_NOTICE_PROVIDER_422_VALIDATION_ERROR' }],
  [reply(429), { kind: 'failed', code: 'PAYMENT_NOTICE_PROVIDER_429' }],
  [vi.fn(async () => { throw new Error('socket hang up'); }), { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_UNREACHABLE' }],
])('classifies provider answers (%#)', async (fetchImpl, expected) => {
  expect(await resendTransport(fetchImpl as never)('re_fake', mail)).toEqual(expected);
});
