/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ rows: [] as unknown[], frozen: false, error: false }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ paymentDisputes: { invalidate: vi.fn() }, payments: { invalidate: vi.fn() } }),
  paymentDisputes: {
    list: { useQuery: () => ({ data: fixture.rows, isError: fixture.error, isLoading: false }) },
    notice: { useQuery: () => ({ data: { frozen: fixture.frozen } }) },
    resolveExternal: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    withdraw: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  },
} }));
import { AdminPaymentDisputes, WithdrawConfirm } from './AdminPaymentDisputes';
import { PaymentDisputeNotice } from '@/components/profile/PaymentDisputeNotice';
beforeEach(() => { fixture.rows = []; fixture.frozen = false; fixture.error = false; });
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
