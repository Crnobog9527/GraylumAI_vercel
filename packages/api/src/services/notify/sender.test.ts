/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import type { NoticeConfigResult } from './config';
import type { NoticeMail, NoticeTransportResult } from './resend';
import { PaymentNoticeError, sendPaymentNotice, type SendNoticeDeps } from './sender';
import { noticeLayout, type PaymentNoticeTemplates } from './templates';
import { PAYMENT_NOTICE_TEMPLATES } from './registry';

const ID = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const EMAIL = 'tester@example.test';
const BODY_CANARY = 'NOTICEBODYCANARY';
const templates: PaymentNoticeTemplates = {
  wallet_founder_expiry: { version: 'v1', render: p => noticeLayout('到期提醒', [`${BODY_CANARY} ${p.endDate}`]) },
};
const config: NoticeConfigResult = { ok: true, config: {
  apiKey: 're_fake_key_0000', from: 'Graylum AI <no-reply@graylum.com>', replyTo: 'support@example.test',
  allowedRecipients: new Set([EMAIL]),
} };

type Claim = { decision: string; attempt?: number; reason?: string };
function harness(options: { email?: string | null; erasing?: boolean; claims?: Claim[]; attemptsAfterFail?: number;
  kind?: string; templateParams?: Record<string, string | number | boolean | null> } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const claims = [...(options.claims ?? [{ decision: 'send', attempt: 1 }])];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (fn === 'payment_notice_prepare') {
        return { data: { id: ID, userId: USER, kind: options.kind ?? 'wallet_founder_expiry', sourceRef: 'order-1', dueKey: '2027-03-01:-7d',
          templateParams: options.templateParams ?? { endDate: '2027-03-01' }, state: 'pending', attempts: 0,
          email: options.email === undefined ? EMAIL : options.email, erasing: options.erasing ?? false }, error: null };
      }
      if (fn === 'payment_notice_claim') return { data: claims.shift() ?? { decision: 'done' }, error: null };
      if (fn === 'payment_notice_finish') {
        return { data: { state: args.p_outcome, attempts: options.attemptsAfterFail ?? args.p_attempt }, error: null };
      }
      if (fn === 'payment_notice_hold') return { data: { held: true, state: args.p_state }, error: null };
      throw new Error(fn);
    },
  };
  return { db: db as never, calls, of: (fn: string) => calls.filter(c => c[0] === fn).map(c => c[1]) };
}
function transport(results: NoticeTransportResult[]) {
  const mails: NoticeMail[] = [];
  const fn = vi.fn(async (_key: string, mail: NoticeMail) => { mails.push(mail); return results.shift()!; });
  return { fn, mails };
}
const deps = (extra: Partial<SendNoticeDeps> = {}): SendNoticeDeps =>
  ({ templates, config, sleep: async () => {}, now: () => 0, ...extra });

afterEach(() => vi.restoreAllMocks());

it('sends once with the notice id as idempotency key and records the provider id', async () => {
  const h = harness();
  const t = transport([{ kind: 'sent', providerMessageId: 'msg_1' }]);
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn }))).toEqual({ outcome: 'sent' });
  expect(t.mails).toHaveLength(1);
  expect(t.mails[0]).toMatchObject({ idempotencyKey: ID, to: EMAIL, from: 'Graylum AI <no-reply@graylum.com>',
    replyTo: 'support@example.test', subject: '到期提醒' });
  expect(t.mails[0]!.text).toContain('这是关于你的订单的通知');
  expect(h.of('payment_notice_claim')[0]).toMatchObject({ p_id: ID, p_template_version: 'v1', p_actor: null });
  expect(h.of('payment_notice_claim')[0]!.p_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(h.of('payment_notice_finish')).toEqual([{ p_id: ID, p_attempt: 1, p_outcome: 'sent',
    p_provider_message_id: 'msg_1', p_error_code: null }]);
});

it('allows an admin to resend an existing card renewal row with its retained template', async () => {
  const h = harness({ kind: 'card_renewal_upcoming', templateParams: {
    endDate: '2027-03-01T04:00:00+00:00', amount: '496.00', plan: 'gold', managed: true,
  } });
  const t = transport([{ kind: 'sent', providerMessageId: 'msg_legacy_card' }]);
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn, templates: PAYMENT_NOTICE_TEMPLATES, actor: ACTOR })))
    .toEqual({ outcome: 'sent' });
  expect(t.mails).toHaveLength(1);
  expect(t.mails[0]!.text).toContain('Your annual subscription is due to renew');
  expect(h.of('payment_notice_claim')[0]).toMatchObject({ p_id: ID, p_actor: ACTOR, p_template_version: 'pay-n2-v1' });
});

it('without a configured key nothing is sent and the row stays pending with the reason recorded', async () => {
  const h = harness();
  const t = transport([]);
  const result = await sendPaymentNotice(h.db, ID, deps({ transport: t.fn,
    config: { ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' } }));
  expect(result).toEqual({ outcome: 'held', code: 'PAYMENT_NOTICE_NOT_CONFIGURED' });
  expect(t.fn).not.toHaveBeenCalled();
  expect(h.of('payment_notice_claim')).toHaveLength(0);
  expect(h.of('payment_notice_hold')).toEqual([{ p_id: ID, p_state: 'pending', p_code: 'PAYMENT_NOTICE_NOT_CONFIGURED' }]);
});

it.each([
  [{ email: null }, 'PAYMENT_NOTICE_NO_RECIPIENT'],
  [{ email: 'someone-real@example.test' }, 'PAYMENT_NOTICE_RECIPIENT_NOT_ALLOWED'],
  [{ erasing: true }, 'PAYMENT_NOTICE_ACCOUNT_ERASURE'],
])('skips without contacting the provider (%o)', async (options, code) => {
  const h = harness(options);
  const t = transport([]);
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn }))).toEqual({ outcome: 'skipped', code });
  expect(t.fn).not.toHaveBeenCalled();
  expect(h.of('payment_notice_hold')).toEqual([{ p_id: ID, p_state: 'skipped', p_code: code }]);
});

it('keeps a notice without a template pending and asks for attention', async () => {
  const h = harness();
  const result = await sendPaymentNotice(h.db, ID, deps({ templates: {} }));
  expect(result).toMatchObject({ outcome: 'held', attention: 'PAYMENT_NOTICE_TEMPLATE_MISSING' });
  expect(h.of('payment_notice_claim')).toHaveLength(0);
});

it('an explicit refusal is recorded as failed; the third one asks for attention', async () => {
  const h = harness({ claims: [{ decision: 'send', attempt: 3 }], attemptsAfterFail: 3 });
  const t = transport([{ kind: 'failed', code: 'PAYMENT_NOTICE_PROVIDER_422_VALIDATION_ERROR' }]);
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn }))).toEqual({ outcome: 'failed',
    code: 'PAYMENT_NOTICE_PROVIDER_422_VALIDATION_ERROR', attention: 'PAYMENT_NOTICE_RETRIES_EXHAUSTED' });
  const once = harness();
  const t1 = transport([{ kind: 'failed', code: 'PAYMENT_NOTICE_PROVIDER_429' }]);
  expect((await sendPaymentNotice(once.db, ID, deps({ transport: t1.fn }))).attention).toBeUndefined();
});

it('retries an uncertain result in the same run with the same key and the same digest', async () => {
  const h = harness({ claims: [{ decision: 'send', attempt: 1 }, { decision: 'send', attempt: 2 }] });
  const t = transport([{ kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_UNREACHABLE' },
    { kind: 'sent', providerMessageId: 'msg_2' }]);
  const sleep = vi.fn(async () => {});
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn, sleep }))).toEqual({ outcome: 'sent' });
  expect(sleep).toHaveBeenCalledWith(5_000);
  expect(t.mails.map(m => m.idempotencyKey)).toEqual([ID, ID]);
  expect(t.mails[0]).toEqual(t.mails[1]);
  const [first, second] = h.of('payment_notice_claim');
  expect(second!.p_digest).toBe(first!.p_digest);
  expect(h.of('payment_notice_finish').map(f => f.p_outcome)).toEqual(['unknown', 'sent']);
});

it('still uncertain after 5 s and 15 s goes to manual review with an alert', async () => {
  const h = harness({ claims: [1, 2, 3].map(attempt => ({ decision: 'send', attempt })) });
  const unknown: NoticeTransportResult = { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_503' };
  const t = transport([unknown, unknown, unknown]);
  const sleep = vi.fn(async () => {});
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn, sleep }))).toEqual({ outcome: 'manual',
    code: 'PAYMENT_NOTICE_PROVIDER_503', attention: 'PAYMENT_NOTICE_UNKNOWN_UNRESOLVED' });
  expect(sleep.mock.calls).toEqual([[5_000], [15_000]]);
  expect(h.of('payment_notice_finish').map(f => f.p_outcome)).toEqual(['unknown', 'unknown', 'unresolved']);
});

it('does not start a same-run retry that would overrun the job deadline', async () => {
  const h = harness();
  const t = transport([{ kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_UNREACHABLE' }]);
  const sleep = vi.fn(async () => {});
  const result = await sendPaymentNotice(h.db, ID, deps({ transport: t.fn, sleep, now: () => 50_000, deadline: 60_000 }));
  expect(result.outcome).toBe('manual');
  expect(sleep).not.toHaveBeenCalled();
});

it('a provider idempotency conflict goes straight to manual review', async () => {
  const h = harness();
  const t = transport([{ kind: 'conflict', code: 'PAYMENT_NOTICE_PROVIDER_IDEMPOTENCY_CONFLICT' }]);
  expect((await sendPaymentNotice(h.db, ID, deps({ transport: t.fn }))).outcome).toBe('manual');
  expect(t.fn).toHaveBeenCalledTimes(1);
});

it.each([
  [{ decision: 'manual', reason: 'digest_mismatch' }, { outcome: 'manual', code: 'digest_mismatch',
    attention: 'PAYMENT_NOTICE_DIGEST_MISMATCH' }],
  [{ decision: 'busy' }, { outcome: 'busy' }],
  [{ decision: 'done' }, { outcome: 'done' }],
])('maps a claim that does not send (%o)', async (claim, expected) => {
  const h = harness({ claims: [claim] });
  const t = transport([]);
  expect(await sendPaymentNotice(h.db, ID, deps({ transport: t.fn }))).toEqual(expected);
  expect(t.fn).not.toHaveBeenCalled();
});

it('the digest changes when the recipient changes', async () => {
  const digests: unknown[] = [];
  for (const email of [EMAIL, 'other@example.test']) {
    const h = harness({ email, claims: [{ decision: 'done' }] });
    const cfg: NoticeConfigResult = { ok: true, config: { ...config.config, allowedRecipients: null } };
    await sendPaymentNotice(h.db, ID, deps({ config: cfg }));
    digests.push(h.of('payment_notice_claim')[0]!.p_digest);
  }
  expect(digests[0]).not.toBe(digests[1]);
});

it('an admin resend passes the actor, never retries in-run and refuses when not configured', async () => {
  const h = harness();
  const t = transport([{ kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_503' }]);
  const sleep = vi.fn(async () => {});
  const result = await sendPaymentNotice(h.db, ID, deps({ transport: t.fn, sleep, actor: ACTOR }));
  expect(result.outcome).toBe('manual');
  expect(sleep).not.toHaveBeenCalled();
  expect(h.of('payment_notice_claim')[0]!.p_actor).toBe(ACTOR);
  await expect(sendPaymentNotice(harness().db, ID, deps({ actor: ACTOR,
    config: { ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' } }))).rejects.toThrow(PaymentNoticeError);
});

it('logs codes only: no address, body or key', async () => {
  const lines: string[] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => { lines.push(JSON.stringify(args)); });
  }
  const h = harness({ claims: [1, 2, 3].map(attempt => ({ decision: 'send', attempt })) });
  const t = transport([{ kind: 'unknown', code: 'X' }, { kind: 'failed', code: 'Y' }]);
  await sendPaymentNotice(h.db, ID, deps({ transport: t.fn }));
  await sendPaymentNotice(harness().db, ID, deps({ transport: transport([{ kind: 'sent', providerMessageId: 'm' }]).fn }));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain(BODY_CANARY);
    expect(line).not.toContain('re_fake_key');
  }
});

it('re-reads the recipient between uncertain attempts and goes manual if the email changed', async () => {
  const options = { email: EMAIL, claims: [{ decision: 'send', attempt: 1 }, { decision: 'manual', reason: 'digest_mismatch' }] };
  const h = harness(options);
  const t = transport([{ kind: 'unknown', code: 'X' }]);
  const result = await sendPaymentNotice(h.db, ID, deps({ transport: t.fn,
    sleep: async () => { options.email = 'changed@example.test'; } }));
  expect(result).toMatchObject({ outcome: 'manual', attention: 'PAYMENT_NOTICE_DIGEST_MISMATCH' });
  expect(t.fn).toHaveBeenCalledTimes(1);
  const claims = h.of('payment_notice_claim');
  expect(claims[0]!.p_digest).not.toBe(claims[1]!.p_digest);
});
