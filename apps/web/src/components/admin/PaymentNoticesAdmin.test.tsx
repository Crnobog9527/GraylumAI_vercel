/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const trpcState = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown }));
vi.mock('@/trpc/client', () => ({
  trpc: {
    paymentNotices: {
      list: { useQuery: () => ({ data: trpcState.data, error: trpcState.error, refetch: vi.fn() }) },
      resend: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
    },
  },
}));

import { PaymentNoticeRow, PaymentNoticesAdmin } from './PaymentNoticesAdmin';
import { paymentNoticeError, resendOutcomeLabel, stateLabel, type PaymentNoticeItem } from './paymentNoticesView';

const base: PaymentNoticeItem = { id: '00000000-0000-4000-8000-000000000001', kind: 'wallet_founder_expiry', state: 'manual',
  manualReason: 'unknown_unresolved', attempts: 3, lastErrorCode: 'PAYMENT_NOTICE_PROVIDER_503', userEmail: 'u@example.test',
  createdAt: '2026-10-16T00:00:00.000000Z', firstAttemptAt: '2026-10-16T00:00:00.000000Z', resendable: true };
const row = (item: PaymentNoticeItem) => renderToStaticMarkup(createElement(PaymentNoticeRow,
  { item, pending: false, onResend: vi.fn() }));

describe('PaymentNoticeRow', () => {
  it('shows the kind, recipient, state and the same-key resend button only when allowed', () => {
    const markup = row(base);
    expect(markup).toContain('创始会员到期提醒（微信/支付宝）');
    expect(markup).toContain('u@example.test');
    expect(markup).toContain('转人工：发送结果不确定（可能已送达）');
    expect(markup).toContain('用同一编号重新发送');
    expect(row({ ...base, resendable: false, manualReason: 'digest_mismatch' })).not.toContain('用同一编号重新发送');
  });
});

describe('labels', () => {
  it('explains each state in plain words', () => {
    expect(stateLabel({ ...base, manualReason: 'digest_mismatch' })).toContain('邮箱或内容变了');
    expect(stateLabel({ ...base, manualReason: 'unknown_expired' })).toContain('超过 24 小时');
    expect(stateLabel({ ...base, state: 'failed', manualReason: null, attempts: 3 })).toContain('不再自动重试');
    expect(stateLabel({ ...base, state: 'failed', manualReason: null, attempts: 1 })).toContain('下次定时任务会重试');
    expect(paymentNoticeError({ message: 'PAYMENT_NOTICE_NOT_CONFIGURED' }, 'resend')).toContain('Resend 密钥');
    expect(paymentNoticeError({ data: { code: 'FORBIDDEN' } }, 'read')).toBe('当前账号无权操作。');
    expect(resendOutcomeLabel('sent')).toBe('已发送。');
  });
});

describe('PaymentNoticesAdmin', () => {
  it('shows an empty state and a read error', () => {
    trpcState.data = { items: [] };
    expect(renderToStaticMarkup(createElement(PaymentNoticesAdmin))).toContain('目前没有需要处理的提醒邮件');
    trpcState.data = undefined;
    trpcState.error = { message: 'x' };
    expect(renderToStaticMarkup(createElement(PaymentNoticesAdmin))).toContain('暂时无法读取发送记录');
  });
});
