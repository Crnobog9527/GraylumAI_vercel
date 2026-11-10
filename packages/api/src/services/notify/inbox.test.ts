import { describe, expect, it, vi } from 'vitest';
import { readPaymentNoticeInbox } from './inbox';

vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const ID = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-000000000001';

describe('readPaymentNoticeInbox (PHONE-OTP in-app reminders)', () => {
  it('reads the skipped reminders of the user and renders their Chinese lines, without the footer', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: ID, kind: 'wallet_plan_expiry', createdAt: '2026-11-08T00:00:00Z',
      params: { endDate: '2026-11-15T00:00:00Z', deadline: null, plan: 'pro', stage: '-7d' } }], error: null }));
    const notices = await readPaymentNoticeInbox({ rpc } as never, USER);
    expect(rpc).toHaveBeenCalledWith('payment_notice_inbox', { p_user_id: USER });
    expect(notices).toEqual([{ id: ID, kind: 'wallet_plan_expiry', title: '年付会员到期提醒', createdAt: '2026-11-08T00:00:00Z',
      lines: [expect.stringContaining('你的 Pro 会员将于 2026-11-15 00:00:00 UTC 到期')] }]);
  });

  it('shows nothing (never throws) when the read fails or a row does not render', async () => {
    expect(await readPaymentNoticeInbox({ rpc: async () => ({ data: null, error: { code: '42501' } }) } as never, USER)).toEqual([]);
    const bad = { rpc: async () => ({ data: [{ id: ID, kind: 'wallet_plan_expiry', params: {}, createdAt: 'x' }], error: null }) };
    expect(await readPaymentNoticeInbox(bad as never, USER)).toEqual([]);
  });
});
