/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ rows: [] as unknown[], frozen: false, lost: false, error: false }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ paymentDisputes: { invalidate: vi.fn() }, payments: { invalidate: vi.fn() } }),
  paymentDisputes: {
    list: { useQuery: () => ({ data: fixture.rows, isError: fixture.error, isLoading: false }) },
    notice: { useQuery: () => ({ data: { frozen: fixture.frozen, lost: fixture.lost } }) },
    confirmLost: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    evidence: { useQuery: () => ({ data: undefined, isLoading: false, isError: false }) },
    resolveExternal: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    withdraw: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  },
} }));
import { AdminPaymentDisputes, ConfirmLost, WithdrawConfirm, withdrawMessage } from './AdminPaymentDisputes';
import { PaymentDisputeNotice } from '@/components/profile/PaymentDisputeNotice';
beforeEach(() => { fixture.rows = []; fixture.frozen = false; fixture.lost = false; fixture.error = false; });
it('shows the approved neutral notice only while the account has a frozen payment', () => {
  expect(renderToStaticMarkup(<PaymentDisputeNotice />)).toBe('');
  fixture.frozen = true;
  expect(renderToStaticMarkup(<PaymentDisputeNotice />))
    .toContain('这笔付款有支付争议，相关会员权益和积分暂停使用，有疑问请联系客服。');
});
it('keeps a won dispute frozen until explicit admin withdrawal and explains stopped renewal', () => {
  fixture.rows = [{ id: 'internal-id', order_id: 'order-id', amount: 100, currency: 'usd', status: 'won',
    freeze_state: 'frozen', renewal_stop_state: 'confirmed', evidence_due_by: null, source_review_required: false }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已判赢'); expect(html).toContain('冻结中'); expect(html).toContain('已确认停止');
  expect(html).toContain('撤回冻结'); expect(html).not.toContain('确认撤回冻结</button>');
});
it('does not offer withdrawal for an already superseded refund', () => {
  fixture.rows = [{ id: 'internal-id', order_id: 'order-id', amount: 100, currency: 'usd', status: 'needs_response',
    freeze_state: 'superseded', renewal_stop_state: 'not_applicable', evidence_due_by: null, source_review_required: true }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已被退款取代'); expect(html).toContain('积分来源无法核实');
  expect(html).not.toContain('>撤回冻结</button>');
});
it('reports a failed read without presenting it as an empty successful result', () => {
  fixture.error = true;
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('拒付记录暂时无法读取');
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).not.toContain('暂无付款争议');
});

it('offers explicit off-site resolution only for unmatched unresolved records', () => {
  fixture.rows = [{ id: 'unmatched', provider_dispute_id: 'du_unmatched', merchant_namespace: 'acct_fixture', mode: 'test', order_id: null, amount: 100, currency: 'usd', status: 'won',
    freeze_state: 'pending', renewal_stop_state: 'pending' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('已核实站外付款');
  fixture.rows = [{ id: 'resolved', order_id: null, amount: 100, currency: 'usd', status: 'won',
    freeze_state: 'external', renewal_stop_state: 'not_applicable' }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已确认站外付款');expect(html).not.toContain('>已核实站外付款</button>');
});

it('distinguishes equal-amount unmatched disputes by Stripe identity and merchant environment', () => {
  fixture.rows = ['du_first', 'du_second'].map(id => ({ id, provider_dispute_id: id, merchant_namespace: 'acct_fixture', mode: 'test',
    order_id: null, amount: 100, currency: 'usd', status: 'won', freeze_state: 'pending', renewal_stop_state: 'pending' }));
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('du_first');expect(html).toContain('du_second');expect(html).toContain('acct_fixture');expect(html).toContain('测试');
  fixture.rows = [{ id: 'missing-id', order_id: null, amount: 100, currency: 'usd', status: 'won', freeze_state: 'pending' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).not.toContain('>已核实站外付款</button>');
});

const confirmHtml = (status: string) => renderToStaticMarkup(
  <WithdrawConfirm status={status} pending={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
it.each(['won', 'warning_closed'])('withdraws a %s dispute with no extra warning', status => {
  const html = confirmHtml(status);
  expect(html).not.toContain('withdraw-risk'); expect(html).not.toContain('type="checkbox"');
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>确认撤回冻结/);
});
it.each(['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review', 'lost', 'prevented', 'unexpected'])(
  'warns and needs a second confirmation before withdrawing a %s dispute', status => {
    const html = confirmHtml(status);
    expect(html).toContain('withdraw-risk'); expect(html).toContain('钱可能已被银行扣回');
    expect(html).toContain('type="checkbox"'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认撤回冻结/);
  });
it('says a lost dispute is already lost', () => {
  expect(confirmHtml('lost')).toContain('已判输'); expect(confirmHtml('needs_response')).toContain('还没判赢');
});

it('shows the original Waffo dispute provider and requires manual confirmation there', () => {
  fixture.rows = [{id:'waffo-dispute',provider:'waffo',provider_dispute_id:'CBK_original',order_id:'order-id',
    merchant_namespace:'waffo-fixture',mode:'test',amount:100,currency:'usd',status:'under_review',
    freeze_state:'frozen',renewal_stop_state:'not_applicable',evidence_due_by:null,source_review_required:false}];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('Waffo 拒付编号');
  expect(html).not.toContain('Stripe 拒付编号');
  expect(html).toContain('无需续费');
  const confirmation = renderToStaticMarkup(<WithdrawConfirm status="under_review" providerLabel="Waffo" pending={false}
    onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(confirmation).toContain('我已在Waffo核对，仍要撤回');
  expect(confirmation).not.toContain('Stripe');
  expect(confirmation).toMatch(/<button[^>]*disabled=""[^>]*>确认撤回冻结/);
});

it('shows unknown Waffo chargeback amounts as unverified while retaining the source hold', () => {
  fixture.rows = [{id:'unknown-amount',provider:'waffo',provider_dispute_id:'CBK_unknown',order_id:'order-id',
    merchant_namespace:'waffo-fixture',mode:'test',amount:null,currency:'usd',status:'under_review',
    freeze_state:'frozen',renewal_stop_state:'not_applicable',evidence_due_by:null,source_review_required:false}];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('金额待核实');
  expect(html).toContain('冻结中');
  expect(html).not.toContain('0.00 USD');
});

it.each([null,undefined,''])('shows currency %s as unverified instead of assuming USD or crashing', currency => {
  fixture.rows = [{id:'unknown-currency',provider:'waffo',provider_dispute_id:'CBK_unknown',order_id:'order-id',
    merchant_namespace:'waffo-fixture',mode:'test',amount:100,currency,status:'under_review',
    freeze_state:'frozen',renewal_stop_state:'not_applicable',evidence_due_by:null,source_review_required:false}];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('金额待核实'); expect(html).not.toContain('USD');
});
it('shows a known foreign chargeback currency without substituting USD',()=>{
  fixture.rows = [{id:'foreign-currency',provider:'waffo',provider_dispute_id:'CBK_foreign',order_id:'order-id',
    merchant_namespace:'waffo-fixture',mode:'test',amount:1234,currency:'eur',status:'under_review',
    freeze_state:'frozen',renewal_stop_state:'not_applicable',evidence_due_by:null,source_review_required:false}];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('12.34 EUR'); expect(html).not.toContain('USD');
});

it('offers lost confirmation only for a frozen Stripe loss or a frozen Waffo row, and hides withdrawal once confirmed', () => {
  const base = { id: 'd1', order_id: 'order-id', amount: 100, currency: 'usd', renewal_stop_state: 'confirmed',
    evidence_due_by: null, source_review_required: false, lost_confirmed_at: null };
  fixture.rows = [{ ...base, provider: 'stripe', status: 'under_review', freeze_state: 'frozen' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).not.toContain('确认判输结案');
  fixture.rows = [{ ...base, provider: 'stripe', status: 'lost', freeze_state: 'frozen' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('确认判输结案');
  fixture.rows = [{ ...base, provider: 'waffo', status: 'under_review', freeze_state: 'frozen' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('确认判输结案');
  fixture.rows = [{ ...base, provider: 'stripe', status: 'lost', freeze_state: 'frozen', lost_confirmed_at: '2026-11-14T00:00:00Z' }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已判输结案'); expect(html).not.toContain('>撤回冻结');
  expect(html).not.toContain('>确认判输结案');
  fixture.rows = [{ ...base, provider: 'stripe', status: 'lost', freeze_state: 'withdrawn' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('撤回冻结后被判输');
});
it('explains the final result in the lost confirmation dialog and warns for Waffo', () => {
  const stripe = renderToStaticMarkup(<ConfirmLost provider="stripe" pending={false} onConfirm={() => {}} onCancel={() => {}} />);
  expect(stripe).toContain('不会再多扣'); expect(stripe).toContain('不能再撤回冻结'); expect(stripe).not.toContain('Waffo 后台');
  expect(renderToStaticMarkup(<ConfirmLost provider="waffo" pending={false} onConfirm={() => {}} onCancel={() => {}} />))
    .toContain('请先在 Waffo 后台核实');
});
it('tells the user a lost dispute is closed, separately from a paused one', () => {
  fixture.lost = true;
  const html = renderToStaticMarkup(<PaymentDisputeNotice />);
  expect(html).toContain('支付争议已结案'); expect(html).not.toContain('暂停使用');
});

it('reports restored credits, the monthly backfill and the resubscribe email after a withdrawal', () => {
  const sent = withdrawMessage({ restored: 100, backfilled: 300, email: 'sent' });
  expect(sent).toContain('恢复 100 积分'); expect(sent).toContain('按月积分 300'); expect(sent).toContain('已给用户发');
  expect(withdrawMessage({ restored: 0, backfilled: 0, email: 'failed' })).toContain('请在付款提醒页重发');
  expect(withdrawMessage({ restored: 0, email: 'not_won' })).toContain('不是判赢');
  expect(withdrawMessage({ restored: 0, duplicate: true })).toContain('之前已经撤回过');
});

it('offers dispute evidence only for a matched order and writes it in plain English without IP or device data', async () => {
  fixture.rows = [{ id: 'd1', order_id: 'order-id', provider: 'stripe', amount: 100, currency: 'usd', status: 'needs_response',
    freeze_state: 'frozen', renewal_stop_state: 'confirmed' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('申诉材料');
  fixture.rows = [{ id: 'd2', order_id: null, provider: 'stripe', amount: 100, currency: 'usd', status: 'needs_response',
    freeze_state: 'pending', renewal_stop_state: 'pending' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).not.toContain('>申诉材料</button>');
  const { evidenceText } = await import('./DisputeEvidencePanel');
  const text = evidenceText({
    dispute: { providerDisputeId: 'du_1', provider: 'stripe', amount: 2900, currency: 'usd', reason: 'fraudulent', status: 'needs_response',
      openedAt: '2026-11-10T00:00:00Z', evidenceDueBy: '2026-11-20T00:00:00Z' },
    order: { id: 'order-1', itemType: 'membership_plan', membershipLevel: 'gold', billingCycle: 'monthly', amountTotal: 2900, currency: 'usd',
      paymentMethod: 'card_cn', paidAt: '2026-11-01T00:00:00Z', deliveredAt: '2026-11-01T00:00:05Z', entitlementStart: '2026-11-01T00:00:00Z',
      entitlementEnd: '2026-12-01T00:00:00Z', credits: 8970, termsVersion: 'terms-v3', termsAcceptedAt: '2026-11-01T00:00:00Z', autoRenew: true },
    customer: { email: 'buyer@example.test', accountCreatedAt: '2026-10-01T00:00:00Z' },
    usage: { spendCount: 2, creditsSpent: 100, firstUseAt: '2026-11-02T00:00:00Z', lastUseAt: '2026-11-05T00:00:00Z' },
  });
  expect(text).toContain('29.00 USD'); expect(text).toContain('version terms-v3'); expect(text).toContain('2 paid AI actions, 100 credits used');
  expect(text).toContain('gold membership (monthly, auto-renewing)'); expect(text).not.toMatch(/\bIP\b|device/i);
});
