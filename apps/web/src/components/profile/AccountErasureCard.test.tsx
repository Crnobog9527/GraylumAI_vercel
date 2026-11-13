import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountErasurePreview } from '@/lib/account-erasure';

const state = vi.hoisted(() => ({ erasure: {} as Record<string, unknown> }));
const pass = vi.hoisted(() => ({ children }: { children?: unknown }) => children as never);
vi.mock('@/components/ui/dialog', () => ({
  Dialog: pass, DialogContent: pass, DialogDescription: pass, DialogFooter: pass, DialogHeader: pass, DialogTitle: pass,
}));
vi.mock('@/hooks/use-account-erasure', () => ({ useAccountErasure: () => state.erasure }));

import { AccountErasureCard } from './AccountErasureCard';

const facts: AccountErasurePreview = {
  credits: 10, subscriptionRenewing: false, renewalChannels: [], subscriptionActiveUntil: null,
  pendingPayments: 0, runsInFlight: 0, closed: false,
};
function render(preview: AccountErasurePreview | undefined, extra: Record<string, unknown> = {}) {
  state.erasure = { open: true, step: 'impact', busy: false, error: null, preview,
    previewLoading: !preview, previewFailed: false, setOpen: vi.fn(), setStep: vi.fn(), openPortal: vi.fn(), ...extra };
  return renderToStaticMarkup(createElement(AccountErasureCard, { user: { email: 'fixture@example.test' } }));
}

describe('AccountErasureCard impact step', () => {
  beforeEach(() => { state.erasure = {}; });

  it('shows only a loading state, never "继续", before the preview arrives', () => {
    const html = render(undefined);
    expect(html).toContain('正在读取注销影响');
    expect(html).not.toContain('继续');
    expect(html).not.toContain('管理订阅 / 取消续费');
  });

  it('offers "继续" only once the preview says nothing renews', () => {
    const html = render(facts);
    expect(html).toContain('继续');
    expect(html).not.toContain('正在读取注销影响');
  });

  it('blocks with the portal entry and no "继续" while a Stripe subscription renews', () => {
    const html = render({ ...facts, subscriptionRenewing: true, renewalChannels: ['stripe_portal'] });
    expect(html).toContain('管理订阅 / 取消续费');
    expect(html).not.toContain('>继续<');
  });

  it('blocks with the refund line and no "继续" while a refund request is being handled', () => {
    const html = render({ ...facts, refundRequestOpen: true });
    expect(html).toContain('你有一笔退款申请在处理中，处理完成后才能注销。');
    expect(html).not.toContain('>继续<');
    expect(html).not.toContain('管理订阅 / 取消续费');
  });

  it('offers "继续" when the refund field is absent (before migration 0512) or false', () => {
    expect(render({ ...facts, refundRequestOpen: false })).toContain('>继续<');
    expect(render({ ...facts })).toContain('>继续<');
  });

  it('shows neither "继续" nor a spinner button when the preview failed', () => {
    const html = render(undefined, { previewLoading: false, previewFailed: true });
    expect(html).toContain('暂时无法读取注销影响');
    expect(html).not.toContain('继续');
    expect(html).not.toContain('正在读取注销影响');
  });
});

describe('AccountErasureCard verify step by sign-in method (deep review 11-11 item 3)', () => {
  const verify = (auth_provider: string) => {
    state.erasure = { open: true, step: 'verify', busy: false, error: null, preview: facts, previewLoading: false,
      previewFailed: false, setOpen: vi.fn(), setStep: vi.fn(), openPortal: vi.fn() };
    return renderToStaticMarkup(createElement(AccountErasureCard, { user: { id: 'u', email: 'fixture@example.test', auth_provider } }));
  };

  it('sends a Google account to Google, never to an email code it cannot receive', () => {
    const html = verify('google');
    expect(html).toContain('用 Google 重新验证');
    expect(html).not.toContain('邮箱验证码');
    expect(html).not.toContain('发送验证码');
    expect(html).not.toContain('>验证身份<');
  });

  it('keeps the password for email accounts and the SMS code for phone accounts', () => {
    const email = verify('email');
    expect(email).toContain('当前密码');
    expect(email).not.toContain('用 Google 重新验证');
    const phone = verify('phone');
    expect(phone).toContain('短信验证码');
    expect(phone).toContain('发送验证码');
    expect(phone).not.toContain('用 Google 重新验证');
  });
});
